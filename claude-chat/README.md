# inkfellow — AI Chat Service

Small Node.js and WebSocket service that embeds a Claude Agent SDK assistant beside the inkfellow notes UI.

## Setup

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm start
```

Required environment:

```bash
VAULT_PATH=/absolute/path/to/your/vault
```

## Authentication

The default account source is the Claude subscription credential on the server:

1. Use a Claude Pro, Max, Team, or Enterprise account.
   Complete Claude Code login once on the same machine and under the same system user that runs this service.

   ```bash
   npm install -g @anthropic-ai/claude-code
   claude /login
   ```

   After login, confirm the local credential exists:

   ```bash
   ls ~/.claude/.credentials.json
   ```

   Do not set `ANTHROPIC_API_KEY` if you want subscription credentials to be used. Also make sure your process manager uses the same user and home directory. For example, if `claude /login` was run as `youruser`, then PM2 or systemd should run `claude-chat` as `youruser` with `HOME=/home/youruser`.

2. Optional DeepSeek API Key: open the Claude panel, click `设置`, choose `DeepSeek API Key`, enter the key, and save. The next message will use DeepSeek's Anthropic-compatible endpoint. Switch back to `Claude 会员额度` to use the server's Claude subscription credential again.

3. Optional OpenRouter API Key: open `设置`, choose `OpenRouter API Key`, enter the key, and keep or adjust the model mapping fields:
   - `Opus 模型`, default `~anthropic/claude-opus-latest`
   - `Sonnet 模型`, default `~anthropic/claude-sonnet-latest`
   - `Haiku 模型`, default `~anthropic/claude-haiku-latest`
   - `Subagent 模型`, default `~anthropic/claude-opus-latest`

   The OpenRouter base URL is fixed to `https://openrouter.ai/api`.

The chat service uses the Claude Agent SDK default runtime. No extra executable-path setting is required.

The service listens on `127.0.0.1:8082` by default. Put it behind Nginx at `/notes-claude/` and protect that location with the same authentication as `/notes`.

## Security Notes

- Default permission mode is `auto`.
- Supported permission modes are `plan`, `acceptEdits`, `auto`, and `bypassPermissions`.
- `bypassPermissions` is supported for trusted single-user deployments, but should only be used behind strong authentication.
- Requested working directories are constrained to `VAULT_PATH`.
- Static files are served only from `public/`.
- `auth-profile.json` stores provider settings and may contain API keys. Do not commit it.
- `session.json` and `history.json` may contain private content and should not be committed.
