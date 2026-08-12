#!/usr/bin/env bash
# Full flow harian: RSS → pilih berita → claude copy → higgsfield background → render → preview Discord.
# Usage: scripts/daily.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; source .env; set +a

PICK=$(node scripts/fetch-news.js)
ID=$(echo "$PICK" | jq -r .id)
TOPIC=$(echo "$PICK" | jq -r .topic)
echo "== artikel terpilih: $ID =="

scripts/generate.sh "$ID" "$TOPIC"
node scripts/approve-bot.js "out/$ID"
