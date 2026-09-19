# claude-usage-mcp

A tiny [MCP](https://modelcontextprotocol.io) server that reports your **Claude
subscription usage** — the 5-hour and weekly limit windows — with a **forecast**
and a **velocity recommendation**. No API key required: it reuses the OAuth
session that Claude Code already stores on your machine, exactly like Claude
Code's own `/usage` command.

It also reports **how full the current session's context window is**, read from
the session transcript on disk — see [`get_context`](#get_context).

## How it works

1. Reads Claude Code's OAuth credentials from `~/.claude/.credentials.json`
   (or the macOS Keychain item `Claude Code-credentials`), refreshing the
   access token when needed.
2. Calls the undocumented usage endpoint
   `GET https://api.anthropic.com/api/oauth/usage` with
   `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`.
   The response contains `five_hour`, `seven_day` and `seven_day_opus`, each
   with `utilization` (0–100) and `resets_at`.
3. Because Anthropic's edge fingerprints the TLS handshake and rejects Node's
   `fetch` with `403 "Request not allowed"`, the server tries `fetch` first and
   **falls back to the system `curl` binary** (which is accepted). `curl` ships
   with Windows 10+, macOS and Linux. Set `CLAUDE_USAGE_FORCE_CURL=1` to skip
   straight to curl.

> You must be signed in via Claude Code (`claude`) for this to work.

## Tools

### `get_usage`
No arguments. Returns every available window with:
`utilization`, `resetsAt`, `remainingHours`, `projectedEndUtilization`
(where you'd land at reset at the current pace), `exhaustAt` (when you'd hit
100% if you will), and `velocityRecommendation`. A `context` line is appended
when the session transcript is readable — see `get_context`.

### `get_velocity`
Argument `window`: `"5h"`, `"weekly"`, or `"weekly_opus"`. Returns just the
velocity recommendation and forecast for that one window.

### `get_context`
How full the **current session's context window** is — a different thing from
subscription quota, which is what the two tools above report.

```
context: 6% used (64 802 / 1 000 000 tokens), last turn +3 052
```

Returns `utilization` (0–100), `tokens` (`input`, `cacheCreation`, `cacheRead`,
`output`, `total`), `remainingTokens`, `contextWindowSize`, `model`,
`lastTurnTokens`, plus the `sessionId`, `cwd` and `transcriptPath` the numbers
came from, `compactedAt` when the session has been compacted, and `truncated`
(see below).

Both arguments are optional and only needed to read a session other than the
current one: `session_id`, or `transcript_path` for a transcript outside
`~/.claude/projects`.

**Where the numbers come from.** Claude Code hands its *status line* a
ready-made `context_window` payload, but an MCP server never sees it. What the
server can read is the session transcript at
`~/.claude/projects/<slug>/<session-id>.jsonl`: the last main-chain `assistant`
entry carries the `usage` counters of that API call, and their sum
(`input + cache_creation + cache_read + output`) is what the context bar counts.
Three kinds of entry are deliberately skipped:

- **Subagent turns** (`isSidechain: true`) run in their own window.
- **Synthetic entries** ("No response requested.") whose counters are all zero;
  read as the live context they claim an empty window on a full session.
- **Repeat entries of one API call** — Claude Code writes one entry per content
  block (thinking, text, each `tool_use`), all sharing a `message.id` and the
  same `usage`. They are one turn, so `lastTurnTokens` diffs against the
  previous *call*, not the previous line.

**Window size.** 200 000 tokens, or 1 000 000 when the model id carries the
`[1m]` suffix. Neither source in the transcript is sufficient alone:
`message.model` is written by the turn itself so it is never stale, but it drops
the suffix; the `model` attachment keeps the suffix but is written when a model
is *selected*, so a switch made later in a long session can leave a stale one
looking current. The attachment is therefore believed only when it names the
same model as the last turn. Set `CLAUDE_CONTEXT_WINDOW` to override the result
for a model whose window cannot be inferred.

**`truncated`** is true when the transcript was too large to read whole. The
token counts are unaffected — they come from the tail — but anything found by
*scanning* may have been missed in the skipped middle, which is why
`compactedAt` is only meaningful when `truncated` is false.

**`lastTurnTokens`** is the growth since the previous turn. It goes negative
across a `/compact`, which is the honest reading of what happened.

## The velocity recommendation (0–120%)

A single number telling you how hard you can push. It compares the *sustainable
pace* (the rate that exactly finishes the quota at reset) to your *current
average pace*:

- **100%** — full speed. At your current pace you land exactly at the limit
  right when the window resets.
- **< 100%** — the fraction of your current pace you should slow to in order not
  to run out early. e.g. `40%` = go at roughly 40% of your current speed.
- **> 100%** (capped at **120%**) — you have so much headroom you can't burn
  through the quota at anything like this pace. Go all out.

The 5-hour and weekly windows are evaluated **separately**, so you get
`5h` and `weekly` velocities independently.

Math per window (length `L` = 5h or 168h, utilization `u`%, reset at `R`):

```
elapsed   = now - (R - L)
remaining = R - now
rate      = u / elapsed                       # % per hour
forecast  = u / (elapsed / L)                 # % at reset if pace continues
exhaustAt = now + (100 - u) / rate            # only if forecast > 100
velocity  = ((100 - u) / remaining) / rate * 100   # clamped to [0, 120]
```

## Install & build

Setup in einem Schritt (idempotent, startet keinen Dienst): `bash bootstrap.sh`

```bash
npm install
npm run build
```

## Register with an MCP client

Claude Desktop (`claude_desktop_config.json`), or any stdio MCP client:

```json
{
  "mcpServers": {
    "claude-usage": {
      "command": "node",
      "args": ["/absolute/path/to/claude-usage-mcp/dist/index.js"]
    }
  }
}
```

## Threshold webhook (optional)

Get notified — by any system you choose — when a usage window crosses a
threshold. Disabled by default; opt in by setting `CLAUDE_USAGE_WEBHOOK_URL`.
Fires on every `get_usage` call and every `dist/cli.js` run (so it's only as
frequent as whatever already polls this package), independent of client:

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_USAGE_WEBHOOK_URL` | unset (disabled) | Where to `POST` the alert. Any HTTP endpoint. |
| `CLAUDE_USAGE_WEBHOOK_THRESHOLD_PCT` | `80` | Utilization % that triggers the first alert for a window. |
| `CLAUDE_USAGE_WEBHOOK_COOLDOWN_MIN` | `30` | Minutes between repeat alerts while a window stays above the threshold. Dropping back below clears it, so the next rise alerts immediately. |
| `CLAUDE_USAGE_WEBHOOK_EXTRA_FIELDS_JSON` | unset | JSON object merged into every payload — e.g. `{"channel":"#alerts"}` for a Slack incoming webhook, or a routing tag your own receiver expects. |

Payload (`Content-Type: application/json`):

```json
{
  "event": "claude_usage_threshold",
  "window": "5h",
  "utilization_pct": 87,
  "threshold_pct": 80,
  "resets_at": "2026-07-17T14:39:27.672Z",
  "remaining_hours": 3,
  "velocity_recommendation": 49,
  "message": "Claude usage (5h) at 87%, over the 80% threshold. Resets in 3h. throttle hard — ~49% of your current pace."
}
```

The `message` field is a ready-to-post string — point `CLAUDE_USAGE_WEBHOOK_URL`
at a Slack/Discord incoming webhook, a custom FastAPI endpoint, another MCP
tool's HTTP bridge, whatever you've got. This package has no opinion about the
receiver; it just POSTs plain JSON and never blocks or fails the caller if the
POST errors.

## Caveats

- The usage endpoint is **undocumented** and can change or disappear without
  notice — treat it as best-effort.
- The server can read your Claude Code OAuth tokens (the same file Claude Code
  itself uses). It never sends them anywhere except Anthropic's own endpoints,
  and passes the bearer token to `curl` via a stdin config file so it never
  appears in the process list.
- Velocity uses the *average* pace over the elapsed window (one snapshot per
  call). It's a guide, not a guarantee; a burst right before reset can still
  overshoot.
- `get_context` **guesses which session is calling it**, because MCP servers are
  told nothing about theirs. It takes the freshest transcript in the project
  folder matching the server's working directory, falling back to the freshest
  transcript anywhere under `~/.claude/projects`. That is right in practice —
  the turn making the call was just written to that file — but two sessions
  sharing a working directory can be confused for one another. Pass
  `session_id` when it matters.
- The transcript format is Claude Code's, not ours, and is undocumented. Only
  a handful of fields are read, and `get_usage` degrades silently to its quota
  numbers if any of this breaks.

## License

MIT
