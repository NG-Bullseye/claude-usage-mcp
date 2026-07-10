#!/usr/bin/env node
// Standalone CLI entry — reuses the exact same fetch/forecast logic as the MCP
// tools (get_usage), but writes a single JSON report to stdout instead of an
// MCP tool response. Built for non-MCP callers (T-304: project-manager-agent's
// pipeline-liveness quota guard shells out to this instead of duplicating the
// OAuth-fetch logic by hand). No server, no stdio transport — one-shot exit.
//
// Usage: node dist/cli.js
// stdout (exit 0): UsageReport JSON (see forecast.ts)
// stdout (exit 1): {"error": "<message>"} JSON — caller should treat as
//   "unknown" rather than "quota exhausted" (e.g. not logged in, rate-limited).
import { ClaudeUsageClient, UsageUnavailableError } from "./client.js";
import { buildReport } from "./forecast.js";

async function main() {
  const client = new ClaudeUsageClient();
  try {
    const usage = await client.fetchUsage();
    const report = buildReport(usage);
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exit(0);
  } catch (e) {
    const msg = e instanceof UsageUnavailableError ? e.message : `Unexpected error: ${(e as Error).message}`;
    process.stdout.write(JSON.stringify({ error: msg }) + "\n");
    process.exit(1);
  }
}

main();
