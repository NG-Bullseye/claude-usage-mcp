# ARCHITECTURE — claude-usage-mcp

## Deep Modules — OAuth-Usage → Forecast → Velocity

Der Hauptflow liest die Claude-Code-OAuth-Credentials, fragt `GET /api/oauth/usage` ab (fetch, Fallback curl), rechnet je Fenster (5h, weekly, weekly_opus) Forecast und Velocity-Empfehlung und löst optional einen Threshold-Webhook aus. Zwei Einstiege auf denselben Kern: `src/index.ts` (MCP stdio) und `src/cli.ts`. Jede Innenleben-Zelle ist datei:zeile und muss per grep -n treffen.

## Flow

**Sequenz** (`src/index.ts:35 buildReport(usage)`)

| # | Modul | Eingang | Ausgang | Bedingung | Stellschraube | Innenleben |
|---|---|---|---|---|---|---|
| 1 | Credentials | `~/.claude/.credentials.json` / Keychain | gültiges Token | Refresh bei Ablauf | — | `src/client.ts:149 private async getValidCredentials` |
| 2 | Usage-Abruf | Token | `five_hour`, `seven_day`, `seven_day_opus` | — | `USAGE_URL` | `src/client.ts:181 async fetchUsage` |
| 3 | HTTP | URL + Header | Response | fetch 403 → curl | `CLAUDE_USAGE_FORCE_CURL` | `src/http.ts:83 export async function request` |
| 4 | Forecast | Fenster | utilization, forecast, exhaustAt, velocity | ≥ 3 min verstrichen | `VELOCITY_CAP` (120) | `src/forecast.ts:54 export function computeForecast` |
| 5 | Report | Usage | alle Fenster | — | — | `src/forecast.ts:175 export function buildReport` |
| 6 | Webhook | Report | POST JSON | URL gesetzt, ≥ Schwelle, Cooldown | `CLAUDE_USAGE_WEBHOOK_THRESHOLD_PCT` | `src/webhook.ts:72 export async function maybeNotifyThreshold` |

**Parallel**

| Modul | Eingang | Ausgang | Bedingung | Stellschraube | Innenleben |
|---|---|---|---|---|---|
| Tool `get_velocity` | window | Forecast eines Fensters | — | — | `src/index.ts:60 "get_velocity"` |
| CLI | — | Report auf stdout | — | — | `src/cli.ts:16 async function main` |

## Schnittstellen

- MCP stdio, Build `dist/` (gitignored, `npm run build`).
- Webhook-Zustand `~/.cache/claude-usage-mcp/webhook-state.json` (`src/webhook.ts:33 STATE_FILE`).

## Standard: Deep Modules + Flow

Kanon: `~/repos/speech-engine/ARCHITECTURE.md` § Standard (R1–R5).
