#!/usr/bin/env bash
# bootstrap.sh — Setup-Einstieg fuer claude-usage-mcp (Leo 2026-09-29: "Bootstrailer fuer alle repos").
# Idempotent: legt nur fehlendes an, kann beliebig oft laufen.
# Startet keinen Dienst, schreibt nichts nach ~/.claude oder systemd.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
command -v npm >/dev/null || { echo 'npm fehlt' >&2; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
npm run build
echo "bootstrap ok: $(pwd)"
