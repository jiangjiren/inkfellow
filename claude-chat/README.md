# inkfellow AI Service (`claude-chat`)

`claude-chat` is the local AI backend and embedded panel used by inkfellow. It serves a static chat UI, streams agent events over WebSocket, keeps local history and provider profiles, runs scheduled jobs, and can connect the active agent to WeChat.

It supports two native subscription runtimes:

- Claude through `@anthropic-ai/claude-agent-sdk` and the current user's Claude Code login.
- Codex through `@openai/codex-sdk` and the current user's Codex/ChatGPT login.

Anthropic-compatible API providers are routed through the Claude runtime with provider-specific environment settings.

## Requirements

- Node.js 20.9 or newer when used with the main inkfellow project
- npm
- A vault directory
- Claude Code and/or Codex login if using subscription accounts

## Standalone Setup

```bash
cd claude-chat
npm ci
cp .env.example .env
npm start
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
npm.cmd start
```

Minimal `.env`:

```dotenv
HOST=127.0.0.1
PORT=8082
VAULT_PATH=/absolute/path/to/your/vault
CLAUDE_PERMISSION_MODE=auto
```

Open <http://127.0.0.1:8082> to inspect the standalone panel. In the main app, Next.js exposes it at `/notes-claude/` and proxies WebSocket traffic to this port.

## Provider Authentication

### Claude subscription

Install Claude Code and log in as the same OS user that runs this service. If needed, start `claude` and use its `/login` command. Verify the result with:

```bash
claude auth status
```

The service uses the Claude Agent SDK default credential discovery. Credentials may be stored in the system keychain, so checking only `~/.claude/.credentials.json` is not reliable. Do not set a third-party `ANTHROPIC_BASE_URL` in the service environment when the Claude subscription profile should use the official login.

### Codex / ChatGPT subscription

Log in through Codex Desktop or the CLI as the service user:

```bash
codex login
```

The service exposes the Codex profile when `auth.json` in `CODEX_HOME` (default `~/.codex`) contains usable login data. The model picker and fallback chains use the account's Codex model catalog. Successful catalog lookups are cached for five minutes, and the service reuses the last successful catalog during temporary failures. Codex conversations use persistent thread IDs and map inkfellow permission modes to Codex sandbox modes.

### API providers

Add accounts from the panel settings:

| Provider | Default endpoint behavior |
| --- | --- |
| Anthropic | Official Anthropic API; API key required. |
| DeepSeek | Anthropic-compatible DeepSeek endpoint and preset model mapping. |
| OpenRouter | OpenRouter Anthropic-compatible endpoint and configurable model mapping. |
| MiniMax | MiniMax Anthropic-compatible endpoint and preset model mapping. |
| Custom | User-supplied Anthropic-compatible base URL, key, and model mapping. |

Profiles can be added, edited, activated, and removed in the UI. Claude is always retained as a built-in profile; Codex is injected when a login is available. Exact model IDs come from the current profile instead of being fixed by this README.

## Agent Controls

The panel supports:

- Model selection and provider-specific reasoning/effort levels.
- Unlimited Codex web runs by default. After three silent minutes the panel shows a non-blocking progress notice; after fifteen it offers `Continue waiting` and `Stop task`, but never cancels automatically.
- `plan`, `acceptEdits`, `auto`, and `bypassPermissions` modes.
- Streaming text, thinking, tool use/results, cost/usage events, and interactive questions.
- New, resume, rename, and delete operations for locally stored conversations.
- Image attachments. Codex attachments are materialized as temporary local image files before SDK submission.
- Skills discovered from the current user's Claude or Codex skill directories and the vault-local skill directories.

Permission behavior is provider-specific. `bypassPermissions` is the broadest mode and should be enabled only in a trusted, single-user environment.

## Fellow

Open **✦ Fellow** in the chat header to plan work and delegate it to background Workers. Use **任务** to create a ticket manually, filter tickets, open a Worker's conversation, send follow-up instructions, stop or retry work, and archive finished tickets.

Each ticket has its own conversation and persists under `CLAUDE_CHAT_DATA_DIR/tickets/<PORT>`, matching the conversation log's instance boundary. Workers with non-overlapping write scopes can run concurrently. Overlapping scopes queue until the worker holding the lock exits. A ticket without an explicit scope reserves the vault's write scope. Refreshing or switching conversations leaves the work running. After a service restart, interrupted work can be reviewed and retried from the board.

Fellow and its Workers use Claude or a configured Claude-compatible profile. Workers operate on vault files through scoped tools. The chat service retains its existing Codex, Antigravity, and WeChat routes for ordinary conversations.

## Scheduled Jobs

The built-in scheduler supports cron jobs and future one-off jobs. A job can:

- Add its result to chat history.
- Ask the agent to create a dated Markdown note.
- Ask the agent to append to a specified note.
- Deliver a result back to the source channel.

The chat agent receives scheduler tools when the request looks like a reminder or automation request. REST clients can also manage jobs through `/api/cron/jobs`.

Cron time zones are stored per job and default to `Asia/Shanghai`. One-off times use a future Unix timestamp in milliseconds. Schedules, state, and run logs live in `CLAUDE_CHAT_DATA_DIR`.

Regular WeChat conversations and scheduled jobs prefer Antigravity when its Gemini models are available, with `gemini-4-hydrogen` first when listed. Codex and Claude follow in that order. WeChat requests that need the in-process scheduler tools still skip Antigravity and Codex because neither can receive that ephemeral MCP server. Each run rebuilds its candidate chain from the currently configured provider profiles and model fields. If a candidate is unavailable, returns no content, or its credentials are rejected, the service tries the next candidate; errors from the task itself are never retried on another model.

Each scheduled-job candidate gets up to five minutes. A timeout aborts that candidate and moves to the next provider; the chain has a ten-minute total budget, so it will not keep trying indefinitely.

At present, WeChat is the only registered external delivery adapter. References in source comments to Feishu or Telegram are extension points, not implemented channels.

## WeChat Connection

The settings panel can start a QR-code login flow. After confirmation, the service stores the bot token locally, starts a background polling loop, and can receive and send text or media messages. Scheduled tasks created from a WeChat conversation can deliver results to the originating peer.

WeChat state and downloaded media are stored below `CLAUDE_CHAT_DATA_DIR`. Treat the bot configuration as a credential. The integration depends on the configured Tencent iLink endpoints and should not be exposed as an unauthenticated public API.

## Configuration

While a web-chat reply is running, new messages enter a visible pending queue above the composer. Edit, delete, or reorder them before dispatch; images, quoted text, and file references stay attached. Claude also offers an explicit immediate follow-up action. Pending queues are scoped to a conversation and saved in the current browser tab's session storage, so refreshing that tab preserves them; they do not sync across devices. Only dispatched messages enter chat history. Switching conversations retains the previous conversation's queue and processes it when you return; `/clear` removes the current conversation's pending messages.

Account settings group subscriptions and API accounts, display reported plan names and expired-login states, and collapse model mappings under advanced settings when adding an account. Quota-query failures do not by themselves imply that login has expired.

Antigravity is available as a managed account in the web chat account picker. Install and log in to `agy` as the same operating-system user that runs this service. The CLI must expose `--output-format`, `--mode`, and `--effort` in `agy --help`; upgrade older installations with `agy update`. `GET /api/agy/models` checks compatibility and discovers models and supported reasoning levels. A readable model catalog indicates CLI availability, not a guarantee that a model request will succeed.

Antigravity supports streaming text, tool cards, image attachments, per-conversation continuation, persistent history, reconnect recovery, and cancellation. Account settings show separate Gemini and Claude/GPT quota pools from the CLI's `/usage` command. Catalog results are cached for six hours and quota results for four minutes; failed catalog checks retry after a minute. It also participates in the WeChat and scheduled-job fallback chains. The default is `gemini-4-hydrogen` when available; selections for retired models such as `gemini-3.1-pro` fall back to the current catalog, preferring Hydrogen. Supported reasoning levels, including `xhigh`, come from that catalog.

For Antigravity, plan mode uses the CLI's `plan` mode; other modes use `accept-edits`. The CLI sandbox remains enabled unless the user selects `bypassPermissions`, which explicitly auto-approves tools. Operations requiring interactive approval may be refused by the CLI in headless mode. Images and long prompts use private temporary files, deleted after the turn. Stopping a turn terminates its process group; disconnecting the browser keeps the turn running and records events for recovery.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listener address. Keep loopback unless another trusted network layer protects the service. |
| `PORT` | `8082` | HTTP and WebSocket port. |
| `VAULT_PATH` | process working directory | Default and maximum allowed agent working directory. |
| `CLAUDE_PERMISSION_MODE` | `auto` | Initial permission mode: `plan`, `acceptEdits`, `auto`, or `bypassPermissions`. |
| `CLAUDE_CHAT_DATA_DIR` | `claude-chat/data` | Sessions, history, schedules, run logs, WeChat state, media, and Codex thread data. |
| `CLAUDE_CHAT_AUTH_PROFILE_FILE` | `claude-chat/auth-profile.json` | Provider profiles and API keys. |
| `CLAUDE_CHAT_HISTORY_FILE` | `<data dir>/history-<port>.json` | Optional override for the conversation history file. |
| `CODEX_STREAM_STALL_MS` | `0` (disabled) | Optional Codex no-event watchdog in milliseconds. Leave disabled for long-running work. |
| `CODEX_MAX_RUN_MS` | `0` (disabled) | Optional Codex wall-clock watchdog in milliseconds. Leave disabled for long-running work. |
| `AGY_BIN` | `agy` from PATH or the user installation directory | Antigravity CLI executable path. |
| `AGY_PRINT_TIMEOUT` | `24h` | Antigravity CLI turn time limit (a CLI duration such as `30m` or `24h`). |
| `WECHAT_CDN_BASE_URL` | Tencent CDN URL | Override for WeChat media downloads. |
| `WECHAT_MAX_INLINE_IMAGE_BYTES` | `5242880` | Maximum image size embedded directly into an agent request. |
| `WECHAT_MAX_MEDIA_BYTES` | `26214400` | Maximum inbound or outbound WeChat media size. |
| `WECHAT_MAX_TEXT_CHARS` | `1800` | Maximum text length per outbound WeChat message chunk. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | empty | Optional inherited credentials for the default Claude runtime. UI profiles are preferred for multiple accounts. |
| `ANTHROPIC_BASE_URL` and model variables | provider/runtime defaults | Optional inherited Claude-compatible runtime overrides. Avoid stale global overrides when switching UI profiles. |

`CLAUDE_CHAT_SESSION_FILE` is not a runtime setting in the current server implementation; session state is stored under `CLAUDE_CHAT_DATA_DIR` using the service port. Use `CLAUDE_CHAT_HISTORY_FILE` only when conversation history must live at a custom path.

## Local Data

Default runtime files include:

```text
claude-chat/auth-profile.json       provider profiles and API keys
claude-chat/data/history-<port>.json
claude-chat/data/session-<port>.json
claude-chat/data/codex-thread-<port>.json
claude-chat/data/schedules-<port>.json
claude-chat/data/schedules-state-<port>.json
claude-chat/data/runs/               scheduler run logs
claude-chat/data/wechat-*            WeChat credentials, sync state, history, and media
```

These paths are ignored by the repository's `.gitignore`. Keep them private, include them deliberately in backups, and protect backups at rest.

## HTTP and WebSocket Surface

The service exposes the panel and a small local API:

| Path | Purpose |
| --- | --- |
| `/` and static files | Embedded chat UI. |
| `/api/health/claude-auth` | Claude CLI login status. |
| `/api/health/codex-auth` | Codex login status. |
| `/api/codex/models` | Available Codex models, default model, and supported reasoning efforts. |
| `/api/usage-limits` | Best-effort Claude/Codex subscription usage windows. |
| `/api/auth-profile` | Read and manage provider profiles. Secret values are masked in GET responses. |
| `/api/history` | List and manage local conversation history. |
| `/api/cron/jobs` | List, create, enable/disable, and delete scheduled jobs. |
| `/api/cron/jobs/once` | Create a future one-off job. |
| `/api/wechat/*` | WeChat status, QR login, polling, and logout. |
| WebSocket upgrade | Agent messages, streaming events, cancellation, and interactive question responses. |

This API is designed for the local inkfellow UI, not as a hardened public service.

## Reverse Proxy

For local development, the main Next.js app handles `/notes-claude/*` through its built-in rewrite.

For production, `deploy/nginx.conf.example` proxies `/notes-claude/` directly to this service and includes the required WebSocket headers. The trailing slash in `proxy_pass http://127.0.0.1:8082/` strips the public prefix before forwarding.

Recommended boundaries:

- Bind this service to `127.0.0.1`.
- Require authentication at Nginx or another trusted gateway.
- Preserve `Upgrade` and `Connection` headers.
- Use long read/send timeouts for agent streams.
- Run the process as the same user that owns the selected subscription credentials and vault.

## Development and Checks

```bash
npm ci
node --check server.js
node --check scheduler.js
npm test
npm start
```

`npm test` runs the isolated Node test suite. The server tests reserve temporary ports and data directories so they do not touch the production instances or credentials.

From the repository root, `node --test tests/git-sync.test.mjs` verifies sync conflict protection with temporary local Git repositories. Scheduler intent tests cover authored instructions versus attached note context; conversation preference tests cover switching, reloads, legacy histories, and removed accounts.

## Security Checklist

- Never commit `.env`, `auth-profile.json`, `data/`, OAuth files, chat history, or API keys.
- Do not bind to a public interface without a separate authenticated gateway.
- Keep `VAULT_PATH` as narrow as possible. Requested working directories are resolved and constrained below it.
- Use `plan` or `acceptEdits` for cautious deployments; reserve `auto` and especially `bypassPermissions` for trusted users.
- Isolate `CLAUDE_CHAT_DATA_DIR`, profile files, ports, and Unix users when running more than one instance.
- Remember that chat and schedule logs may contain private note excerpts even when no API keys are present.

## Troubleshooting

- **Claude shows logged out:** run `claude auth status` as the exact service user and check its `HOME` and keychain access.
- **Codex profile is missing:** complete `codex login` as the service user and confirm that `~/.codex/auth.json` exists.
- **A long Codex task looks quiet:** the web run has no automatic deadline by default. Keep waiting or stop it from the long-run notice; check `CODEX_*_MS` only if an operator intentionally configured a watchdog.
- **Panel loads but streaming fails:** preserve WebSocket upgrade headers and make the configured frontend port match the service port.
- **Agent cannot see the vault:** use an absolute `VAULT_PATH` and verify filesystem permissions for the service user.
- **A stale provider endpoint is used:** remove inherited `ANTHROPIC_*` overrides from the process manager, then restart and activate the intended UI profile.
- **Schedules disappear between restarts:** verify that `CLAUDE_CHAT_DATA_DIR` is writable and persistent.
