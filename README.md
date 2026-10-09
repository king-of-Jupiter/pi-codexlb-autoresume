# pi-codexlb-autoresume

**English** | [Русский](./README.ru.md)

A [pi](https://github.com/badlogic/pi-mono) / [oh-my-pi](https://github.com/can1357/oh-my-pi)
extension: auto-pause and auto-continue agents on
[codex-lb](https://github.com/Soju06/codex-lb) credit limits.

The plugin polls the balancer's usage endpoint (`limits[]`, `5h`/`7d` windows)
and injects messages into the same session:

- remaining credit drops below the pause line → a pause message goes out as
  **steer** (interrupts the running turn): save your work and wait;
- credit refills above the resume line → a resume message goes out and the
  agent continues where it stopped.

There is no widget and no `/limits` command here — display belongs to the
companion [pi-codexlb-usage](https://github.com/king-of-Jupiter/pi-codexlb-usage)
(both install side by side with no conflicts). This plugin owns only the
`/autoresume` command.

It also works inside [Paseo](https://paseo.sh): the `omp` provider launches
`omp --mode rpc` with extensions enabled, and extension-queued messages are
supported. Requirements: the extension installed in daemon scope
(`~/.omp/agent/extensions/` of the daemon user), and `CODEXLB_URL` /
`CODEXLB_TOKEN` visible to the daemon process.

## Install

**oh-my-pi**

```sh
omp install git:github.com/king-of-Jupiter/pi-codexlb-autoresume
```

Manual alternative:

```sh
git clone https://github.com/king-of-Jupiter/pi-codexlb-autoresume.git
omp plugin link ./pi-codexlb-autoresume
```

npm variant (requires `bun` in PATH):

```sh
omp install npm:pi-codexlb-autoresume
```

**pi**

```sh
git clone https://github.com/king-of-Jupiter/pi-codexlb-autoresume.git
```

Or copy `index.ts` + `src/` + `hooks/` to
`~/.pi/agent/extensions/pi-codexlb-autoresume/` (pi) or
`~/.omp/agent/extensions/pi-codexlb-autoresume/` (omp).

Zero dependencies. Requires Node 22+ (the host executes TypeScript directly).

## Configure

Minimum — endpoint and token (shared with pi-codexlb-usage; read from its file
when configured):

```sh
export CODEXLB_URL="https://example.com/api/usage"
export CODEXLB_TOKEN="<bearer-token>"
```

or inside a session:

```
/autoresume set-url https://example.com/api/usage
/autoresume set-token <token>
```

Thresholds are **remaining** percent. Defaults: pause when remaining `< 10%`,
resume when remaining `> 30%` (hysteresis is mandatory: resume always stays
above pause).

| Variable | Purpose | Default |
|---|---|---|
| `CODEXLB_URL` (`CODEXLB_USAGE_URL`) | Usage endpoint | — |
| `CODEXLB_TOKEN` (`CODEXLB_BEARER_TOKEN`) | Bearer token | — |
| `CODEXLB_LABEL` | Source label | `CodexLB` |
| `AUTORESSUME_ENABLED` | `1`/`0` master switch | `1` |
| `AUTORESSUME_PAUSE_PCT` | Pause line (remaining %) | `10` |
| `AUTORESSUME_RESUME_PCT` | Resume line (remaining %) | `30` |
| `AUTORESSUME_POLL_MS` | Poll interval (minimum 15000) | `60000` |
| `AUTORESSUME_WATCH` | `any` — worst of the windows; or `5h`, `7d` | `any` |
| `AUTORESSUME_PAUSE_MSG` | Pause text | default (see below) |
| `AUTORESSUME_RESUME_MSG` | Resume text | default |
| `AUTORESSUME_RETRY_ON_ERROR` | Instant retry-on-error | `0` (off) |
| `AUTORESSUME_RETRY_COOLDOWN_SEC` | Cooldown between auto-continues | `120` |
| `AUTORESSUME_RETRY_MAX` | Budget per 30-min window | `3` |
| `AUTORESSUME_CONFIG` | Path to the own config.json | `~/.config/pi-codexlb-autoresume/config.json` |
| `AUTORESSUME_DEBUG` | Debug logs to stderr (no token) | off |

Env wins per-field. Without env, the own file is read; for endpoint/token the
shared pi-codexlb-usage file is additionally consulted. The own file is created
with mode 0600.

Default texts (Russian):

- pause: «У тебя закончились лимиты (Codex LB). Срочно сохрани промежуточный
  результат: что сделано, что осталось, какие файлы изменены. Затем остановись
  и жди моего сообщения — ничего не продолжай сам.»
- resume: «Лимиты восстановлены. Продолжи с места остановки.»

## Retry-on-error

Off by default (enable with `/autoresume retry on`). When the provider returns
a retryable error (HTTP 429/5xx, or rate-limit/overload wording in a failed
turn), the plugin immediately polls the API:

- API says limits remain → sends **the same resume text** at once (the session
  is idle after an error — the turn starts instantly);
- limits are genuinely low → stays silent, the normal pause path handles it;
- API unreachable → stays silent.

Loop protection: 120s cooldown, max 3 triggers per 30 minutes (when exhausted —
a warning to the human only), budget reset by a successful turn. Triggers show
up in `/autoresume status` with their source tag.

While the session is PAUSED, retries never fire — the refill line owns the
resume.

## Commands

| Command | Effect |
|---|---|
| `/autoresume` or `status` | Thresholds, state, poll freshness, retry budget — no secrets |
| `/autoresume toggle` | Enable/disable |
| `/autoresume pause <pct>` | Pause line |
| `/autoresume resume <pct>` | Resume line |
| `/autoresume poll <sec>` | Poll interval (min 15) |
| `/autoresume watch <any\|5h\|7d>` | Which windows to watch |
| `/autoresume retry <on\|off>` | Enable/disable retry-on-error |
| `/autoresume retry-cooldown <sec>` | Retry cooldown |
| `/autoresume retry-max <n>` | Retry budget per 30 min |
| `/autoresume msg-pause <text>` | Custom pause text |
| `/autoresume msg-resume <text>` | Custom resume text |
| `/autoresume set-url <url>` | Save endpoint and poll |
| `/autoresume set-token <token>` | Save token (0600) and poll |
| `/autoresume config` | Config files, field sources, masked token |
| `/autoresume test-pause` / `test-resume` | Deliver text without changing state |

## Development

```sh
npm test        # node --test, zero deps
```

Structure:

- `src/autoresume.ts` — pure logic: thresholds, hysteresis, retry budget, error classification
- `src/config.ts` — own config.json (0600) + fallback to the pi-codexlb-usage file for endpoint/token, env wins per-field
- `src/sources/codexlb.ts` — fetch + `limits[]` mapping (a zero-deps port of `server/usage.ts` from paseocodexlbusage)
- `src/extension.ts` — host wiring (events, timers, `/autoresume`)

## Credits

- codex-lb `limits[]` mapping: [king-of-Jupiter/paseocodexlbusage](https://github.com/king-of-Jupiter/paseocodexlbusage).
- Data: [Soju06/codex-lb](https://github.com/Soju06/codex-lb).

MIT
