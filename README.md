# Notes App

English | [中文](./README.zh-CN.md)

Turn your Markdown folder into a cloud-accessible personal knowledge base — **browse, organize, sync, and share** from any device, anywhere. The built-in AI Agent panel works as an **LLM Wiki**: AI reads and understands every note you've written, so you can ask questions and get answers grounded in your own knowledge.

Supports **Claude Pro/Teams subscriptions** (no API key needed), **DeepSeek**, **OpenRouter** (200+ models), and any Anthropic-compatible API — swap providers anytime from the UI.

---

## What is an LLM Wiki?

With ordinary note tools, the workflow is: **write → search → scroll → find**. Most of what you write gets forgotten over time.

**LLM Wiki** changes that to: **write → just ask**.

Every note you write becomes part of the AI's memory. Whatever you want to find or work on, just ask in plain language:

> "What was the core idea in that project plan I wrote last month?"  
> "Expand this reading note into a full article."  
> "How does this note connect to my other thoughts on XX?"

The AI answers based on **your own content** — not generic knowledge. Your note folder stops being a pile of files and becomes a **personal knowledge assistant that actually knows what you've written**.

---

## AI Agent Integration

The AI panel is embedded directly inside the notes interface — no tab switching, no copy-pasting.

- **Select text → auto-quote**: Highlight any passage in a note and it appears instantly in the AI chat as a quoted reference.
- **Note context awareness**: The AI knows which note you are reading and can discuss it directly.
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

## Live Demo (Vercel)

The repo includes a `vault/` sample knowledge base so you can deploy a working demo to Vercel instantly.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jiangjiren/clawapp)

After deploying, go to Vercel → Project → Settings → **Environment Variables** and add:

| Variable | Value | Notes |
|----------|-------|-------|
| `NOTES_BASIC_AUTH_USERNAME` | `demo` (or anything) | Login username for the demo |
| `NOTES_BASIC_AUTH_PASSWORD` | your chosen password | Login password — **must not be empty** |
| `NEXT_PUBLIC_APP_NAME` | `Notes App Demo` | Shown in the page title |
| `SITE_URL` | your Vercel URL (e.g. `https://xxx.vercel.app`) | Used for share link generation |

> **Note**: The Vercel version uses the bundled `vault/` sample notes and does not support Git sync or the AI panel (both require a persistent server environment). Deploy to a VPS for full functionality.

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

# ↓ These two lines are your login credentials for the knowledge base
NOTES_BASIC_AUTH_USERNAME=notes     # Username — change to anything you like
NOTES_BASIC_AUTH_PASSWORD=change-me # Password — must not be left empty
```

Build and start the notes app:

```bash
npm run build
npm start            # runs on http://localhost:3000
```

Open `http://localhost:3000` in your browser. A login prompt will appear — enter the username and password you set in `.env.local`.

> **Where does the login account come from?** There is no registration. The credentials are exactly what you put in `NOTES_BASIC_AUTH_USERNAME` and `NOTES_BASIC_AUTH_PASSWORD`. Change either value and restart the service to update your credentials.

### Enabling the AI Panel

The AI panel loads from `/notes-claude/`, which is served by a separate Node.js process in the `claude-chat/` directory.

```bash
cd claude-chat
npm install
npm start            # runs on http://127.0.0.1:8082 by default
```

Then configure your reverse proxy (Nginx) to forward `/notes-claude/` to `127.0.0.1:8082`. A template is provided in `deploy/nginx.conf.example`.

Once running, click the **✦ AI** button in the notes toolbar to open the panel, then connect your provider from the settings icon.

## Syncing Your Local Obsidian Vault

The app has a built-in Git panel (pull / push / discard / history). To keep your local Obsidian in sync with the server, pick one of the two methods below.

### Method A: Self-hosted bare repo on the server (no external service)

This keeps everything on your own machine. A *bare repository* acts as the central hub — local Obsidian pushes to it, the server pulls from it.

```
Local Obsidian ──push──▶ bare repo on server ◀──pull── Notes App (working dir)
                         /home/you/git/vault.git
```

**1. Create the bare repo on the server**

```bash
mkdir -p ~/git
git init --bare ~/git/my-vault.git
```

**2. Clone it as the working vault**

```bash
git clone ~/git/my-vault.git ~/vault
# then set VAULT_PATH=~/vault in .env.local
```

**3. Authorise your local machine via SSH**

On your local computer, generate an SSH key if you don't have one:

```bash
ssh-keygen -t ed25519 -C "obsidian-local"
```

Copy the public key to the server (you'll be prompted for the server password once):

```bash
ssh-copy-id user@your-server.com
```

Verify it works without a password:

```bash
ssh user@your-server.com   # should log in directly
```

**4. Add the server as the remote on your local vault**

```bash
cd /path/to/local/obsidian-vault
git init                   # skip if already a git repo
git remote add origin ssh://user@your-server.com/home/you/git/my-vault.git
git pull origin main
```

**5. Install the Obsidian Git plugin**

In Obsidian → Settings → Community plugins → search **Obsidian Git**, install and enable it. Recommended settings:
- *Auto pull interval*: `10` (minutes)
- *Auto push interval*: `5` (minutes)

After each push, open the Git panel in Notes App and click **Pull** to update the working vault.

---

### Method B: GitHub private repo (easiest, works from any machine)

```
Local Obsidian ──push──▶ GitHub private repo ◀──pull── Notes App on server
```

**1. Push your local vault to GitHub**

Create a private repo on GitHub, then in your local vault:

```bash
git init
git remote add origin https://github.com/yourname/my-vault.git
git add . && git commit -m "init"
git push -u origin main
```

**2. Clone it on the server**

```bash
git clone https://github.com/yourname/my-vault.git ~/vault
# set VAULT_PATH=~/vault in .env.local
```

**3. Store a GitHub Personal Access Token on the server**

Generate a token at GitHub → Settings → Developer settings → Personal access tokens (classic), scope: `repo`.

```bash
# on the server, let git remember the token permanently
git config --global credential.helper store

cd ~/vault
git pull   # enter your GitHub username + token when prompted; stored after that
```

Or embed the token directly in the remote URL:

```bash
git remote set-url origin https://yourname:YOUR_TOKEN@github.com/yourname/my-vault.git
```

**4. Install the Obsidian Git plugin** (same as Method A, step 5)

After each push, open the Git panel in Notes App and click **Pull**.

---

### Sync flow summary

| Action | What to do |
|--------|-----------|
| Wrote notes locally | Obsidian Git auto-pushes → click **Pull** in Notes App |
| Edited notes on the web | Click **Push** in Notes App → Obsidian Git auto-pulls |
| Want automatic server pull | Add a cron job: `*/10 * * * * cd ~/vault && git pull` |

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
| `NOTES_BASIC_AUTH_USERNAME` | Yes | `notes` | Login username for the knowledge base. |
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
2. **Nginx** proxies traffic: `/` and `/share` → port 3000; `/notes-claude/` → port 8082 — see `deploy/nginx.conf.example`.

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

- The root `/` and `/api/notes/*` require Basic Auth — the entire knowledge base is private by default.
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
