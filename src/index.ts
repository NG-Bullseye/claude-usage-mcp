#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ClaudeUsageClient, UsageUnavailableError } from "./client.js";
import { buildReport, computeForecast } from "./forecast.js";
import { ALIAS_TO_KEY, WindowAlias } from "./types.js";

const client = new ClaudeUsageClient();

function errorContent(e: unknown) {
  const msg = e instanceof UsageUnavailableError ? e.message : `Unexpected error: ${(e as Error).message}`;
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
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") || "No usage windows returned." },
          { type: "text" as const, text: JSON.stringify(report, null, 2) },
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-usage-mcp] ready on stdio");
}

main().catch((e) => {
  console.error("[claude-usage-mcp] fatal:", e);
  process.exit(1);
});
