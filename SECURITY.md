# Security Policy

This app is intended for self-hosted personal or small-team deployments.

## Private Surfaces

The following routes expose private vault data or can modify the vault and must stay behind authentication:

- `/notes`
- `/api/notes/*`
- `/notes-claude/` if you deploy the separate Claude chat service

The built-in Next.js proxy protects `/notes` and `/api/notes/*` with Basic Auth when `NOTES_BASIC_AUTH_PASSWORD` is set. Nginx or another reverse proxy should also protect the optional Claude chat service.

## Public Sharing

`/share/:token` is public read-only access to a single configured note. Treat share tokens as secrets. Revoke a token if it was exposed accidentally.

## Claude Permissions

Use `auto` by default. `bypassPermissions` can run powerful actions and should only be enabled for trusted single-user deployments behind strong authentication.

## Sensitive Files

Do not commit:

- `.env*` files except `.env.example`
- `shared-notes.json`
- Claude chat `session.json` and `history.json`
- Your real vault contents

## Reporting

If you publish a fork, provide your own security contact in this file.
