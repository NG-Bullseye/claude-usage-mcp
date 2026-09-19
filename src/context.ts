import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ContextReport,
  ContextTokens,
  TranscriptEntry,
  TranscriptUsage,
} from "./types.js";

// Context-window accounting for the *calling* Claude Code session.
//
// Claude Code hands its status line a ready-made `context_window` payload, but
// an MCP server never sees it. What the server can read is the session
// transcript Claude Code appends to `~/.claude/projects/<slug>/<id>.jsonl`:
// every assistant entry carries the `usage` counters of that API call, which
// is exactly what the context bar is built from.

/** Bytes read from the start of a transcript: enough for the model attachment. */
const HEAD_BYTES = 128 * 1024;
/** Bytes read from the end of a transcript: enough for the recent turns. */
const TAIL_BYTES = 512 * 1024;
/** How many transcripts to try before giving up on a folder. */
const MAX_CANDIDATES = 5;
/** Ceiling on growing the tail before settling for a single usable turn. */
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

/** Context window of a model without the 1M beta, in tokens. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Context window advertised by the `[1m]` model variants. */
const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * Context window of `modelId`, in tokens.
 *
 * Model ids reach us as Claude Code writes them, so the 1M variants keep their
 * `[1m]` suffix (`claude-opus-5[1m]`) and are the only ones we can tell apart.
 * `override` (CLAUDE_CONTEXT_WINDOW) is the escape hatch for a future model
 * whose window we cannot infer; anything non-numeric is ignored rather than
 * turned into a NaN percentage.
 */
export function contextWindowSizeFor(
  modelId: string | undefined,
  opts: { override?: string; observedPrompt?: number } = {},
): number {
  const override = Number(opts.override);
  if (Number.isFinite(override) && override > 0) return override;
  if (modelId?.includes("[1m]")) return LONG_CONTEXT_WINDOW;
  // A prompt cannot exceed the window it was sent to, so a prompt above the
  // default settles the question that the model id cannot: no `message.model`
  // in a real transcript ever carries the `[1m]` suffix, yet prompts of 600k
  // and more are ordinary. Without this the report clamps to "100% used, 0
  // left" on a session with most of a megatoken to spare.
  //
  // The *prompt*, not the prompt plus the reply. Testing the sum would put a
  // discontinuity exactly where it hurts: a session at 97% of 200k would be
  // re-read as 20% of 1M the moment one longer reply carried the sum over the
  // line — turning "nearly full" into "plenty of room" as it filled up.
  if ((opts.observedPrompt ?? 0) > DEFAULT_CONTEXT_WINDOW) return LONG_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

export class ContextUnavailableError extends Error {}

/** Parse one transcript line, or null when it is truncated or not an object. */
function parseEntry(line: string): TranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as TranscriptEntry) : null;
  } catch {
    return null;
  }
}

/** A model id without its variant suffix: `claude-opus-5[1m]` → `claude-opus-5`. */
function baseModelId(modelId: string): string {
  return modelId.replace(/\[[^\]]*\]$/, "");
}

/**
 * Decide which model the last turn actually ran on.
 *
 * Neither source is sufficient alone. `message.model` is recorded by the turn
 * itself, so it is never stale, but it drops the `[1m]` suffix — the one thing
 * that separates a 1M window from a 200k one. The attachment keeps the suffix
 * but is written when a model is *selected*, so on a long transcript, where
 * only the head and tail are read, a switch in the skipped middle leaves the
 * session-start attachment looking current.
 *
 * So the attachment is believed only when it agrees with the turn about which
 * model ran; otherwise it is stale and the turn wins. Getting this wrong is
 * not cosmetic: a session that switched from a `[1m]` model to a 200k one
 * would otherwise be measured against five times the window it has, and
 * reported as comfortable while effectively full.
 */
function resolveModel(attached: string | null, ofTurn: string | null): string | null {
  if (!attached) return ofTurn;
  if (!ofTurn) return attached;
  return baseModelId(attached) === ofTurn ? attached : ofTurn;
}

/**
 * Tokens as a compact boundary reports them: a total with no breakdown, since
 * the boundary records the size of the new context and not how it splits.
 */
function postCompactTokens(total: number): ContextTokens {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, total };
}

/** What was actually sent: the reply is generated, not part of the prompt. */
function promptOf(tokens: ContextTokens): number {
  return tokens.input + tokens.cacheCreation + tokens.cacheRead;
}

function sumUsage(usage: TranscriptUsage): ContextTokens {
  const input = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    input,
    cacheCreation,
    cacheRead,
    output,
    total: input + cacheCreation + cacheRead + output,
  };
}

/**
 * Build a context report from the lines of a session transcript.
 *
 * The live context is whatever the *last main-chain assistant turn* sent: its
 * prompt (`input` + the two cache counters) plus the reply it produced, which
 * the next prompt will carry. Sidechain turns are subagents — they burn their
 * own window, not this one, so counting them would wildly overstate usage.
 *
 * Compaction needs no special handling: the turn after a /compact reports the
 * compacted prompt, so the totals are already post-compact. `lastTurnTokens`
 * does go negative across that boundary, which is the honest reading.
 *
 * @throws ContextUnavailableError when no usable assistant turn is present.
 */
export function parseTranscript(
  lines: string[],
  opts: {
    contextWindowOverride?: string;
    truncated?: boolean;
    sessionMatch?: ContextReport["sessionMatch"];
    /** Index at which the lines become contiguous again after a skipped gap. */
    contiguousFrom?: number;
  } = {},
): Omit<ContextReport, "transcriptPath"> {
  let attachedModel: string | null = null;
  let compactedAt: string | undefined;
  let compactPostTokens: number | null = null;
  let last: { entry: TranscriptEntry; tokens: ContextTokens; index: number } | null = null;
  let lastCallId: string | null = null;
  let previousTotal: number | null = null;

  // Head and tail are stitched together with a gap between them. Turns on
  // opposite sides of it are not consecutive, and diffing them would measure
  // the whole skipped middle and call it one turn.
  const contiguousFrom = opts.contiguousFrom ?? 0;
  const sameRun = (a: number, b: number) => a < contiguousFrom === (b < contiguousFrom);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const entry = parseEntry(line);
    if (!entry || entry.isSidechain) continue;

    if (entry.attachment?.type === "model" && entry.attachment.identity?.modelId) {
      attachedModel = entry.attachment.identity.modelId;
      continue;
    }
    if (entry.subtype === "compact_boundary" && entry.timestamp) {
      compactedAt = entry.timestamp;
      compactPostTokens = entry.compactMetadata?.postTokens ?? null;
      continue;
    }
    if (entry.type !== "assistant") continue;

    const usage = entry.message?.usage;
    if (!usage) continue;

    const tokens = sumUsage(usage);
    // Synthetic entries ("No response requested.") carry an all-zero usage.
    // Taken for the live context they report an empty window on a full session.
    if (tokens.total === 0) continue;

    // One API call, several entries — thinking, text, each tool_use — all
    // repeating the same id and usage. They are one turn, not several, so the
    // previous total only moves when the call changes.
    const callId = entry.message?.id ?? null;
    if (!last || callId === null || callId !== lastCallId) {
      previousTotal = last && sameRun(last.index, index) ? last.tokens.total : null;
    }
    last = { entry, tokens, index };
    lastCallId = callId;
  }

  if (!last) {
    throw new ContextUnavailableError(
      "No assistant turn with token usage found in the transcript.",
    );
  }

  const model = resolveModel(attachedModel, last.entry.message?.model ?? null);
  const lastMessageAt = last.entry.timestamp ?? null;

  // Between running /compact and the next assistant turn, the newest turn on
  // record predates the compaction and describes a context that is gone. The
  // boundary carries the size of the fresh one, so use it — otherwise the tool
  // answers "100% used" to the question "did the compact work?".
  // A boundary is only known to be newer when both carry a timestamp. Without
  // one there is nothing to compare, and the boundary may be days and several
  // compactions old — picked up from the head of a truncated read.
  const tokens =
    compactedAt !== undefined &&
    compactPostTokens !== null &&
    lastMessageAt !== null &&
    compactedAt > lastMessageAt
      ? postCompactTokens(compactPostTokens)
      : last.tokens;

  const total = tokens.total;
  const contextWindowSize = contextWindowSizeFor(model ?? undefined, {
    override: opts.contextWindowOverride,
    observedPrompt: promptOf(last.tokens),
  });

  return {
    sessionId: last.entry.sessionId ?? null,
    cwd: last.entry.cwd ?? null,
    model,
    contextWindowSize,
    tokens,
    // With no previous turn, the growth is the whole total — but only if we
    // actually saw the start of the session. On a truncated read there is an
    // earlier turn we simply did not read, and its cost is unknown, not zero.
    lastTurnTokens:
      previousTotal !== null
        ? total - previousTotal
        : opts.truncated
          ? null
          : total,
    utilization: Math.min(100, Math.round((total / contextWindowSize) * 100)),
    remainingTokens: Math.max(0, contextWindowSize - total),
    lastMessageAt,
    compactedAt,
    truncated: opts.truncated ?? false,
    sessionMatch: opts.sessionMatch ?? "cwd",
  };
}

/**
 * Read the lines of a transcript we need, without loading the whole file.
 *
 * Long sessions produce transcripts of tens of megabytes, and this runs on
 * every tool call, so we read two bounded chunks instead: the head, where the
 * model attachment is written at session start, and the tail, which holds the
 * recent turns. A chunk boundary almost always lands mid-line, so the partial
 * line on each cut side is dropped — a half object would parse as garbage or,
 * worse, as something plausible.
 *
 * @throws ContextUnavailableError when the file cannot be read.
 */
export function readTranscriptLines(
  filePath: string,
  opts: { headBytes?: number; tailBytes?: number } = {},
): { lines: string[]; truncated: boolean; contiguousFrom: number } {
  const headBytes = opts.headBytes ?? HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (e) {
    throw new ContextUnavailableError(
      `Cannot read transcript ${filePath}: ${(e as Error).message}`,
    );
  }

  try {
    const size = fs.fstatSync(fd).size;
    const whole = () => ({
      lines: splitLines(readChunk(fd, 0, size)),
      truncated: false,
      contiguousFrom: 0,
    });
    if (size <= headBytes + tailBytes) return whole();

    // Drop the trailing partial line of the head and the leading one of the tail.
    const head = splitLines(readChunk(fd, 0, headBytes)).slice(0, -1);

    // A fixed tail is not enough. One transcript line can be larger than the
    // whole budget — base64 screenshots and big tool results run past a
    // megabyte — and if such a line is last, the tail holds no complete turn
    // at all. The report would then fall back to a turn from the head, i.e.
    // session start, and be quietly, plausibly wrong. So grow until the tail
    // holds real turns.
    for (let want = tailBytes; ; want *= 4) {
      const from = size - want;
      if (from <= 0) return whole();
      const tail = splitLines(readChunk(fd, from, size - from)).slice(1);
      const turns = countUsableTurns(tail);
      if (turns >= 2 || (turns >= 1 && want >= MAX_TAIL_BYTES)) {
        return { lines: [...head, ...tail], truncated: true, contiguousFrom: head.length };
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Assistant turns in `lines` that carry real token counts. */
function countUsableTurns(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    const entry = parseEntry(line);
    if (!entry || entry.isSidechain || entry.type !== "assistant") continue;
    const usage = entry.message?.usage;
    if (usage && sumUsage(usage).total > 0) n++;
  }
  return n;
}

function readChunk(fd: number, position: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read).toString("utf8");
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * The folder name Claude Code derives from a working directory.
 *
 * It flattens the path by replacing every character that is not alphanumeric
 * with a hyphen, so `C:\Users\dev\Documents` becomes
 * `C--Users-dev-Documents`. Hyphens already in the path survive unchanged,
 * which is why the mapping is not reversible — we only ever go this way.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute paths of every `.jsonl` in `dir`, or nothing when `dir` is absent. */
function transcriptsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function newestFirst(files: string[]): string[] {
  const dated: { file: string; mtimeMs: number }[] = [];
  for (const file of files) {
    try {
      dated.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // A transcript can be rotated away between readdir and stat; skip it.
    }
  }
  return dated.sort((a, b) => b.mtimeMs - a.mtimeMs).map((d) => d.file);
}

/**
 * Locate the transcript of the session that is calling us.
 *
 * An MCP server is told nothing about its session, so this is a heuristic.
 * The server is spawned with the session's working directory, which names the
 * project folder; within it the freshest transcript is the live session, since
 * the turn carrying this very tool call was just appended to it. When the
 * working directory has no folder of its own — the server was started
 * elsewhere, or the session moved — we widen to the freshest transcript of any
 * project. `transcriptPath` and `sessionId` bypass the guessing entirely.
 *
 * @throws ContextUnavailableError when no transcript matches.
 */
export function resolveTranscriptCandidates(
  opts: {
    projectsDir?: string;
    cwd?: string;
    sessionId?: string;
    transcriptPath?: string;
  } = {},
): { paths: string[]; match: ContextReport["sessionMatch"] } {
  if (opts.transcriptPath) return { paths: [opts.transcriptPath], match: "explicit" };

  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const projectDirs = subdirectories(projectsDir);

  if (opts.sessionId) {
    const wanted = `${opts.sessionId}.jsonl`;
    for (const dir of projectDirs) {
      const found = transcriptsIn(dir).find((f) => path.basename(f) === wanted);
      if (found) return { paths: [found], match: "explicit" };
    }
    throw new ContextUnavailableError(
      `No transcript found for session '${opts.sessionId}' under ${projectsDir}.`,
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const own = newestFirst(transcriptsIn(path.join(projectsDir, projectSlug(cwd))));
  if (own.length) return { paths: own.slice(0, MAX_CANDIDATES), match: "cwd" };

  // Nothing for this working directory. The freshest transcript on the machine
  // is a reasonable guess — but it is a guess, and it may belong to a wholly
  // unrelated project, so the caller is told which it got.
  const anywhere = newestFirst(projectDirs.flatMap(transcriptsIn));
  if (anywhere.length) return { paths: anywhere.slice(0, MAX_CANDIDATES), match: "fallback" };

  throw new ContextUnavailableError(
    `No session transcript found under ${projectsDir}.`,
  );
}

/** Where Claude Code keeps session transcripts. */
function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export interface ContextLookupOptions {
  /** Override the transcript root; defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** Override the working directory used to guess the session. */
  cwd?: string;
  /** Read this session instead of guessing. */
  sessionId?: string;
  /** Read this transcript file instead of guessing. */
  transcriptPath?: string;
}

/**
 * Context-window usage of the calling session.
 *
 * @throws ContextUnavailableError when no transcript can be found or read.
 */
export function readContextReport(opts: ContextLookupOptions = {}): ContextReport {
  const { paths, match } = resolveTranscriptCandidates(opts);

  // An idle session started later in the same folder takes the top of the
  // mtime order without ever holding a turn. It is never the caller — the turn
  // that invoked this tool was written before the tool ran — so walk past it
  // rather than failing while the real transcript sits alongside.
  let lastError: unknown;
  for (const transcriptPath of paths) {
    try {
      const { lines, truncated, contiguousFrom } = readTranscriptLines(transcriptPath);
      const parsed = parseTranscript(lines, {
        contextWindowOverride: process.env.CLAUDE_CONTEXT_WINDOW,
        truncated,
        contiguousFrom,
        sessionMatch: match,
      });
      return { ...parsed, transcriptPath };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new ContextUnavailableError("No readable session transcript.");
}

/**
 * Same, but null instead of an error.
 *
 * Callers that only garnish some other answer with the context use this: the
 * transcript layout is Claude Code's, not ours, so a miss here must never take
 * down a report that is otherwise fine.
 */
export function tryReadContextReport(
  opts: ContextLookupOptions & { ownSessionOnly?: boolean } = {},
): ContextReport | null {
  try {
    const report = readContextReport(opts);
    // A caller that appends this to some other answer, unasked, must not
    // quietly describe a stranger's session. Saying nothing is the better miss.
    if (opts.ownSessionOnly && report.sessionMatch === "fallback") return null;
    return report;
  } catch {
    return null;
  }
}

/** Group thousands with spaces — locale-independent, unlike toLocaleString. */
function groupThousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  return sign + Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** The one-line summary shown at the top of a tool result. */
export function formatContextLine(report: ContextReport): string {
  const { utilization, tokens, contextWindowSize, lastTurnTokens } = report;
  const turn =
    lastTurnTokens === null
      ? ""
      : `, last turn ${lastTurnTokens >= 0 ? "+" : ""}${groupThousands(lastTurnTokens)}`;
  const line =
    `context: ${utilization}% used ` +
    `(${groupThousands(tokens.total)} / ${groupThousands(contextWindowSize)} tokens)` +
    turn;
  // Unlabelled, a fallback reads as the caller's own usage. It is not.
  return report.sessionMatch === "fallback"
    ? `${line} — warning: another session (${report.cwd ?? "unknown directory"})`
    : line;
}
