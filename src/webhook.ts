// Generic, application-agnostic quota-threshold webhook. Disabled unless
// CLAUDE_USAGE_WEBHOOK_URL is set — zero behavior change for anyone who
// doesn't configure it. Fires a plain JSON POST when a usage window crosses
// the threshold, then again every COOLDOWN_MIN minutes while it stays above
// it (crossing back below clears the cooldown so the next rise fires
// immediately). The payload carries a ready-to-use `message` string plus the
// raw numbers, so any receiver — a Slack/Discord incoming webhook, a custom
// FastAPI endpoint, an MCP tool, whatever — can consume it without knowing
// anything about claude-usage-mcp. CLAUDE_USAGE_WEBHOOK_EXTRA_FIELDS_JSON lets
// an operator merge in whatever static fields their receiver needs (e.g. a
// routing/source tag) without this package having any opinion about them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { UsageReport } from "./forecast.js";

const WEBHOOK_URL = process.env.CLAUDE_USAGE_WEBHOOK_URL;
const THRESHOLD_PCT = Number(process.env.CLAUDE_USAGE_WEBHOOK_THRESHOLD_PCT ?? "80");
const COOLDOWN_MIN = Number(process.env.CLAUDE_USAGE_WEBHOOK_COOLDOWN_MIN ?? "30");

function parseExtraFields(): Record<string, unknown> {
  const raw = process.env.CLAUDE_USAGE_WEBHOOK_EXTRA_FIELDS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error("[webhook] CLAUDE_USAGE_WEBHOOK_EXTRA_FIELDS_JSON is not valid JSON, ignoring");
    return {};
  }
}

const STATE_FILE = path.join(os.homedir(), ".cache", "claude-usage-mcp", "webhook-state.json");

type State = Record<string, string>; // window -> ISO timestamp of the last notify

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error(`[webhook] failed to persist state: ${(e as Error).message}`);
  }
}

async function post(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[webhook] POST ${url} -> HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[webhook] POST ${url} failed: ${(e as Error).message}`);
  }
}

// Never throws — a webhook failure must not break get_usage / the CLI report.
// Callers should await this: the CLI in particular calls process.exit() right
// after, which would otherwise kill the process before the POST goes out.
export async function maybeNotifyThreshold(report: UsageReport): Promise<void> {
  if (!WEBHOOK_URL) return;

  const extraFields = parseExtraFields();
  const state = loadState();
  let dirty = false;
  const now = Date.now();
  const posts: Promise<void>[] = [];

  for (const [window, forecast] of Object.entries(report.windows)) {
    if (!forecast) continue;
    const lastIso = state[window];

    if (forecast.utilization < THRESHOLD_PCT) {
      if (lastIso) {
        delete state[window];
        dirty = true;
      }
      continue;
    }

    const cooldownElapsed = !lastIso || now - new Date(lastIso).getTime() >= COOLDOWN_MIN * 60_000;
    if (!cooldownElapsed) continue;

    state[window] = new Date(now).toISOString();
    dirty = true;

    posts.push(
      post(WEBHOOK_URL, {
        event: "claude_usage_threshold",
        window,
        utilization_pct: forecast.utilization,
        threshold_pct: THRESHOLD_PCT,
        resets_at: forecast.resetsAt,
        remaining_hours: forecast.remainingHours,
        velocity_recommendation: forecast.velocityRecommendation,
        message:
          `Claude usage (${window}) at ${forecast.utilization}%, over the ${THRESHOLD_PCT}% threshold. ` +
          `Resets in ${forecast.remainingHours}h. ${forecast.recommendation}.`,
        ...extraFields,
      }),
    );
  }

  if (dirty) saveState(state);
  await Promise.all(posts);
}
