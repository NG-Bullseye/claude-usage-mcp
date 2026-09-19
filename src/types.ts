// Shapes for the OAuth credentials Claude Code stores locally and the
// api.anthropic.com/api/oauth/usage response. These mirror what Claude Code's
// own `/usage` command reads, verified against the ClaudeCodeUsage extension.

export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
  };
}

// One rate-limit window returned by the usage endpoint.
export interface ClaudeUsageLimit {
  utilization: number; // 0-100 (percent of the window consumed)
  resets_at: string;   // ISO timestamp of the next reset
}

export interface ClaudeApiUsageResponse {
  five_hour?: ClaudeUsageLimit;
  seven_day?: ClaudeUsageLimit;
  seven_day_opus?: ClaudeUsageLimit;
  /** Flat list of every limit, including model-scoped ones. See ClaudeLimitEntry. */
  limits?: ClaudeLimitEntry[] | null;
}

// Canonical keys for the three windows the endpoint exposes.
export type WindowKey = "five_hour" | "seven_day" | "seven_day_opus";

// Friendly aliases accepted by the get_velocity tool.
export type WindowAlias = "5h" | "weekly" | "weekly_opus";

export const ALIAS_TO_KEY: Record<WindowAlias, WindowKey> = {
  "5h": "five_hour",
  weekly: "seven_day",
  weekly_opus: "seven_day_opus",
};

// Nominal length of each window in hours.
export const WINDOW_HOURS: Record<WindowKey, number> = {
  five_hour: 5,
  seven_day: 24 * 7,
  seven_day_opus: 24 * 7,
};

// ---- per-model limits ------------------------------------------------------
//
// The usage endpoint reports the named windows above *and* a flat `limits`
// array. The array is the only place where a **model-scoped** weekly quota
// shows up: `kind: "weekly_scoped"` with `scope.model.display_name` naming the
// model (e.g. "Fable"). The named `seven_day_opus`/`seven_day_sonnet` fields
// exist but come back `null` on plans that scope by the array instead — so a
// consumer that only reads those sees nothing and concludes "no per-model
// quota", which is wrong. Read both, prefer the array.

/** The model a scoped limit applies to; `display_name` is what the UI shows. */
export interface ClaudeLimitScope {
  model?: { id?: string | null; display_name?: string | null } | null;
  surface?: unknown;
}

/** One entry of the flat `limits` array. Percent is already 0-100. */
export interface ClaudeLimitEntry {
  kind?: string | null;
  group?: string | null;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: ClaudeLimitScope | null;
  is_active?: boolean | null;
}


// ---- session transcript / context window -----------------------------------
//
// Claude Code appends one JSON object per line to
// `~/.claude/projects/<slug>/<session-id>.jsonl`. Only a few entry kinds matter
// for context accounting; these shapes cover just those fields, because the
// format carries dozens more we have no business depending on.

/** Token counters of a single API call, as the transcript records them. */
export interface TranscriptUsage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

/** The fields we read from any transcript line. */
export interface TranscriptEntry {
  type?: string | null;
  /** `system` entries use this; `compact_boundary` marks a /compact. */
  subtype?: string | null;
  /** On a `compact_boundary`: `postTokens` is the size of the fresh context. */
  compactMetadata?: { postTokens?: number | null } | null;
  /** True for subagent turns, which run in their own context window. */
  isSidechain?: boolean | null;
  sessionId?: string | null;
  cwd?: string | null;
  timestamp?: string | null;
  /**
   * One API call produces several assistant entries — thinking, text, each
   * tool_use — and every one repeats the same `id` and the same `usage`.
   */
  message?: {
    id?: string | null;
    model?: string | null;
    usage?: TranscriptUsage | null;
  } | null;
  /** `type: "attachment"`; the `model` kind names the model actually in use. */
  attachment?: {
    type?: string | null;
    identity?: { modelId?: string | null } | null;
  } | null;
}

/** Token totals of the live context window. */
export interface ContextTokens {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** What the context bar counts: every counter above, summed. */
  total: number;
}

/**
 * Where `contextWindowSize` came from, least certain last. `default` means the
 * model's window is unknown and the smaller one was assumed — the report says
 * so out loud, because an unflagged assumption is exactly what made the tool
 * overstate a 1M session fivefold.
 */
export type ContextWindowSource =
  | "override"
  | "suffix"
  | "model-table"
  | "observed-prompt"
  | "default";

/** Context-window usage of one Claude Code session. */
export interface ContextReport {
  sessionId: string | null;
  /** Absolute path of the transcript the numbers were read from. */
  transcriptPath: string;
  cwd: string | null;
  /** Model id as Claude Code writes it, `[1m]` suffix included. */
  model: string | null;
  contextWindowSize: number;
  /** How that size was decided. */
  contextWindowSource: ContextWindowSource;
  tokens: ContextTokens;
  /**
   * Growth since the previous main-chain turn; negative right after a compact.
   * Null when it cannot be known — a truncated read whose previous turn fell
   * in the unread middle, where any number would be invented.
   */
  lastTurnTokens: number | null;
  /** 0-100, rounded. */
  utilization: number;
  remainingTokens: number;
  lastMessageAt: string | null;
  /**
   * Timestamp of the last /compact seen. Meaningful only when `truncated` is
   * false: a bounded read can step over a boundary in the middle of a long
   * transcript, and absence would then be indistinguishable from "never".
   */
  compactedAt?: string;
  /**
   * True when only part of the transcript was read, so anything derived from
   * *scanning* it — `compactedAt`, and which model attachment is newest — may
   * be missing evidence from the skipped middle.
   */
  truncated: boolean;
  /**
   * How the transcript was found. `cwd` is the caller's own project folder,
   * `explicit` was asked for by id or path, and `fallback` means the working
   * directory had no project folder and the freshest transcript on the machine
   * was used — which may well belong to an unrelated session.
   */
  sessionMatch: "cwd" | "explicit" | "fallback";
}
