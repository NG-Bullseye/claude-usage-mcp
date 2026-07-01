import { ClaudeApiUsageResponse, ClaudeUsageLimit, WindowKey, WINDOW_HOURS } from "./types.js";

// Reported velocity is clamped to this ceiling. 100 = keep current pace and
// land exactly at the limit at reset. >100 means you have headroom; we cap at
// 120 to signal "you can't burn through the quota at anything like this pace".
export const VELOCITY_CAP = 120;

// Below this many minutes of elapsed time the average-rate math is too noisy
// (a single early request looks like an infinite burn rate), so we treat the
// window as "just reset, plenty of headroom".
const MIN_ELAPSED_MINUTES = 3;

const HOUR_MS = 3_600_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface WindowForecast {
  window: WindowKey;
  utilization: number;          // %, as reported (0-100)
  resetsAt: string;             // ISO
  windowHours: number;          // 5 or 168
  elapsedHours: number;
  remainingHours: number;
  ratePerHour: number;          // %/h, average over the elapsed window
  projectedEndUtilization: number; // % at reset if this pace continues
  willExhaust: boolean;         // projected end > 100 before reset
  exhaustAt: string | null;     // ISO of when you'd hit 100% (null if you won't this window)
  hoursToExhaust: number | null;
  velocityRecommendation: number; // 0-120 (see VELOCITY_CAP)
  recommendation: string;       // short human label
}

function labelForVelocity(v: number, willExhaust: boolean, exhausted: boolean): string {
  if (exhausted) return "quota exhausted — wait for the reset";
  if (v >= VELOCITY_CAP) return "full speed — you can't use up this quota at the current pace";
  if (v >= 100) return "full speed — on track to land right at the limit at reset";
  if (!willExhaust) return `ease off to ~${round(v)}% of your current pace to stay on budget`;
  if (v >= 50) return `slow down to ~${round(v)}% of your current pace or you'll run out early`;
  return `throttle hard — ~${round(v)}% of your current pace, you're set to run out well before reset`;
}

export function computeForecast(
  limit: ClaudeUsageLimit,
  window: WindowKey,
  now: number = Date.now(),
): WindowForecast {
  const windowHours = WINDOW_HOURS[window];
  const u = clamp(limit.utilization, 0, 100);
  const resetsAtMs = new Date(limit.resets_at).getTime();
  const windowMs = windowHours * HOUR_MS;

  const remainingMs = Math.max(0, resetsAtMs - now);
  const elapsedMs = clamp(windowMs - remainingMs, 0, windowMs);

  const elapsedHours = elapsedMs / HOUR_MS;
  const remainingHours = remainingMs / HOUR_MS;

  // Floor the elapsed time used for rate math so an early single request
  // doesn't read as an astronomically high burn rate.
  const elapsedForRateMs = Math.max(elapsedMs, MIN_ELAPSED_MINUTES * 60_000);
  const ratePerHour = u / (elapsedForRateMs / HOUR_MS);

  // Where we'd land at reset if the average pace so far simply continues.
  const projectedEndUtilization = (u * windowMs) / elapsedForRateMs;
  const willExhaust = projectedEndUtilization > 100 && remainingMs > 0 && u < 100;

  let hoursToExhaust: number | null = null;
  let exhaustAt: string | null = null;
  if (willExhaust && ratePerHour > 0) {
    hoursToExhaust = (100 - u) / ratePerHour;
    exhaustAt = new Date(now + hoursToExhaust * HOUR_MS).toISOString();
  }

  // Velocity recommendation: fraction of the current pace you can sustain and
  // still land exactly at 100% at reset.
  //   sustainableRate = remainingCapacity / remainingTime
  //   velocity        = sustainableRate / currentRate * 100
  let velocity: number;
  if (u >= 100) {
    velocity = 0; // already exhausted
  } else if (u <= 0 || remainingMs <= 0) {
    velocity = VELOCITY_CAP; // nothing used yet, or window essentially over
  } else {
    const sustainableRate = (100 - u) / remainingHours; // %/h
    velocity = (sustainableRate / ratePerHour) * 100;
  }
  velocity = clamp(velocity, 0, VELOCITY_CAP);

  return {
    window,
    utilization: round(u),
    resetsAt: new Date(resetsAtMs).toISOString(),
    windowHours,
    elapsedHours: round(elapsedHours, 2),
    remainingHours: round(remainingHours, 2),
    ratePerHour: round(ratePerHour, 3),
    projectedEndUtilization: round(projectedEndUtilization),
    willExhaust,
    exhaustAt,
    hoursToExhaust: hoursToExhaust == null ? null : round(hoursToExhaust, 2),
    velocityRecommendation: round(velocity),
    recommendation: labelForVelocity(velocity, willExhaust, u >= 100),
  };
}

export interface UsageReport {
  fetchedAt: string;
  windows: Partial<Record<"5h" | "weekly" | "weekly_opus", WindowForecast>>;
}

export function buildReport(usage: ClaudeApiUsageResponse, now: number = Date.now()): UsageReport {
  const windows: UsageReport["windows"] = {};
  if (usage.five_hour) windows["5h"] = computeForecast(usage.five_hour, "five_hour", now);
  if (usage.seven_day) windows["weekly"] = computeForecast(usage.seven_day, "seven_day", now);
  if (usage.seven_day_opus)
    windows["weekly_opus"] = computeForecast(usage.seven_day_opus, "seven_day_opus", now);
  return { fetchedAt: new Date(now).toISOString(), windows };
}
