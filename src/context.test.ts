import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ContextUnavailableError,
  contextWindowSizeFor,
  formatContextLine,
  parseTranscript,
  projectSlug,
  readContextReport,
  readTranscriptLines,
  resolveTranscriptCandidates,
  tryReadContextReport,
} from "./context.js";
import { ContextReport } from "./types.js";

test("a model id with the [1m] suffix gets the 1M context window", () => {
  assert.deepEqual(contextWindowSizeFor("claude-opus-5[1m]"), {
    size: 1_000_000,
    source: "suffix",
  });
});

test("an unknown or missing model id falls back to the default window", () => {
  assert.deepEqual(contextWindowSizeFor(undefined), { size: 200_000, source: "default" });
});

test("CLAUDE_CONTEXT_WINDOW overrides the inferred window", () => {
  assert.deepEqual(contextWindowSizeFor("claude-opus-5[1m]", { override: "500000" }), {
    size: 500_000,
    source: "override",
  });
});

test("a non-numeric CLAUDE_CONTEXT_WINDOW is ignored", () => {
  assert.equal(contextWindowSizeFor("claude-mystery-9", { override: "lots" }).size, 200_000);
});

// The id alone decides it whenever we know the family. Claude Code's own
// status line sizes `claude-fable-5-1` against 1 000 000; without this table
// the tool called the same session 49% full when it was at 10%.

test("a known 1M family is recognised from the id, with no suffix needed", () => {
  for (const id of [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-mythos-5-1",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
  ]) {
    assert.deepEqual(
      contextWindowSizeFor(id),
      { size: 1_000_000, source: "model-table" },
      `wrong window for ${id}`,
    );
  }
});

test("Haiku 4.5 is known to be 200k, which is a fact and not a fallback", () => {
  assert.deepEqual(contextWindowSizeFor("claude-haiku-4-5"), {
    size: 200_000,
    source: "model-table",
  });
});

test("an override beats the model table", () => {
  assert.deepEqual(contextWindowSizeFor("claude-fable-5-1", { override: "300000" }), {
    size: 300_000,
    source: "override",
  });
});

test("an unknown family falls back to the default and says so", () => {
  assert.deepEqual(contextWindowSizeFor("claude-mystery-9"), {
    size: 200_000,
    source: "default",
  });
});

test("an unknown family with a large prompt is inferred, not defaulted", () => {
  assert.deepEqual(contextWindowSizeFor("claude-mystery-9", { observedPrompt: 621_497 }), {
    size: 1_000_000,
    source: "observed-prompt",
  });
});

test("the model table beats the arithmetic inference", () => {
  assert.equal(
    contextWindowSizeFor("claude-haiku-4-5", { observedPrompt: 621_497 }).source,
    "model-table",
  );
});

// No model id in a real transcript carries the `[1m]` suffix — `message.model`
// never does — yet prompts well past 200k are common. A prompt that large
// cannot have been sent to a 200k model, so the size itself settles it.

test("a prompt larger than the default window proves a 1M session", () => {
  assert.equal(contextWindowSizeFor("claude-mystery-9", { observedPrompt: 621_497 }).size, 1_000_000);
});

test("a prompt within the default window leaves it at 200k", () => {
  assert.equal(contextWindowSizeFor("claude-mystery-9", { observedPrompt: 150_000 }).size, 200_000);
});

test("an explicit override still wins over the observed size", () => {
  assert.equal(
    contextWindowSizeFor("claude-mystery-9", { override: "300000", observedPrompt: 621_497 }).size,
    300_000,
  );
});

// Only the prompt is unambiguously bounded by the window. Adding the output
// and testing that against 200 000 puts a cliff right in the danger zone: a
// session at 97% of 200k would jump to 20% of 1M the moment a longer reply
// pushed the sum past the line.

test("output tokens do not push a full 200k session into the 1M bracket", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 197_296, output: 2_997, model: "claude-mystery-9" }),
  ]);

  assert.equal(report.contextWindowSize, 200_000);
  assert.equal(report.utilization, 100);
});

// ---- parseTranscript -------------------------------------------------------

/** One assistant entry as Claude Code writes it, with only the fields we read. */
function assistantLine(opts: {
  cacheRead: number;
  output?: number;
  input?: number;
  cacheCreation?: number;
  model?: string;
  messageId?: string;
  isSidechain?: boolean;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.isSidechain ?? false,
    sessionId: "sess-1",
    cwd: "C:\\work\\repo",
    timestamp: opts.timestamp ?? "2026-09-19T10:00:00.000Z",
    message: {
      id: opts.messageId,
      model: opts.model ?? "claude-testmodel-1",
      usage: {
        input_tokens: opts.input ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead,
        output_tokens: opts.output ?? 0,
      },
    },
  });
}

function modelAttachmentLine(modelId: string): string {
  return JSON.stringify({
    type: "attachment",
    attachment: { type: "model", identity: { modelId } },
  });
}

test("the report sums every token counter of the last assistant entry", () => {
  const report = parseTranscript([
    assistantLine({ input: 2, cacheCreation: 3_000, cacheRead: 61_000, output: 800 }),
  ]);

  assert.deepEqual(report.tokens, {
    input: 2,
    cacheCreation: 3_000,
    cacheRead: 61_000,
    output: 800,
    total: 64_802,
  });
});

test("utilization and remaining tokens are derived from the context window", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 50_000 })]);

  assert.equal(report.contextWindowSize, 200_000);
  assert.equal(report.utilization, 25);
  assert.equal(report.remainingTokens, 150_000);
});

test("sidechain entries are ignored: a subagent has its own context window", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 1_000 }),
    assistantLine({ cacheRead: 999_000, isSidechain: true }),
    assistantLine({ cacheRead: 4_000 }),
  ]);

  assert.equal(report.tokens.total, 4_000);
});

test("lastTurnTokens is the growth since the previous main-chain turn", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 1_000 }),
    assistantLine({ cacheRead: 999_000, isSidechain: true }),
    assistantLine({ cacheRead: 4_000 }),
  ]);

  assert.equal(report.lastTurnTokens, 3_000);
});

test("lastTurnTokens equals the total when there is only one turn", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 1_500 })]);

  assert.equal(report.lastTurnTokens, 1_500);
});

test("the model attachment wins over message.model, so the [1m] window is seen", () => {
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 50_000, model: "claude-opus-5" }),
  ]);

  assert.equal(report.model, "claude-opus-5[1m]");
  assert.equal(report.contextWindowSize, 1_000_000);
  assert.equal(report.utilization, 5);
});

test("the latest model attachment wins when the model was switched mid-session", () => {
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 10_000 }),
    modelAttachmentLine("claude-testmodel-1"),
    assistantLine({ cacheRead: 20_000 }),
  ]);

  assert.equal(report.model, "claude-testmodel-1");
  assert.equal(report.contextWindowSize, 200_000);
});

test("message.model is the fallback when no model attachment was recorded", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 10_000, model: "claude-haiku-4-5" })]);

  assert.equal(report.model, "claude-haiku-4-5");
});

test("session id, cwd and the last message timestamp are carried through", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 10_000, timestamp: "2026-09-19T11:22:33.000Z" }),
  ]);

  assert.equal(report.sessionId, "sess-1");
  assert.equal(report.cwd, "C:\\work\\repo");
  assert.equal(report.lastMessageAt, "2026-09-19T11:22:33.000Z");
});

test("the last compact boundary is reported when the session was compacted", () => {
  const boundary = JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-09-19T09:00:00.000Z",
  });
  const report = parseTranscript([
    assistantLine({ cacheRead: 190_000 }),
    boundary,
    assistantLine({ cacheRead: 20_000 }),
  ]);

  assert.equal(report.compactedAt, "2026-09-19T09:00:00.000Z");
});

test("compactedAt is undefined when the session was never compacted", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 10_000 })]);

  assert.equal(report.compactedAt, undefined);
});

test("malformed lines are skipped rather than aborting the report", () => {
  const report = parseTranscript([
    "{ not json",
    "",
    assistantLine({ cacheRead: 10_000 }),
  ]);

  assert.equal(report.tokens.total, 10_000);
});

test("a transcript with no assistant usage raises ContextUnavailableError", () => {
  assert.throws(
    () => parseTranscript([modelAttachmentLine("claude-opus-5[1m]")]),
    ContextUnavailableError,
  );
});

// A model attachment can be stale: it is written when the model is *selected*,
// so a switch recorded in the part of a large transcript we never read leaves
// the session-start attachment as the newest one we can see. Believing it
// silently sizes the window against the wrong model.

test("an attachment naming a different model than the last turn is not believed", () => {
  // The two disagree about the window as well as the name: believing the stale
  // attachment would measure a 200k session against a megatoken.
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 180_000, model: "claude-haiku-4-5" }),
  ]);

  assert.equal(report.model, "claude-haiku-4-5");
  assert.equal(report.contextWindowSize, 200_000);
  assert.equal(report.utilization, 90);
});

test("an attachment for the same model still supplies the [1m] suffix", () => {
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 50_000, model: "claude-opus-5" }),
  ]);

  assert.equal(report.model, "claude-opus-5[1m]");
  assert.equal(report.contextWindowSize, 1_000_000);
});

// Claude Code writes one assistant entry per content block — thinking, text
// and each tool_use — all carrying the same `usage`, because they came from one
// API call. Diffing consecutive *entries* therefore reports a turn cost of 0.

test("entries of one API call share a message id and count as a single turn", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 10_000, messageId: "msg_a" }),
    assistantLine({ cacheRead: 30_000, messageId: "msg_b" }),
    assistantLine({ cacheRead: 30_000, messageId: "msg_b" }),
  ]);

  assert.equal(report.tokens.total, 30_000);
  assert.equal(report.lastTurnTokens, 20_000);
});

test("entries without a message id still fall back to diffing consecutive turns", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 10_000 }),
    assistantLine({ cacheRead: 30_000 }),
  ]);

  assert.equal(report.lastTurnTokens, 20_000);
});

// Claude Code also writes synthetic assistant entries ("No response requested.")
// whose usage counters are all zero. Read as the live context they claim an
// empty window on a session that is nearly full.

test("a synthetic zero-usage entry does not become the live context", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 190_000, messageId: "msg_a" }),
    assistantLine({ cacheRead: 0, model: "<synthetic>", messageId: "msg_b" }),
  ]);

  assert.equal(report.tokens.total, 190_000);
  assert.equal(report.model, "claude-testmodel-1");
});

test("a transcript of nothing but zero-usage entries raises ContextUnavailableError", () => {
  assert.throws(
    () => parseTranscript([assistantLine({ cacheRead: 0 })]),
    ContextUnavailableError,
  );
});

// Whether the whole transcript was read decides what absence means: no compact
// boundary in a complete read means the session was never compacted, but in a
// truncated read it means we cannot tell.

test("a complete read reports the transcript as untruncated", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 10_000 })], { truncated: false });

  assert.equal(report.truncated, false);
});

test("a truncated read is flagged, so an absent compactedAt is not read as 'never'", () => {
  const report = parseTranscript([assistantLine({ cacheRead: 10_000 })], { truncated: true });

  assert.equal(report.truncated, true);
  assert.equal(report.compactedAt, undefined);
});

// A session whose turns outgrew 200k was necessarily running a 1M window,
// whatever its model id says.

test("a turn above the default window is measured against 1M, not clamped to 100%", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 411_628, model: "claude-fable-5-1" }),
  ]);

  assert.equal(report.contextWindowSize, 1_000_000);
  assert.equal(report.utilization, 41);
  assert.equal(report.remainingTokens, 588_372);
});

test("a stale [1m] attachment no longer shrinks a session below its real size", () => {
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 411_628, model: "claude-fable-5-1" }),
  ]);

  assert.equal(report.model, "claude-fable-5-1");
  assert.equal(report.contextWindowSize, 1_000_000);
  assert.equal(report.utilization, 41);
});

// Between running /compact and the next assistant turn, the newest turn on
// record is the pre-compact one. Its totals describe a context that no longer
// exists — and the boundary itself carries the answer.

function compactBoundaryLine(timestamp: string, postTokens?: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp,
    compactMetadata: postTokens === undefined ? {} : { postTokens },
  });
}

test("a compact newer than the last turn reports the post-compact size", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 190_000, timestamp: "2026-09-19T10:00:00.000Z" }),
    compactBoundaryLine("2026-09-19T10:05:00.000Z", 11_699),
  ]);

  assert.equal(report.tokens.total, 11_699);
  assert.equal(report.utilization, 6);
  assert.equal(report.compactedAt, "2026-09-19T10:05:00.000Z");
});

test("a compact older than the last turn leaves that turn's numbers alone", () => {
  const report = parseTranscript([
    compactBoundaryLine("2026-09-19T10:00:00.000Z", 11_699),
    assistantLine({ cacheRead: 40_000, timestamp: "2026-09-19T10:05:00.000Z" }),
  ]);

  assert.equal(report.tokens.total, 40_000);
});

test("a turn with no timestamp is not overridden by an undatable boundary", () => {
  const undated = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { model: "claude-testmodel-1", usage: { cache_read_input_tokens: 150_000 } },
  });
  const report = parseTranscript([compactBoundaryLine("2026-09-19T10:05:00.000Z", 11_699), undated]);

  assert.equal(report.tokens.total, 150_000);
});

test("a compact without postTokens cannot correct the turn, so it does not try", () => {
  const report = parseTranscript([
    assistantLine({ cacheRead: 190_000, timestamp: "2026-09-19T10:00:00.000Z" }),
    compactBoundaryLine("2026-09-19T10:05:00.000Z"),
  ]);

  assert.equal(report.tokens.total, 190_000);
});

// ---- readTranscriptLines ---------------------------------------------------

/** A real temp directory, removed when the test ends. */
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a small transcript is read whole", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  fs.writeFileSync(
    file,
    [modelAttachmentLine("claude-opus-5[1m]"), assistantLine({ cacheRead: 10_000 })].join("\n"),
  );

  const read = readTranscriptLines(file);

  assert.equal(read.lines.length, 2);
  assert.equal(read.truncated, false);
});

test("an oversized transcript still yields the head model and the tail usage", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const filler = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({ type: "user", note: `filler ${i}`.padEnd(120, "x") }),
  );
  fs.writeFileSync(
    file,
    [
      modelAttachmentLine("claude-opus-5[1m]"),
      ...filler,
      assistantLine({ cacheRead: 40_000, model: "claude-opus-5" }),
      assistantLine({ cacheRead: 50_000, model: "claude-opus-5" }),
    ].join("\n"),
  );

  const read = readTranscriptLines(file, { headBytes: 400, tailBytes: 600 });
  const report = parseTranscript(read.lines, { truncated: read.truncated });

  assert.equal(read.truncated, true);
  assert.equal(report.model, "claude-opus-5[1m]");
  assert.equal(report.tokens.total, 50_000);
  assert.equal(report.lastTurnTokens, 10_000);
});

test("the lines truncated by the read budget are dropped, never half-parsed", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const lines = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ type: "user", note: `line ${i}`.padEnd(100, "y") }),
  );
  fs.writeFileSync(file, lines.join("\n"));

  for (const line of readTranscriptLines(file, { headBytes: 350, tailBytes: 350 }).lines) {
    assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`);
  }
});

test("a missing transcript raises ContextUnavailableError", (t) => {
  const file = path.join(tempDir(t), "nope.jsonl");

  assert.throws(() => readTranscriptLines(file), ContextUnavailableError);
});

// A single transcript line can be far larger than the tail budget — base64
// screenshots and big tool results reach well over a megabyte. If such a line
// is the last one, a fixed-size tail holds no complete turn at all, and the
// report silently falls back to numbers from session start.

test("the tail grows past a giant trailing line rather than reporting stale turns", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const giant = JSON.stringify({ type: "user", blob: "z".repeat(4_000) });
  fs.writeFileSync(
    file,
    [
      modelAttachmentLine("claude-opus-5"),
      assistantLine({ cacheRead: 100_000 }),
      assistantLine({ cacheRead: 150_000 }),
      giant,
    ].join("\n"),
  );

  const read = readTranscriptLines(file, { headBytes: 200, tailBytes: 500 });
  const report = parseTranscript(read.lines, {
    truncated: read.truncated,
    contiguousFrom: read.contiguousFrom,
  });

  assert.equal(report.tokens.total, 150_000);
  assert.equal(report.lastTurnTokens, 50_000);
});

// The tail must hold two *calls* to have something to diff against. Counting
// entries instead lets one multi-block final turn — thinking + text + tool_use,
// the ordinary shape — satisfy the gate on its own, and the growth stops one
// step too early with nothing to compare.

test("the tail grows for a second call, not merely a second entry", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const filler = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ type: "user", note: `filler ${i}`.padEnd(110, "x") }),
  );
  fs.writeFileSync(
    file,
    [
      assistantLine({ cacheRead: 1_000, messageId: "call_a" }),
      ...filler,
      assistantLine({ cacheRead: 5_000, messageId: "call_b" }),
      assistantLine({ cacheRead: 5_000, messageId: "call_b" }),
      assistantLine({ cacheRead: 5_000, messageId: "call_b" }),
    ].join("\n"),
  );

  const read = readTranscriptLines(file, { headBytes: 200, tailBytes: 900 });
  const report = parseTranscript(read.lines, {
    truncated: read.truncated,
    contiguousFrom: read.contiguousFrom,
  });

  assert.equal(report.tokens.total, 5_000);
  assert.equal(report.lastTurnTokens, 4_000);
});

// Growing the tail is bounded: past the ceiling, one usable call is accepted
// rather than pulling a hundred-megabyte transcript into memory on every call.

test("the growth ceiling is stepped onto exactly, not jumped over", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const filler = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ type: "user", note: `filler-${i}`.padEnd(110, "x") }),
  );
  fs.writeFileSync(
    file,
    [
      assistantLine({ cacheRead: 1_000, messageId: "call_a" }),
      ...filler,
      assistantLine({ cacheRead: 5_000, messageId: "call_b" }),
    ].join("\n"),
  );

  // 1 200 finds only the last call, so the tail grows. Multiplying by four
  // would overshoot both the 2 000-byte ceiling and the file, reading it
  // whole; stepping onto the ceiling stops there and keeps the read bounded.
  const read = readTranscriptLines(file, {
    headBytes: 200,
    tailBytes: 1_200,
    maxTailBytes: 2_000,
  });

  assert.equal(read.truncated, true);
});

// Head and tail are read from fixed ends. Once a growth step reaches back past
// the head, the two overlap and the stitched array repeats lines — which also
// makes `contiguousFrom` point at the wrong place.

test("a tail that grows back into the head does not duplicate lines", (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  const block = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({ type: "user", note: `unique-${from + i}`.padEnd(110, "x") }),
    );
  // The two calls sit ~5 700 bytes in: past a 3 000-byte tail, so the tail
  // grows; and past the point the grown tail reaches back to, which lands
  // inside the 5 000-byte head.
  fs.writeFileSync(
    file,
    [
      ...block(0, 40),
      assistantLine({ cacheRead: 1_000, messageId: "call_a" }),
      assistantLine({ cacheRead: 2_000, messageId: "call_b" }),
      ...block(100, 79),
    ].join("\n"),
  );

  const { lines } = readTranscriptLines(file, { headBytes: 5_000, tailBytes: 3_000 });

  assert.equal(new Set(lines).size, lines.length);
});

test("a zero-byte tail budget does not spin forever", { timeout: 5_000 }, (t) => {
  const file = path.join(tempDir(t), "session.jsonl");
  fs.writeFileSync(
    file,
    Array.from({ length: 60 }, () => assistantLine({ cacheRead: 1_000 })).join("\n"),
  );

  assert.ok(readTranscriptLines(file, { headBytes: 200, tailBytes: 0 }).lines.length > 0);
});

// Head and tail are stitched together with a gap in between. Diffing the first
// tail turn against the last head turn measures the whole skipped middle and
// calls it one turn.

test("the turn diff is not computed across the skipped middle", () => {
  const report = parseTranscript(
    [
      assistantLine({ cacheRead: 5_000, messageId: "head" }),
      assistantLine({ cacheRead: 160_000, messageId: "tail" }),
    ],
    { truncated: true, contiguousFrom: 1 },
  );

  assert.equal(report.tokens.total, 160_000);
  assert.equal(report.lastTurnTokens, null);
});

test("an unknown turn cost is left out of the line rather than invented", () => {
  const line = formatContextLine(reportFor({ lastTurnTokens: null }));

  assert.match(line, /^context: 6% used \(64 802 \/ 1 000 000 tokens, window from model table\)$/);
});

// ---- projectSlug / resolveTranscriptCandidates -----------------------------------

test("a working directory maps to the project folder Claude Code writes to", () => {
  assert.equal(projectSlug("C:\\Users\\dev\\Documents"), "C--Users-dev-Documents");
});

test("the slug keeps hyphens and replaces every other separator", () => {
  assert.equal(
    projectSlug("/home/dev/src/claude-usage-mcp"),
    "-home-dev-src-claude-usage-mcp",
  );
});

/** Write a transcript into `<projects>/<slug>/<id>.jsonl` with a set mtime. */
function seedTranscript(
  projectsDir: string,
  slug: string,
  id: string,
  mtimeMs: number,
): string {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, assistantLine({ cacheRead: 1_000 }));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test("the newest transcript of the working directory's own project wins", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "old", Date.now() - 60_000);
  const newest = seedTranscript(projectsDir, "C--work-repo", "new", Date.now());
  seedTranscript(projectsDir, "C--other", "elsewhere", Date.now() + 60_000);

  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo" }).paths[0],
    newest,
  );
});

test("an unknown working directory falls back to the newest transcript anywhere", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--other", "old", Date.now() - 60_000);
  const newest = seedTranscript(projectsDir, "C--elsewhere", "new", Date.now());

  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\never\\indexed" }).paths[0],
    newest,
  );
});

test("how the transcript was found is reported, not just which one", (t) => {
  const projectsDir = tempDir(t);
  const own = seedTranscript(projectsDir, "C--work-repo", "own", Date.now());

  assert.equal(resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo" }).match, "cwd");
  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\never\\indexed" }).match,
    "fallback",
  );
  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo", transcriptPath: own }).match,
    "explicit",
  );
});

test("an explicit transcript path is used as given", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());
  const chosen = seedTranscript(projectsDir, "C--other", "chosen", Date.now() - 60_000);

  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo", transcriptPath: chosen }).paths[0],
    chosen,
  );
});

test("an explicit session id is found in any project folder", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());
  const wanted = seedTranscript(projectsDir, "C--other", "sess-42", Date.now() - 60_000);

  assert.equal(
    resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo", sessionId: "sess-42" }).paths[0],
    wanted,
  );
});

test("an unknown session id raises ContextUnavailableError", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());

  assert.throws(
    () => resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo", sessionId: "ghost" }),
    ContextUnavailableError,
  );
});

test("an empty projects folder raises ContextUnavailableError", (t) => {
  const projectsDir = tempDir(t);

  assert.throws(
    () => resolveTranscriptCandidates({ projectsDir, cwd: "C:\\work\\repo" }),
    ContextUnavailableError,
  );
});

// ---- readContextReport / tryReadContextReport ------------------------------

test("the report reads the live session end to end and names its transcript", (t) => {
  const projectsDir = tempDir(t);
  const dir = path.join(projectsDir, "C--work-repo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sess-1.jsonl");
  fs.writeFileSync(
    file,
    [
      modelAttachmentLine("claude-opus-5[1m]"),
      assistantLine({ cacheRead: 30_000, model: "claude-opus-5" }),
      assistantLine({ cacheRead: 50_000, model: "claude-opus-5" }),
    ].join("\n"),
  );

  const report = readContextReport({ projectsDir, cwd: "C:\\work\\repo" });

  assert.equal(report.transcriptPath, file);
  assert.equal(report.sessionId, "sess-1");
  assert.equal(report.tokens.total, 50_000);
  assert.equal(report.lastTurnTokens, 20_000);
  assert.equal(report.utilization, 5);
});

test("tryReadContextReport returns null instead of throwing when nothing is readable", (t) => {
  const projectsDir = tempDir(t);

  assert.equal(tryReadContextReport({ projectsDir, cwd: "C:\\work\\repo" }), null);
});

// A transcript with no assistant turn is never the caller's own — the turn
// that invoked this tool was appended before the tool ran. So an idle session
// sitting at the top of the mtime order must not shadow the real one.

test("an unusable newest transcript does not hide a usable sibling", (t) => {
  const projectsDir = tempDir(t);
  const dir = path.join(projectsDir, "C--work-repo");
  fs.mkdirSync(dir, { recursive: true });
  const older = path.join(dir, "real.jsonl");
  fs.writeFileSync(older, assistantLine({ cacheRead: 40_000 }));
  fs.utimesSync(older, Date.now() / 1000 - 60, Date.now() / 1000 - 60);
  fs.writeFileSync(path.join(dir, "idle.jsonl"), JSON.stringify({ type: "user", text: "hi" }));

  const report = readContextReport({ projectsDir, cwd: "C:\\work\\repo" });

  assert.equal(report.transcriptPath, older);
  assert.equal(report.tokens.total, 40_000);
});

test("the report says whether it is the caller's own session or a fallback", (t) => {
  const projectsDir = tempDir(t);
  const dir = path.join(projectsDir, "D--other-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stranger.jsonl"), assistantLine({ cacheRead: 40_000 }));

  const report = readContextReport({ projectsDir, cwd: "C:\\work\\repo" });

  assert.equal(report.sessionMatch, "fallback");
});

// get_usage appends the context line without being asked for it. Quietly
// describing some other project's session there would be worse than saying
// nothing, so the silent path refuses a fallback.

test("the silent garnish refuses a session that is not the caller's", (t) => {
  const projectsDir = tempDir(t);
  const dir = path.join(projectsDir, "D--other-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stranger.jsonl"), assistantLine({ cacheRead: 40_000 }));

  assert.equal(
    tryReadContextReport({ projectsDir, cwd: "C:\\work\\repo", ownSessionOnly: true }),
    null,
  );
});

test("the silent garnish accepts the caller's own session", (t) => {
  const projectsDir = tempDir(t);
  const dir = path.join(projectsDir, "C--work-repo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "own.jsonl"), assistantLine({ cacheRead: 40_000 }));

  const report = tryReadContextReport({
    projectsDir,
    cwd: "C:\\work\\repo",
    ownSessionOnly: true,
  });

  assert.equal(report?.sessionMatch, "cwd");
});

// ---- formatContextLine -----------------------------------------------------

/** A report shaped like the real thing, with only the formatted fields set. */
function reportFor(overrides: Partial<ContextReport>): ContextReport {
  return {
    sessionId: "sess-1",
    transcriptPath: "/tmp/sess-1.jsonl",
    cwd: "/work/repo",
    model: "claude-opus-5[1m]",
    contextWindowSize: 1_000_000,
    contextWindowSource: "model-table",
    tokens: { input: 0, cacheCreation: 0, cacheRead: 64_802, output: 0, total: 64_802 },
    lastTurnTokens: 3_052,
    utilization: 6,
    remainingTokens: 935_198,
    lastMessageAt: "2026-09-19T10:00:00.000Z",
    truncated: false,
    sessionMatch: "cwd",
    ...overrides,
  };
}

// The percentage is only as good as what it is divided by, and the division
// is invisible in a bare "6%". Naming the basis is what lets a reader catch a
// wrong one instead of acting on it.

test("the context line groups thousands and names the basis of the window", () => {
  assert.equal(
    formatContextLine(reportFor({})),
    "context: 6% used (64 802 / 1 000 000 tokens, window from model table), last turn +3 052",
  );
});

test("an assumed window is a warning, not a quiet footnote", () => {
  const line = formatContextLine(
    reportFor({ contextWindowSource: "default", model: "claude-mystery-9" }),
  );

  assert.match(line, /window ASSUMED/);
  assert.match(line, /status line is authoritative/);
});

test("each basis has its own wording", () => {
  const wording = (source: ContextReport["contextWindowSource"]) =>
    formatContextLine(reportFor({ contextWindowSource: source }));

  assert.match(wording("override"), /CLAUDE_CONTEXT_WINDOW/);
  assert.match(wording("suffix"), /\[1m\] model id/);
  assert.match(wording("observed-prompt"), /inferred from prompt size/);
});

test("a fallback session is labelled, so its numbers are not read as the caller's", () => {
  const line = formatContextLine(reportFor({ sessionMatch: "fallback" }));

  assert.match(line, /another session/);
});

test("a turn that shrank the context keeps its negative sign", () => {
  assert.equal(
    formatContextLine(reportFor({ lastTurnTokens: -120_400 })),
    "context: 6% used (64 802 / 1 000 000 tokens, window from model table), last turn -120 400",
  );
});
