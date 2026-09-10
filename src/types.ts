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

/**
 * Subscription facts from `api/oauth/profile`. Separate endpoint, separate
 * cache: this changes when a plan changes, not every five minutes.
 *
 * There is **no "next renewal" field** in the payload. `subscriptionCreatedAt`
 * plus a monthly billing cycle is the only derivation available, and the
 * derivation is left to the caller so this stays a transport type.
 */
export interface SubscriptionInfo {
  organizationType?: string | null;
  billingType?: string | null;
  status?: string | null;
  /** ISO timestamp the subscription started — the billing anniversary. */
  subscriptionCreatedAt?: string | null;
  hasMax?: boolean | null;
  hasPro?: boolean | null;
}

export interface ClaudeProfileResponse {
  account?: { has_claude_max?: boolean; has_claude_pro?: boolean } | null;
  organization?: {
    organization_type?: string | null;
    billing_type?: string | null;
    subscription_status?: string | null;
    subscription_created_at?: string | null;
  } | null;
}
