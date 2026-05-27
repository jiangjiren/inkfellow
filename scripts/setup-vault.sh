#!/usr/bin/env bash
# setup-vault.sh — One-time vault initialisation for Notes App
# Run once after installation: bash scripts/setup-vault.sh
set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${BLUE}▸${NC}  $*"; }
warn() { echo -e "${YELLOW}!${NC}  $*"; }
die()  { echo -e "\033[0;31m✗${NC}  $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo -e "${BOLD}Notes App — Vault Setup${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "This creates a local git vault so your notes are"
echo "version-controlled and ready to sync with Obsidian."
echo ""

# ── prompt for paths (with defaults) ─────────────────────────────────────
read -rp "$(echo -e "${BLUE}Vault directory${NC} [~/vault]: ")" VAULT_DIR
VAULT_DIR="${VAULT_DIR:-$HOME/vault}"
VAULT_DIR="${VAULT_DIR/#\~/$HOME}"       # expand leading ~

read -rp "$(echo -e "${BLUE}Bare repo location${NC} [~/git/notes-vault.git]: ")" BARE_DIR
BARE_DIR="${BARE_DIR:-$HOME/git/notes-vault.git}"
BARE_DIR="${BARE_DIR/#\~/$HOME}"
echo ""

# ── sanity checks ─────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git is not installed. Install it first."

# ── create bare repo ──────────────────────────────────────────────────────
if [ -d "$BARE_DIR" ]; then
    warn "Bare repo already exists at $BARE_DIR — skipping init."
else
    info "Creating bare repo at $BARE_DIR ..."
    mkdir -p "$(dirname "$BARE_DIR")"
    git init --bare "$BARE_DIR" -q
    # Set default branch to main
    git -C "$BARE_DIR" symbolic-ref HEAD refs/heads/main
    ok "Bare repo created."
fi

# ── set up working vault ──────────────────────────────────────────────────
if [ -d "$VAULT_DIR/.git" ]; then
    warn "Git repo already exists at $VAULT_DIR — skipping clone."
elif [ -d "$VAULT_DIR" ] && [ -n "$(ls -A "$VAULT_DIR" 2>/dev/null)" ]; then
    info "Directory $VAULT_DIR already has content."
    info "Initialising as a git repo and connecting to the bare repo..."
    git -C "$VAULT_DIR" init -q
    git -C "$VAULT_DIR" remote add origin "$BARE_DIR"
    ok "Remote set to $BARE_DIR"
else
    info "Cloning bare repo to $VAULT_DIR ..."
    mkdir -p "$VAULT_DIR"
    # Clone; suppress the "empty repo" warning — expected for a fresh bare repo
    git clone -q "$BARE_DIR" "$VAULT_DIR" 2>/dev/null || true
    ok "Vault directory ready at $VAULT_DIR"
fi

# ── seed with sample notes ────────────────────────────────────────────────
SAMPLE_DIR="$APP_DIR/vault"
# Count non-git files in vault
VAULT_FILES=$(find "$VAULT_DIR" -not -path '*/.git*' -mindepth 1 2>/dev/null | wc -l)

if [ -d "$SAMPLE_DIR" ] && [ "$VAULT_FILES" -eq 0 ]; then
    info "Seeding vault with sample notes..."
    cp -r "$SAMPLE_DIR/." "$VAULT_DIR/"
    git -C "$VAULT_DIR" add .
    git -C "$VAULT_DIR" \
        -c user.name="Notes Setup" \
        -c user.email="setup@localhost" \
        commit -q -m "Initial notes (sample vault)"
    git -C "$VAULT_DIR" push -q origin HEAD:main
    ok "Sample notes committed and pushed to bare repo."
elif [ "$VAULT_FILES" -gt 0 ]; then
    info "Vault already has content ($VAULT_FILES files) — skipping sample notes."
fi

# ── write VAULT_PATH to .env.local ───────────────────────────────────────
ENV_FILE="$APP_DIR/.env.local"

if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
        cp "$APP_DIR/.env.example" "$ENV_FILE"
        ok "Created .env.local from .env.example"
    else
        touch "$ENV_FILE"
    fi
fi

if grep -q "^VAULT_PATH=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^VAULT_PATH=.*|VAULT_PATH=$VAULT_DIR|" "$ENV_FILE"
else
    # Insert after the first blank line, or append
    echo "VAULT_PATH=$VAULT_DIR" >> "$ENV_FILE"
fi
ok "VAULT_PATH=$VAULT_DIR written to .env.local"

# ── done ─────────────────────────────────────────────────────────────────
SERVER_USER="$(whoami)"
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}All done!${NC} Your vault is ready."
echo ""
echo "  Vault (Notes App reads this)  →  $VAULT_DIR"
echo "  Bare repo (git remote)        →  $BARE_DIR"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Edit .env.local — set SITE_URL and login credentials"
echo "  2. npm run build && npm start"
echo ""
echo -e "${BOLD}To sync your local Obsidian with this vault:${NC}"
echo "  Add this as the git remote on your local machine:"
echo ""
echo -e "    ${GREEN}ssh://${SERVER_USER}@<YOUR_SERVER_IP>${BARE_DIR}${NC}"
echo ""
echo "  Then install the Obsidian Git plugin and set auto push/pull intervals."
echo "  See the README 'Syncing Your Local Obsidian Vault' section for details."
echo ""
