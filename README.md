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
context: 6% used (64 802 / 1 000 000 tokens, window from model table), last turn +3 052
```

Returns `utilization` (0–100), `tokens` (`input`, `cacheCreation`, `cacheRead`,
`output`, `total`), `remainingTokens`, `contextWindowSize`, `model`,
`lastTurnTokens`, `contextWindowSource`, plus the `sessionId`, `cwd` and
`transcriptPath` the numbers came from, `compactedAt` when the session has been
compacted, `truncated` and `sessionMatch` (all explained below).

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

- **Synthetic entries** ("No response requested.") whose counters are all zero;
  read as the live context they claim an empty window on a full session.
- **Repeat entries of one API call** — Claude Code writes one entry per content
  block (thinking, text, each `tool_use`), all sharing a `message.id` and the
  same `usage`. They are one turn, so `lastTurnTokens` diffs against the
  previous *call*, not the previous line.
- **Subagent turns** (`isSidechain: true`). Today's Claude Code writes subagent
  transcripts to a subfolder instead and never sets this flag, so the filter is
  currently inert; it is kept because the field is part of the entry shape and
  costs nothing to honour.

**Window size** is decided in a fixed order, and the report says which rule
answered via `contextWindowSource`:

| Order | `contextWindowSource` | Rule |
|---|---|---|
| 1 | `override` | `CLAUDE_CONTEXT_WINDOW` is set to a positive number |
| 2 | `suffix` | the model id carries `[1m]` |
| 3 | `model-table` | the id matches a known family (below) |
| 4 | `observed-prompt` | the prompt already exceeds 200 000, which only a 1M window allows |
| 5 | `default` | none of the above — 200 000 is **assumed**, and the text line says so |

Known families, as of 2026-06-24. Matched as a prefix of the id with any
variant suffix stripped, so a point release inherits its family's window:

| Family | Window |
|---|---|
| `claude-fable-5*`, `claude-mythos-5*` | 1 000 000 |
| `claude-opus-5*`, `claude-opus-4-8*`, `claude-opus-4-7*`, `claude-opus-4-6*` | 1 000 000 |
| `claude-sonnet-5*`, `claude-sonnet-4-6*` | 1 000 000 |
| `claude-haiku-4-5*` | 200 000 |

The table exists because the id alone is otherwise undecidable: no
`message.model` in a real transcript carries the `[1m]` suffix, and the `model`
attachment that does is written when a model is *selected*, so a switch later
in a long session leaves a stale one looking current. Without the table a
`claude-fable-5-1` session — 1M, no suffix, well under 200k used — was reported
as 49% full while Claude Code's own status line said 10%.

Rule 4 uses the *prompt* — `input + cacheCreation + cacheRead` — not the prompt
plus the reply. Testing the sum would put a discontinuity exactly where it
hurts: a session sitting at 97% of 200k would be re-read as 20% of 1M the
moment one longer reply carried the sum over the line, turning "nearly full"
into "plenty of room" as it filled up.

Two consequences of rule 5, both deliberately on the cautious side. A 1M
session on an unknown model, still under 200k with no attachment to prove it,
is measured against 200 000 and reads as fuller than it is; that corrects
itself the moment the prompt passes 200k. And a 200k session whose reply
carries the total just past the window reports 100% with a total slightly above
it — which is what being full looks like.

The table is a cached fact, so it ages. When it is wrong, `CLAUDE_CONTEXT_WINDOW`
is the immediate escape hatch, and **Claude Code's own status line is
authoritative** over this tool.

**Right after a `/compact`** the newest turn on record predates the compaction
and describes a context that no longer exists. When the compact boundary is
newer than the last turn, its `compactMetadata.postTokens` is reported instead,
so the tool does not answer "100% used" to "did the compact work?". Such a
report has a `total` but no token breakdown, which is visible from
`compactedAt` being later than `lastMessageAt`.

**`truncated`** is true when the transcript was too large to read whole. Only
a bounded head and tail are read, and the tail grows until it actually holds
recent turns — a single transcript line can exceed a megabyte, and a fixed
window landing inside one would otherwise leave the report quietly describing
session start. Token counts are therefore sound; what a truncated read can miss
is anything found by *scanning*, which is why `compactedAt` is only meaningful
when `truncated` is false.

**`lastTurnTokens`** is the growth since the previous turn, and goes negative
across a `/compact`. It is `null` when the previous turn fell in the unread
middle: head and tail are not consecutive, and diffing across the gap would
measure the whole skipped stretch and call it one turn.

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
  `session_id` when it matters. Transcripts holding no turn at all are skipped
  rather than failing the lookup: an idle session started later takes the top
  of the mtime order without ever being the caller.
- `sessionMatch` says which of those happened: `cwd` for the caller's own
  project folder, `explicit` when asked for by id or path, and `fallback` when
  the working directory had no folder of its own. A `fallback` report may
  describe an unrelated project's session, so the text line labels it and
  `get_usage` leaves it out of its context line entirely rather than passing
  someone else's numbers off as yours.
- The transcript format is Claude Code's, not ours, and is undocumented. Only
  a handful of fields are read, and `get_usage` degrades silently to its quota
  numbers if any of this breaks.

## License

MIT
