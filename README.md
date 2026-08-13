# Instagram Automation — POTENSTUDIO Content Factory

Multi-brand Instagram card-news factory. The team stocks photos + memos in a web inbox (자료함); every morning the system picks one item per brand, has AI write Korean card-news copy, designs branded 1080×1350 slides, sends a preview to Discord for one-button approval, and publishes approved posts to Instagram.

```
자료함 (web UI) ──┐
                  ├─▶ daily 9AM trigger ─▶ Claude copy ─▶ backgrounds ─▶ render ─▶ Discord approve ─▶ Instagram
RSS sources    ──┘        (worker)        (WebFetch/Read)  (photo/Higgsfield)  (Playwright)  (✅/🔄 buttons)   (Zernio)
```

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js ≥ 20 | app + scripts | `node -v` |
| `claude` CLI (logged in) | copywriting (reads articles + photos) | `claude -p "hi"` |
| `higgsfield` CLI (logged in) | AI background images | `higgsfield auth login` |
| `jq` | shell JSON parsing | `which jq` |
| Playwright Chromium | slide rendering | installed via npm postinstall, or `npx playwright install chromium` |

## Setup

```bash
git clone https://github.com/potenlab/instagram-automation.git
cd instagram-automation
npm install
npx playwright install chromium
```

Create `.env` in the repo root (never commit it — it is gitignored):

```env
DISCORD_BOT_TOKEN=            # Discord Developer Portal → Bot → Reset Token
DISCORD_CHANNEL_ID=           # default/fallback approval channel
ZERNIO_API_KEY=               # zernio.com → API key (sk_...) — editable later in web UI 설정
ZERNIO_IG_ACCOUNT_ID=         # optional fallback; per-brand IDs live in the web UI
UI_PASSWORD=potenlab2026      # shared web-UI password — change it
DAILY_HOUR=9                  # daily auto-generate hour (Mac local time)
REGEN_SCOPE=backgrounds       # Discord 🔄 button: backgrounds | full
REGEN_MAX=3                   # regen attempts per preview session
RSS_FEEDS=https://techcrunch.com/feed/   # fallback for scripts/daily.sh only
```

Discord bot needs: privileged intents ON (Presence / Server Members / Message Content) and an invite to your server with permission to post in the approval channels.

## Run

```bash
npm run ui        # → http://localhost:3002  (web UI + API + worker in one process)
```

Log in with `UI_PASSWORD`. Pages:

- **자료함** — the team's only input: pick brand → optional topic → upload photos (max 10) → memo → save. Right rail shows the per-brand stock (top item = tomorrow morning) and the RSS source checkboxes used when stock is empty.
- **대기열** — job status (`자료함 → 대기중 → 생성중 → 미리보기 → 승인됨 → 게시됨 / 실패`), slide thumbnails, retry/delete.
- **브랜드** — add/edit brands: Instagram account ID (from 설정 page list), Discord channel ID, RSS feeds, template file, extra copy rules.
- **설정** — Zernio API key (masked), connected Instagram accounts, daily hour, regen scope/max, Higgsfield model.

### Daily automation

The worker inside `npm run ui` fires once per day at `DAILY_HOUR` (per brand: oldest stocked item, else checked RSS sources). **The Mac and the server process must be running.** After a reboot, start `npm run ui` again.

The Discord preview posts with two buttons: **✅ 승인** (publishes to that brand's Instagram via Zernio when configured) and **🔄 디자인 재생성** (new backgrounds, copy preserved).

## CLI scripts (manual use / debugging)

```bash
scripts/daily.sh                       # full RSS flow once: pick article → generate → Discord preview
scripts/generate.sh <post-id> "<topic>"  # generate one post into out/<post-id>/ (idempotent per step)
node scripts/render.js out/<post-id>   # re-render slides only (free, no API calls)
node scripts/approve-bot.js out/<post-id>  # (re)post the Discord preview for a generated post
node scripts/publish.js out/<post-id>  # publish slides to Instagram now
node scripts/publish.js --accounts     # list Zernio-connected accounts (IDs for brand setup)
node scripts/fetch-news.js             # pick newest unseen article from RSS_FEEDS (dedup via out/.seen-urls.txt)
```

Per-post artifacts live in `out/<post-id>/`: `content.json` (copy), `backgrounds/`, `slide-N.png`, `caption.txt`, `pipeline.log`, `approve.log`, `approved` marker, `published.json`.

## Templates

Two kinds:

- **Legacy single-file**: `template/slide.html` + `brand.css` (dark) and `slide-light.html` + `brand-light.css` (light). Placeholders: `{{role_class}} {{bg_url}} {{logo_block}} {{page}} {{total}} {{badge}} {{number}} {{source_chip}} {{headline}} {{body_block}} {{cta_block}} {{handle}} {{footer_right}}`.
- **Families** (Figma 인스타 템플릿): `template/modern/` (12 layouts) and `template/ios/` (9 layouts). Each family = one `style.css` + one HTML per layout + `manifest.json` (display name + per-role default layout). The AI picks a layout per slide via the slide's `layout` field, guided by `prompts/layouts-<family>.md`; layouts without an `image_prompt` skip background generation.

Pick the default per brand in 브랜드, or per post in 자료함 (live thumbnails via `/tpl-preview/<family>/<layout>`). Copy rules for the AI live in `prompts/card-news.md`.

## Troubleshooting

- **Job failed** → open `out/<post-id>/pipeline.log`; fix, then 재시도 in 대기열 (idempotent — completed steps are skipped).
- **`content.json` invalid** → the claude CLI output was malformed; retry usually fixes it.
- **Discord buttons dead** → the approve-bot process died (24h timeout or reboot); rerun `node scripts/approve-bot.js out/<post-id>`.
- **Publish skipped on approve** → `ZERNIO_API_KEY` missing or the brand has no Instagram account ID.
- **Nothing generated this morning** → server wasn't running at `DAILY_HOUR`; it fires as soon as the process is back up (once per day).
