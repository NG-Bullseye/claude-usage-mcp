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
