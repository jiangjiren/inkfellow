# inkfellow

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
| `NEXT_PUBLIC_APP_NAME` | `inkfellow` | Shown in the page title |
| `SITE_URL` | your Vercel URL (e.g. `https://xxx.vercel.app`) | Used for share link generation |

> **Note**: The Vercel version uses the bundled `vault/` sample notes and does not support Git sync or the AI panel (both require a persistent server environment). Deploy to a VPS for full functionality.

## Not a Developer? Let an AI Agent Install It for You

If you're not comfortable with the command line, the easiest path is to hand the job to an AI coding agent — **Claude Code**, **Codex**, **OpenCode**, or any similar tool. Just paste the repository URL and say something like:

> "Please clone this repo and deploy it on my server: `https://github.com/jiangjiren/clawapp`"

The agent will read the README, run the commands, and guide you through the configuration. Most users get a working installation this way without touching a single line of code themselves.

---

## Requirements

- Node.js 20 or newer.
- npm.
- A local Markdown vault (any folder with `.md` files; Obsidian format works best).

On a fresh Ubuntu / Debian VPS, install all prerequisites in one line:

```bash
sudo apt update && sudo apt install -y git nodejs npm nginx
```

> Ubuntu 24.04+ ships Node.js 20+ via `apt`, which already meets the version requirement.

## Quick Start

```bash
git clone <this-repo> notes-app
cd notes-app
npm install
bash scripts/setup-vault.sh   # creates vault + bare git repo, writes VAULT_PATH to .env.local
```

Edit `.env.local`:

```bash
NEXT_PUBLIC_APP_NAME=inkfellow       # Shown in the UI and page titles
VAULT_PATH=/home/you/vault          # Set automatically by setup-vault.sh
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

**Nginx is required for the AI panel.** The chat uses WebSocket for real-time streaming; Nginx must forward both HTTP and WebSocket upgrade requests to port 8082. A ready-to-use template is provided in `deploy/nginx.conf.example`, which includes the `/notes-claude/` block with all required headers.

> **Why 404 on `/notes-claude/`?** If you access the app directly via `:3000` (bypassing Nginx), Next.js has no route for `/notes-claude/` and returns 404. Always go through Nginx (port 80/443) in production.

Generate the AI panel password file (recommended to protect API credits):

```bash
echo "YOUR_USER:$(openssl passwd -apr1 YOUR_PASSWORD)" | sudo tee /etc/nginx/.htpasswd
```

Once running, click the **✦ AI** button in the notes toolbar to open the panel, then connect your provider from the settings icon.

### Connecting an AI Provider

Open the settings panel (⚙ icon) inside the AI panel and pick one of the following:

---

#### Option A — Claude Pro / Teams subscription (no API key)

This uses your existing Claude subscription quota — no extra cost, no API key required.

**1. Install Claude Code CLI on the server**

```bash
npm install -g @anthropic-ai/claude-code
```

**2. Log in with your Anthropic account**

```bash
claude login
# Opens a browser-based OAuth flow.
# Complete the login in your browser; credentials are saved on the server.
```

**3. Verify the login**

```bash
claude auth status
# Should print: "loggedIn": true, "subscriptionType": "pro"
```

**4. In the AI panel settings** — the **Claude** provider row will show ✅ logged in. Select it and start chatting.

> The `claude-chat` service reads the same credentials stored by the CLI. Once logged in, the service works automatically — no restart needed.

---

#### Option B — Anthropic API Key

If you prefer pay-as-you-go billing instead of a subscription:

1. Get a key at [console.anthropic.com](https://console.anthropic.com/) → API Keys.
2. In the AI panel settings → **Add account** → choose **Anthropic** → paste `sk-ant-…`.

---

#### Option C — DeepSeek / OpenRouter / Custom

Add an account in the settings panel and select the corresponding provider. Refer to each provider's website for API key instructions.

## Syncing Your Local Obsidian Vault

The app has a built-in Git panel (pull / push / discard / history). To keep your local Obsidian in sync with the server, pick one of the two methods below.

### Method A: Self-hosted bare repo on the server (no external service, recommended)

This keeps everything on your own machine. A *bare repository* acts as the central hub — local Obsidian pushes to it, the server pulls from it.

```
Local Obsidian ──push──▶ bare repo on server ◀──pull── inkfellow (working dir)
                         ~/git/notes-vault.git
```

> **✅ Already ran `bash scripts/setup-vault.sh`?** The bare repo and working vault were created automatically — the script printed the SSH remote address at the end. Skip steps 1 and 2 below and **jump straight to step 3** to configure your local machine.

**1. Create the bare repo on the server** (skip if you ran setup-vault.sh)

```bash
mkdir -p ~/git
git init --bare ~/git/notes-vault.git
```

**2. Clone it as the working vault** (skip if you ran setup-vault.sh)

```bash
git clone ~/git/notes-vault.git ~/vault
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

After each push, open the Git panel in inkfellow and click **Pull** to update the working vault.

---

### Method B: GitHub private repo (easiest, works from any machine)

```
Local Obsidian ──push──▶ GitHub private repo ◀──pull── inkfellow on server
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

After each push, open the Git panel in inkfellow and click **Pull**.

---

### Sync flow summary

| Action | What to do |
|--------|-----------|
| Wrote notes locally | Obsidian Git auto-pushes → click **Pull** in inkfellow |
| Edited notes on the web | Click **Push** in inkfellow → Obsidian Git auto-pulls |
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

### inkfellow

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | No | `inkfellow` | App name shown in UI and page titles. |
| `VAULT_PATH` | Yes | `./vault` | Absolute path to the Markdown vault. |
| `NOTES_BASIC_AUTH_USERNAME` | Yes | `notes` | Login username for the knowledge base. |
| `NOTES_BASIC_AUTH_PASSWORD` | Yes | *(empty)* | Password. If empty, access is always denied. |
| `SHARED_NOTES_PATH` | No | `./shared-notes.json` | JSON file for share tokens. |
| `SITE_URL` | No | `http://localhost:3000` | Public base URL for share links (domain or IP). |
| `NOTES_GIT_PUSH_TARGET` | No | `HEAD:main` | Git refspec used by the push action. |
| `GIT_COMMIT_USER_NAME` | No | `Inkfellow Web` | Git commit author name for the web "Push to cloud" feature. No global git identity required on the server. |
| `GIT_COMMIT_USER_EMAIL` | No | `web-editor@inkfellow.local` | Git commit author email for the web "Push to cloud" feature. |
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

1. **systemd** keeps both processes running persistently.
2. **Nginx** proxies traffic: `/` and `/share` → port 3000; `/notes-claude/` → port 8082.

```bash
# ── inkfellow (Next.js) ──────────────────────────────────────────
sudo cp deploy/notes-app.service.example /etc/systemd/system/notes-app.service
# Edit: set User, WorkingDirectory, EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now notes-app

# ── AI Chat Service (claude-chat) ────────────────────────────────
sudo cp deploy/claude-chat.service.example /etc/systemd/system/claude-chat.service
# Edit: set User, WorkingDirectory, and VAULT_PATH
sudo systemctl daemon-reload
sudo systemctl enable --now claude-chat

# ── Nginx ────────────────────────────────────────────────────────
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/notes-app
sudo ln -s /etc/nginx/sites-available/notes-app /etc/nginx/sites-enabled/
# Generate the AI panel password file
echo "YOUR_USER:$(openssl passwd -apr1 YOUR_PASSWORD)" | sudo tee /etc/nginx/.htpasswd
sudo nginx -t && sudo systemctl reload nginx
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

## Multi-User Setup

Each user gets their own isolated instance: a separate Next.js process, a separate vault directory, and a separate git repository. They share the same compiled build — no code duplication.

### Step 1 — Create the vault and git repo

```bash
# Working vault
mkdir -p /home/admin/vault/USERNAME-vault

# Bare git repo (for sync/backup, same pattern as the main vault)
git init --bare /home/admin/git/USERNAME-vault.git

# Initialize git in the working vault and make the first commit
cd /home/admin/vault/USERNAME-vault
git init
git remote add origin /home/admin/git/USERNAME-vault.git
git config user.email "USERNAME@inkfellow"
git config user.name "USERNAME"
git checkout -b main
git add .
git commit -m "init: USERNAME vault"
git push -u origin main
```

> Each vault must have its **own** bare repo. Never point two users at the same `.git` remote.

### Step 2 — Add PM2 processes

Edit `ecosystem.config.cjs` and add **two** new entries to the `apps` array — one for the notes app and one for the AI chat backend:

```js
// Notes app
{
  name: "inkfellow-USERNAME",
  script: "node_modules/.bin/next",
  args: "start",
  cwd: "/home/admin/apps/clawapp",   // always use an absolute path, not __dirname
  env: {
    PORT: "3001",                     // pick a free port (3001, 3002, …)
    NODE_ENV: "production",
    VAULT_PATH: "/home/admin/vault/USERNAME-vault",
    NOTES_BASIC_AUTH_USERNAME: "USERNAME",
    NOTES_BASIC_AUTH_PASSWORD: "STRONG_PASSWORD",
  },
  autorestart: true,
  watch: false,
  merge_logs: true,
  out_file: "~/.pm2/logs/inkfellow-USERNAME-out.log",
  error_file: "~/.pm2/logs/inkfellow-USERNAME-error.log",
},
// AI chat backend — must point to this user's own vault
{
  name: "claude-chat-USERNAME",
  script: "server.js",
  cwd: "/home/admin/apps/clawapp/claude-chat",
  node_args: "--env-file-if-exists=.env",
  env: {
    PORT: "8083",                     // pick a free port different from the main claude-chat (8082)
    HOST: "127.0.0.1",
    VAULT_PATH: "/home/admin/vault/USERNAME-vault",
    CLAUDE_PERMISSION_MODE: "auto",
  },
  autorestart: true,
  watch: false,
  merge_logs: true,
  out_file: "~/.pm2/logs/claude-chat-USERNAME-out.log",
  error_file: "~/.pm2/logs/claude-chat-USERNAME-error.log",
},
```

Then start both:

```bash
pm2 start ecosystem.config.cjs --only inkfellow-USERNAME,claude-chat-USERNAME
```

> **Important:** always use absolute paths for `cwd`. Using `__dirname` in `ecosystem.config.cjs`
> causes PM2 to resolve the path relative to the daemon's working directory, not the config file,
> which makes the process unable to find the `.next` build and crash on startup.

> **Each user must have their own `claude-chat` instance** pointing to their own `VAULT_PATH`.
> Sharing one `claude-chat` between users means the AI agent reads the wrong vault.

### Step 3 — Add an Nginx server block

Add a new server block to `/etc/nginx/conf.d/mindflowinsight.conf`:

```nginx
server {
    listen 80;
    server_name USERNAME.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name USERNAME.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 50M;

    location = /notes-claude {
        return 301 /notes-claude/;
    }

    location /notes-claude/ {
        proxy_pass http://127.0.0.1:8083/;  # match claude-chat-USERNAME PORT
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;   # match the inkfellow-USERNAME PORT
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Test and reload:

```bash
sudo nginx -t && sudo nginx -s reload
```

### Step 4 — Add a DNS record and get an SSL certificate

1. Add an `A` record for `USERNAME.yourdomain.com` pointing to your server's IP.
2. Once DNS propagates (usually 5–10 minutes), expand the existing certificate:

```bash
sudo certbot --nginx --expand \
  -d yourdomain.com \
  -d www.yourdomain.com \
  -d USERNAME.yourdomain.com \
  --non-interactive --agree-tos -m you@example.com
```

The new subdomain is now live at `https://USERNAME.yourdomain.com`.

---

## Troubleshooting

### Page is blank after a code update or `next build`

**Symptom:** The site returns HTTP 200 but an empty body. No `X-Powered-By: Next.js` header. Paths outside the auth middleware (e.g. `/share/…`) return normal 404 pages.

**Cause:** Occasionally a production build produces a broken middleware bundle for `proxy.ts`. The compiled middleware intercepts every request matching `/` and `/api/notes/*` but fails to emit a response body.

**Fix:** Rebuild and restart:

```bash
cd /home/admin/apps/clawapp

# Stop both instances first to avoid port conflicts
pm2 stop inkfellow inkfellow-wumin   # adjust names to match yours

npm run build

pm2 start ecosystem.config.cjs --only inkfellow,inkfellow-wumin
```

If a `next-server` process is still holding the port after stopping PM2, kill it first:

```bash
# Find and kill any stray next-server on port 3000
ss -tlnp | grep 3000          # note the PID
kill <PID>
pm2 start inkfellow
```

### PM2 process starts then immediately crashes (EADDRINUSE)

A previous `next start` or `next dev` process is still occupying the port. Find and kill it:

```bash
ss -tlnp | grep <PORT>
kill <PID>
pm2 start inkfellow-USERNAME
```

### PM2 reports "Could not find a production build in the .next directory"

The `cwd` in `ecosystem.config.cjs` is resolving to the wrong directory. Replace any use of `__dirname` with the absolute path to the app:

```js
// ❌ unreliable — PM2 daemon resolves __dirname differently
const BASE = __dirname;

// ✅ always use the absolute path
const BASE = "/home/admin/apps/clawapp";
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
