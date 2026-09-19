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
  resolveTranscriptPath,
  tryReadContextReport,
} from "./context.js";
import { ContextReport } from "./types.js";

test("a model id with the [1m] suffix gets the 1M context window", () => {
  assert.equal(contextWindowSizeFor("claude-opus-5[1m]"), 1_000_000);
});

test("a plain model id gets the default 200k context window", () => {
  assert.equal(contextWindowSizeFor("claude-sonnet-5"), 200_000);
});

test("an unknown or missing model id falls back to the default window", () => {
  assert.equal(contextWindowSizeFor(undefined), 200_000);
});

test("CLAUDE_CONTEXT_WINDOW overrides the inferred window", () => {
  assert.equal(contextWindowSizeFor("claude-opus-5[1m]", { override: "500000" }), 500_000);
});

test("a non-numeric CLAUDE_CONTEXT_WINDOW is ignored", () => {
  assert.equal(contextWindowSizeFor("claude-sonnet-5", { override: "lots" }), 200_000);
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
      model: opts.model ?? "claude-sonnet-5",
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
    modelAttachmentLine("claude-sonnet-5"),
    assistantLine({ cacheRead: 20_000 }),
  ]);

  assert.equal(report.model, "claude-sonnet-5");
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
  const report = parseTranscript([
    modelAttachmentLine("claude-opus-5[1m]"),
    assistantLine({ cacheRead: 180_000, model: "claude-fable-5-1" }),
  ]);

  assert.equal(report.model, "claude-fable-5-1");
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
  assert.equal(report.model, "claude-sonnet-5");
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

// ---- projectSlug / resolveTranscriptPath -----------------------------------

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
    resolveTranscriptPath({ projectsDir, cwd: "C:\\work\\repo" }),
    newest,
  );
});

test("an unknown working directory falls back to the newest transcript anywhere", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--other", "old", Date.now() - 60_000);
  const newest = seedTranscript(projectsDir, "C--elsewhere", "new", Date.now());

  assert.equal(
    resolveTranscriptPath({ projectsDir, cwd: "C:\\never\\indexed" }),
    newest,
  );
});

test("an explicit transcript path is used as given", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());
  const chosen = seedTranscript(projectsDir, "C--other", "chosen", Date.now() - 60_000);

  assert.equal(
    resolveTranscriptPath({ projectsDir, cwd: "C:\\work\\repo", transcriptPath: chosen }),
    chosen,
  );
});

test("an explicit session id is found in any project folder", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());
  const wanted = seedTranscript(projectsDir, "C--other", "sess-42", Date.now() - 60_000);

  assert.equal(
    resolveTranscriptPath({ projectsDir, cwd: "C:\\work\\repo", sessionId: "sess-42" }),
    wanted,
  );
});

test("an unknown session id raises ContextUnavailableError", (t) => {
  const projectsDir = tempDir(t);
  seedTranscript(projectsDir, "C--work-repo", "auto", Date.now());

  assert.throws(
    () => resolveTranscriptPath({ projectsDir, cwd: "C:\\work\\repo", sessionId: "ghost" }),
    ContextUnavailableError,
  );
});

test("an empty projects folder raises ContextUnavailableError", (t) => {
  const projectsDir = tempDir(t);

  assert.throws(
    () => resolveTranscriptPath({ projectsDir, cwd: "C:\\work\\repo" }),
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

// ---- formatContextLine -----------------------------------------------------

/** A report shaped like the real thing, with only the formatted fields set. */
function reportFor(overrides: Partial<ContextReport>): ContextReport {
  return {
    sessionId: "sess-1",
    transcriptPath: "/tmp/sess-1.jsonl",
    cwd: "/work/repo",
    model: "claude-opus-5[1m]",
    contextWindowSize: 1_000_000,
    tokens: { input: 0, cacheCreation: 0, cacheRead: 64_802, output: 0, total: 64_802 },
    lastTurnTokens: 3_052,
    utilization: 6,
    remainingTokens: 935_198,
    lastMessageAt: "2026-09-19T10:00:00.000Z",
    truncated: false,
    ...overrides,
  };
}

test("the context line groups thousands and states the window it is against", () => {
  assert.equal(
    formatContextLine(reportFor({})),
    "context: 6% used (64 802 / 1 000 000 tokens), last turn +3 052",
  );
});

test("a turn that shrank the context keeps its negative sign", () => {
  assert.equal(
    formatContextLine(reportFor({ lastTurnTokens: -120_400 })),
    "context: 6% used (64 802 / 1 000 000 tokens), last turn -120 400",
  );
});
