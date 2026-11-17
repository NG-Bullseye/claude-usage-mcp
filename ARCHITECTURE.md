# ARCHITECTURE — claude-usage-mcp

## Deep Modules — OAuth-Usage → Forecast → Velocity

> Stand 2026-11-10 · geprüft gegen b356565

Der Hauptflow liest die Claude-Code-OAuth-Credentials, fragt `GET /api/oauth/usage` ab (fetch, Fallback curl), rechnet je Fenster (5h, weekly, weekly_opus) Forecast und Velocity-Empfehlung und löst optional einen Threshold-Webhook aus. Zwei Einstiege auf denselben Kern: `src/index.ts` (MCP stdio) und `src/cli.ts`. Jede Innenleben-Zelle ist datei:zeile und muss per grep -n treffen.

## Flow

> Stand 2026-10-27 · geprüft gegen cd88239

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

> Stand 2026-10-27 · geprüft gegen cd88239

- MCP stdio, Build `dist/` (gitignored, `npm run build`).
- Webhook-Zustand `~/.cache/claude-usage-mcp/webhook-state.json` (`src/webhook.ts:33 STATE_FILE`).

## Standard: Deep Modules + Flow

> Stand 2026-10-27 · geprüft gegen cd88239

Kanon: `~/repos/speech-engine/ARCHITECTURE.md` § Standard (R1–R5).

<!-- graph:auto:start -->
## Graph-Auto (generated 2026-11-10 by `bin/arch_auto_block.py`, do not edit by hand)

**Deep Modules** (cross-file edges):
- `src/client.ts` — 17
- `src/types.ts` — 14
- `src/index.ts` — 11
- `src/forecast.ts` — 8
- `src/cli.ts` — 6
- `src/webhook.ts` — 4

**Interfaces** (modules/symbols imported or called from other files):
- `src/index.ts` — used by 3 files
- `src/webhook.ts` — used by 2 files
- `src/cli.ts` — used by 1 files
- `src/cli.ts::main()` — used by 1 files
- `src/client.ts` — used by 1 files
- `src/types.ts` — used by 1 files
- `src/types.ts::ClaudeCredentials` — used by 1 files
- `src/types.ts::ClaudeApiUsageResponse` — used by 1 files

**Bus connections** (redis / route / http nodes of the house graph):
- none
<!-- graph:auto:end -->

<!-- services:begin -->
## Aktive Services

> Stand 2026-11-17 20:13 · generiert von `~/repos/maintenance/repo_inventory.py` (Skill `repo-inventar`), nicht von Hand editieren

| Art | Name | Wofür | Zustand | Zuletzt benutzt |
|---|---|---|---|---|
| mcp | `claude-usage` | MCP-Server `claude-usage` (stdio) | Prozess läuft | — |

<!-- services:end -->
