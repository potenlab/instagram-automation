#!/usr/bin/env bash
# Usage: scripts/generate.sh <post-id> "<topik atau URL berita>"
# Pipeline: claude -p (content.json) → higgsfield (backgrounds) → render.js (PNG)
# Idempotent: step di-skip kalau output-nya sudah ada. Hapus file untuk regenerate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POST_ID="${1:?usage: generate.sh <post-id> \"<topik>\"}"
TOPIC="${2:-}"
DIR="$ROOT/out/$POST_ID"
MODEL="${HF_MODEL:-nano_banana_2_lite}"
mkdir -p "$DIR/backgrounds"

# 1. copywriting → content.json
if [ ! -f "$DIR/content.json" ]; then
  [ -n "$TOPIC" ] || { echo "content.json belum ada — kasih topik sebagai argumen ke-2"; exit 1; }
  echo "$TOPIC" > "$DIR/topic.txt"   # disimpan supaya approve-bot bisa regen full
  echo "== claude -p: nulis konten =="
  LAYOUT_DOC="$ROOT/prompts/layouts-${TEMPLATE:-}.md"   # family template → layout instructions ikut prompt
  { cat "$ROOT/prompts/card-news.md"; [ -f "$LAYOUT_DOC" ] && cat "$LAYOUT_DOC"; printf '\n## 주제\n\n%s\n' "$TOPIC"; } \
    | claude -p --allowedTools WebFetch Read \
    | node -e 'const s=require("fs").readFileSync(0,"utf8");const a=s.indexOf("{"),b=s.lastIndexOf("}");process.stdout.write(a<0?s:s.slice(a,b+1))' > "$DIR/content.json"
  jq . "$DIR/content.json" > /dev/null || { echo "output bukan JSON valid — cek $DIR/content.json"; exit 1; }
  if [ -n "${TEMPLATE:-}" ] && [ "$TEMPLATE" != "slide.html" ]; then
    jq --arg t "$TEMPLATE" '.template=$t' "$DIR/content.json" > "$DIR/content.json.tmp" && mv "$DIR/content.json.tmp" "$DIR/content.json"
  fi
  # branding per brand dari web UI menang atas default prompt
  if [ -n "${BRAND_NAME:-}" ]; then
    jq --arg n "$BRAND_NAME" --arg h "${BRAND_HANDLE:-}" \
      '.brand.name=$n | (if $h != "" then .brand.handle=$h else . end)' \
      "$DIR/content.json" > "$DIR/content.json.tmp" && mv "$DIR/content.json.tmp" "$DIR/content.json"
  fi
fi

# 2. backgrounds via Higgsfield CLI
COUNT=$(jq '.slides | length' "$DIR/content.json")
for i in $(seq 1 "$COUNT"); do
  BG="$DIR/backgrounds/slide-$i.png"
  [ -f "$BG" ] && continue
  # material upload dipakai langsung sebagai background (AI yang milih per slide)
  MAT=$(jq -r ".slides[$((i-1))].background_material // empty" "$DIR/content.json")
  MAT=$(basename "$MAT")   # blok path traversal dari output model
  if [ -n "$MAT" ] && [ -f "$DIR/materials/$MAT" ]; then
    echo "== background $i/$COUNT: pakai material $MAT =="
    cp "$DIR/materials/$MAT" "$BG"
    continue
  fi
  PROMPT=$(jq -r ".slides[$((i-1))].image_prompt // empty" "$DIR/content.json")
  [ -n "$PROMPT" ] || { echo "== background $i/$COUNT: skip (layout tanpa foto) =="; continue; }
  echo "== background $i/$COUNT =="
  JOB=$(higgsfield generate create "$MODEL" \
    --prompt "$PROMPT" --aspect_ratio 4:5 --wait --json)
  echo "$JOB" > "$DIR/job-$i.json"
  URL=$(echo "$JOB" | jq -r '.. | .result_url? // empty' | head -1)
  [ -n "$URL" ] || { echo "job $i gagal — cek $DIR/job-$i.json"; exit 1; }
  curl -sSfL "$URL" -o "$BG"
done

# 3. render PNG
echo "== render =="
node "$ROOT/scripts/render.js" "$DIR"
echo "selesai: $DIR"
