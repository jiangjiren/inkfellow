# Notes App

English | [中文](./README.zh-CN.md)

Turn your Markdown folder into a cloud-accessible personal knowledge base — **browse, organize, sync, and share** from any device, anywhere — with a **built-in AI Agent panel** that lets you select any text and instantly bring it into a conversation.

Supports **Claude Pro/Teams subscriptions** (no API key needed), **DeepSeek**, **OpenRouter** (200+ models), and any Anthropic-compatible API — swap providers anytime from the UI.

---

## AI Agent Integration

The AI panel is embedded directly inside the notes reader — no tab switching, no copy-pasting.

- **Select text → auto-quote**: Highlight any passage in a note and it appears instantly in the AI chat as a quoted reference.
- **Note context awareness**: The AI knows which note you are reading.
- **Resizable side panel**: Drag to adjust width; collapses to a floating button on mobile.
- **Persistent sessions**: Conversation history is preserved across page reloads.

### Supported Providers

| Provider | How to connect | Models |
| --- | --- | --- |
| **Claude (Official)** | Log in with your Anthropic account — no API key required | Claude Opus / Sonnet / Haiku (latest) |
| **DeepSeek** | Paste your DeepSeek API key | DeepSeek V4 Pro, V4 Flash |
| **OpenRouter** | Paste your OpenRouter API key | 200+ models (GPT-4o, Gemini, Llama…) |
| **Custom** | Any provider with an Anthropic-compatible API — set base URL + API key | Your choice |

You can add multiple accounts and switch between them from the settings panel at any time.

The AI backend is a lightweight Node.js service that runs alongside the notes app and uses the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

---

## Other Features

- Browse `.md`, `.html`, and `.htm` files from a local vault.
- Render Markdown with GFM, table of contents, and Obsidian-style local images.
- Protect the private notes UI and APIs with Basic Auth.
- View Git status, diffs, commit history, and run pull / push / discard actions.
- Create tokenized public share links under `/share/:token`.

## Requirements

- Node.js 20 or newer.
- npm.
- A local Markdown vault (any folder with `.md` files; Obsidian format works best).

## Quick Start

```bash
git clone <this-repo> notes-app
cd notes-app
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```bash
NEXT_PUBLIC_APP_NAME=My Notes       # Shown in the UI and page titles
VAULT_PATH=/absolute/path/to/vault  # Your Markdown folder
SITE_URL=http://localhost:3000      # Replace with your domain or public IP
NOTES_BASIC_AUTH_USERNAME=notes
NOTES_BASIC_AUTH_PASSWORD=change-me # Pick a strong password
```

Build and start the notes app:

```bash
npm run build
npm start            # runs on http://localhost:3000
```

Open `http://localhost:3000/notes` in your browser and log in.

### Enabling the AI Panel

The AI panel loads from `/notes-claude/`, which is served by a separate Node.js process in the `claude-chat/` directory.

```bash
cd claude-chat
npm install
npm start            # runs on http://127.0.0.1:8082 by default
```

Then configure your reverse proxy (Nginx) to forward `/notes-claude/` to `127.0.0.1:8082`. A template is provided in `deploy/nginx.conf.example`.

Once running, click the **✦ AI** button in the notes toolbar to open the panel, then connect your provider from the settings icon.

## Access Without a Domain (Public IP)

No domain? No problem. Set `SITE_URL` to your server's public IP:

```bash
SITE_URL=http://203.0.113.42        # via Nginx on port 80
# or
SITE_URL=http://203.0.113.42:3000   # direct Next.js, no Nginx
```

For direct access without Nginx, open port `3000` in your firewall:

```bash
# CentOS / RHEL / AlmaLinux (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# Ubuntu / Debian (ufw)
sudo ufw allow 3000/tcp
```

The app works identically over IP — share links will include the IP in the URL.

## Environment Variables

### Notes App (`clawapp/`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | No | `My Notes` | App name shown in UI and page titles. |
| `VAULT_PATH` | Yes | `./vault` | Absolute path to the Markdown vault. |
| `NOTES_BASIC_AUTH_USERNAME` | Yes | `notes` | Username for `/notes` and `/api/notes/*`. |
| `NOTES_BASIC_AUTH_PASSWORD` | Yes | *(empty)* | Password. If empty, access is always denied. |
| `SHARED_NOTES_PATH` | No | `./shared-notes.json` | JSON file for share tokens. |
| `SITE_URL` | No | `http://localhost:3000` | Public base URL for share links (domain or IP). |
| `NOTES_GIT_PUSH_TARGET` | No | `HEAD:main` | Git refspec used by the push action. |
| `NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN` | No | *(empty)* | Enables Cloudflare Web Analytics. |

### AI Service (`claude-chat/`)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8082` | Port the AI service listens on. |
| `VAULT_PATH` | *(cwd)* | Working directory for the AI agent. |
| `CLAUDE_PERMISSION_MODE` | `auto` | Agent permission mode: `plan`, `acceptEdits`, `auto`, `bypassPermissions`. |
| `ANTHROPIC_API_KEY` | *(empty)* | Optional default API key (users can also set keys in the UI). |
| `ANTHROPIC_BASE_URL` | *(empty)* | Optional custom API base URL for self-hosted or third-party providers. |

## Scripts

```bash
# Notes app
npm run dev      # local development (hot reload)
npm run build    # production build
npm start        # run the built app

# Share link CLI
node scripts/create-share-link.mjs "path/in/vault/note.md"
```

## Production Deployment

A typical production setup:

1. **systemd** keeps both processes running — see `deploy/notes-app.service.example`.
2. **Nginx** proxies traffic: `/notes` and `/share` → port 3000; `/notes-claude/` → port 8082 — see `deploy/nginx.conf.example`.

```bash
# Install and enable the notes service
sudo cp deploy/notes-app.service.example /etc/systemd/system/notes-app.service
# Edit the file: set User, WorkingDirectory, EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now notes-app
```

For HTTPS with a real domain:

```bash
sudo apt install certbot python3-certbot-nginx   # Debian/Ubuntu
sudo certbot --nginx -d your-domain.com
```

To update after pulling new code:

```bash
SERVICE_NAME=notes-app bash scripts/update_app.sh
```

## Security Model

- Private routes `/notes` and `/api/notes/*` require Basic Auth.
- `/notes-claude/` should also be protected — the Nginx example includes Basic Auth for this route.
- Public share routes are tokenized and read-only.
- Vault reads are restricted to `VAULT_PATH`; `.git`, `.obsidian`, `.claude`, `.claudian`, and `node_modules` are excluded.
- Git commands are executed without a shell and validate user-supplied paths.

## Repository Hygiene

Do not commit:

- `.env.local` or any `.env*` file (already in `.gitignore`).
- `shared-notes.json` if it contains real share tokens (already in `.gitignore`).
- `claude-chat/auth-profile.json` and `claude-chat/session.json` — these hold your AI provider credentials.
- `.next/`, `node_modules/`, vault contents, or generated media.
