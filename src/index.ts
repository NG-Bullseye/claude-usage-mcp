#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ClaudeUsageClient, UsageUnavailableError } from "./client.js";
import {
  ContextUnavailableError,
  formatContextLine,
  readContextReport,
  tryReadContextReport,
} from "./context.js";
import { buildReport, computeForecast } from "./forecast.js";
import { ALIAS_TO_KEY, WindowAlias } from "./types.js";
import { maybeNotifyThreshold } from "./webhook.js";

const client = new ClaudeUsageClient();

function errorContent(e: unknown) {
  const known = e instanceof UsageUnavailableError || e instanceof ContextUnavailableError;
  const msg = known ? e.message : `Unexpected error: ${(e as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const server = new McpServer({ name: "claude-usage-mcp", version: "0.1.0" });

server.registerTool(
  "get_usage",
  {
    title: "Get Claude usage + forecast",
    description:
      "Current Claude subscription usage for every window (5-hour, weekly, weekly-Opus): " +
      "utilization %, reset time, a forecast of where you'll land at reset, when you'd hit " +
      "the limit at the current pace, and a velocity recommendation (0-120%; 100 = full " +
      "speed lands exactly at the limit, <100 = throttle, >100 = headroom to spare). " +
      "Reuses Claude Code's OAuth session; no API key needed.",
    inputSchema: {},
  },
  async () => {
    try {
      const usage = await client.fetchUsage();
      const report = buildReport(usage);
      await maybeNotifyThreshold(report);
      const lines: string[] = [];
      for (const [name, f] of Object.entries(report.windows)) {
        if (!f) continue;
        lines.push(
          `${name}: ${f.utilization}% used, resets ${f.resetsAt} ` +
            `(in ${f.remainingHours}h) — forecast at reset ${f.projectedEndUtilization}%, ` +
            `velocity ${f.velocityRecommendation}% (${f.recommendation})` +
            (f.exhaustAt ? `, would hit 100% at ${f.exhaustAt}` : ""),
        );
      }
      // Best-effort garnish: the quota report stands on its own if the
      // transcript cannot be read, so a context miss stays silent here — and
      // `ownSessionOnly` keeps an unrelated project's session from being
      // appended, unasked, as though it were the caller's.
      const context = tryReadContextReport({ ownSessionOnly: true });
      if (context) lines.push(formatContextLine(context));
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") || "No usage windows returned." },
          { type: "text" as const, text: JSON.stringify({ ...report, context }, null, 2) },
        ],
      };
    } catch (e) {
      return errorContent(e);
    }
  },
);

server.registerTool(
  "get_velocity",
  {
    title: "Get velocity recommendation",
    description:
      "Velocity recommendation (0-120%) for one window. 100% = keep going at full speed and " +
      "you'll land exactly at the limit at reset; <100% = the fraction of your current pace " +
      "you should slow to; >100% (capped at 120) = you have so much headroom you can't burn " +
      "through the quota. window: '5h' (rolling 5-hour), 'weekly' (7-day), or 'weekly_opus'.",
    inputSchema: {
      window: z
        .enum(["5h", "weekly", "weekly_opus"])
        .describe("Which limit window to evaluate."),
    },
  },
  async ({ window }: { window: WindowAlias }) => {
    try {
      const usage = await client.fetchUsage();
      const key = ALIAS_TO_KEY[window];
      const limit = usage[key];
      if (!limit) {
        return {
          content: [
            { type: "text" as const, text: `Window '${window}' is not present in the usage response.` },
          ],
          isError: true,
        };
      }
      const f = computeForecast(limit, key);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${window} velocity: ${f.velocityRecommendation}% — ${f.recommendation}. ` +
              `(${f.utilization}% used, forecast ${f.projectedEndUtilization}% at reset in ${f.remainingHours}h)`,
          },
          { type: "text" as const, text: JSON.stringify(f, null, 2) },
        ],
      };
    } catch (e) {
      return errorContent(e);
    }
  },
);

server.registerTool(
  "get_context",
  {
    title: "Get context window usage",
    description:
      "How full the current session's context window is: percent used, tokens " +
      "consumed and remaining, the window size (200k, or 1M on a [1m] model), and " +
      "what the last turn added. This is session context, not subscription quota — " +
      "use get_usage for quota. Read from the session transcript Claude Code writes " +
      "on disk; the session is identified by the server's working directory, so pass " +
      "session_id or transcript_path to read a different one.",
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe("Read this session instead of the one guessed from the working directory."),
      transcript_path: z
        .string()
        .optional()
        .describe("Absolute path of a transcript .jsonl to read instead of guessing."),
    },
  },
  async ({
    session_id,
    transcript_path,
  }: {
    session_id?: string;
    transcript_path?: string;
  }) => {
    try {
      const report = readContextReport({
        sessionId: session_id,
        transcriptPath: transcript_path,
      });
      return {
        content: [
          { type: "text" as const, text: formatContextLine(report) },
          { type: "text" as const, text: JSON.stringify(report, null, 2) },
        ],
      };
    } catch (e) {
      return errorContent(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-usage-mcp] ready on stdio");
}

main().catch((e) => {
  console.error("[claude-usage-mcp] fatal:", e);
  process.exit(1);
});
