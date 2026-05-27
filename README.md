# Notes App

English | [中文](./README.zh-CN.md)

A self-hosted web reader for an Obsidian-style Markdown vault. Keeps your notes as plain files, adds a mobile-friendly reading UI, supports private Git sync controls, and can generate public read-only share links for selected notes.

## Features

- Browse `.md`, `.html`, and `.htm` files from a local vault.
- Render Markdown with GFM, table of contents, and Obsidian-style local images.
- Protect the private notes UI and private notes APIs with Basic Auth.
- View Git status, diffs, commit history, and run pull/push/discard actions.
- Create tokenized public share links under `/share/:token`.
- Optional Claude chat if you run the separate service behind `/notes-claude/`.

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

Then build and start:

```bash
npm run build
npm start            # runs on http://localhost:3000
```

Open `http://localhost:3000/notes` in your browser and log in with the credentials above.

## Access Without a Domain (Public IP)

No domain? No problem. Set `SITE_URL` to your server's public IP:

```bash
SITE_URL=http://203.0.113.42        # via Nginx on port 80
# or
SITE_URL=http://203.0.113.42:3000   # direct Next.js, no Nginx
```

For direct access without Nginx, open port `3000` in your firewall:

```bash
# Example for firewalld (CentOS / RHEL / AlmaLinux)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# Example for ufw (Ubuntu / Debian)
sudo ufw allow 3000/tcp
```

The app works identically over IP — share links will include the IP in the URL.

## Environment Variables

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

## Scripts

```bash
npm run dev      # local development (hot reload)
npm run build    # production build
npm start        # run the built app
npm run lint     # ESLint
npx tsc --noEmit # TypeScript check
```

Create a share link from the CLI:

```bash
node scripts/create-share-link.mjs "path/in/vault/note.md"
```

## Production Deployment

A typical production setup:

1. **systemd** keeps the Next.js process running — see `deploy/notes-app.service.example`.
2. **Nginx** proxies port 80/443 to `127.0.0.1:3000` — see `deploy/nginx.conf.example`.

```bash
# Install and enable the service (after editing the example file)
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

To update the app after pulling new code:

```bash
SERVICE_NAME=notes-app bash scripts/update_app.sh
```

## Security Model

- Private routes `/notes` and `/api/notes/*` require Basic Auth.
- Public share routes are tokenized and read-only.
- Vault reads are restricted to `VAULT_PATH`; `.git`, `.obsidian`, `.claude`, `.claudian`, and `node_modules` are excluded.
- Git commands are executed without a shell and validate user-supplied paths.
- The Git sync API can modify your vault. Do not expose `/api/notes/*` without authentication.

## Repository Hygiene

Do not commit:

- `.env.local` or any `.env*` file (already in `.gitignore`).
- `shared-notes.json` if it contains real share tokens (already in `.gitignore`).
- `.next/`, `node_modules/`, vault contents, or generated media.
