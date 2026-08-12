# Instagram Automation — Plan

Card news otomatis Bahasa Korea. Pipeline: RSS berita luar → `claude -p` tulis copy Korea → Higgsfield CLI generate background → template HTML render jadi PNG carousel → (nanti) Telegram approval → post via Zernio.

**Fase sekarang: image generation dulu.** RSS, Telegram, Zernio nyusul.

## Referensi hasil riset

### Zernio (target posting, fase nanti)
- https://zernio.com — social media API (dulu getlate.dev)
- Support Instagram carousel via `POST /posts` (`mediaItems` array)
- Punya CLI, Node SDK (`@zernio/node`), dan MCP server (280+ tools)
- Auth: API key + hosted OAuth untuk connect akun IG
- Kesimpulan: posting nanti tinggal satu API call, tidak perlu Meta app review sendiri

### Potenlab branding (acuan design template)
- https://potenlab.dev — Korean IT agency, style modern & clean
- Font: **Pretendard** (fallback Noto Sans KR) — standar de-facto Korea, free
- Palette:
  - Hitam `#000000` / dark navy `#0E1116` (hero background)
  - Putih `#FFFFFF` (teks utama di dark)
  - Biru accent `#0079FF` (highlight, CTA)
  - Lime accent `#D8FF84` (accent sekunder, isometric art)
  - Abu `#64748B` (teks sekunder)
- Karakter: dark background + teks putih besar + satu kata di-highlight biru. Cocok untuk card news (kontras tinggi, siap dipakai).

## Arsitektur image generation (fase 1)

```
input: topik/berita (manual dulu, RSS nanti)
  │
  ├─ 1. claude -p  → tulis konten card news (JSON)
  │       output: content.json
  │       { slides: [{ role: "cover"|"body"|"cta",
  │                    headline, body, highlight,
  │                    image_prompt }], caption }
  │
  ├─ 2. higgsfield CLI → generate background per slide
  │       dari image_prompt (no text, dark tone, 4:5)
  │       output: backgrounds/slide-N.png
  │
  ├─ 3. render → template HTML + content.json + background
  │       Playwright screenshot 1080x1350 per slide
  │       output: out/<post-id>/slide-N.png + caption.txt
  │
  └─ hasil: folder siap review/upload
```

### Struktur repo

```
instagram-automation/
├── PLAN.md
├── package.json          # playwright saja
├── template/
│   ├── slide.html        # satu file template, 3 layout: cover/body/cta
│   └── brand.css         # CSS variables: warna, font (Pretendard CDN)
├── scripts/
│   ├── generate.sh       # orchestrator: claude -p → higgsfield → render
│   └── render.js         # playwright: content.json → PNG
├── prompts/
│   └── card-news.md      # system prompt untuk claude -p (aturan copy Korea)
└── out/
    └── <post-id>/        # slide-1.png ... slide-N.png, caption.txt, content.json
```

### Keputusan design template

- Ukuran: **1080×1350** (4:5, ukuran maksimal feed IG)
- Slide count: cover + 3–5 body + CTA (5–7 total)
- Layout ala potenlab: dark background (foto Higgsfield + overlay gelap gradient), headline putih besar Pretendard Bold, kata kunci highlight `#0079FF`, badge kecil lime untuk kategori/nomor slide
- Teks selalu HTML (bukan hasil AI image) → tajam, no typo Korea, revisi murah
- Higgsfield prompt selalu: no text, no letters, dark moody tone — background only

### Aturan copy Korea (masuk system prompt)

- Headline: pendek, noun-ending atau ~해요체
- Body: max 2–3 kalimat pendek per slide (belajar dari feedback expert di video: teks kebanyakan = gagal)
- CTA slide: ajakan follow + value proposition akun

## Urutan build (fase 1)

1. ✅ `template/slide.html` + `brand.css` (dark) — plus `slide-light.html` + `brand-light.css` (light briefing)
2. ✅ `render.js` — Playwright screenshot pipeline
3. ✅ `prompts/card-news.md` — system prompt claude -p
4. ✅ `generate.sh` — jahit semua: topik → content.json → higgsfield backgrounds → render
   - Pakai: `scripts/generate.sh <post-id> "<topik atau URL>"` (idempotent, hapus file untuk regenerate; model via `HF_MODEL`, default `nano_banana_2_lite`)
5. ✅ Test end-to-end — 2 post sudah jadi: `out/daily-briefing` (light), `out/norecognition` (dark)

## Status fase 1.5 (sudah jalan)

- ✅ RSS fetcher + dedup (`fetch-news.js`) — full flow `daily.sh`
- ✅ Discord approval (`approve-bot.js`) — tombol 승인 / 디자인 재생성, UI Korea, scope regen via `REGEN_SCOPE`
- ✅ Zernio publish-on-approve (`publish.js`) — nunggu API key + IG account di `.env`
- Telegram batal → diganti Discord

## V2 — Card News Studio (web UI, multi-brand)

Keputusan diskusi 2026-08-12 (chat minjae/jimin):

### Konsep

Dari "pipeline 1 brand" jadi **content factory multi-brand**. Semua yang sekarang
hardcoded (brand, template, channel, feed, akun IG) jadi data yang diatur via web UI.
Tim (minjae/jimin) insert topik + upload materials → AI generate → Discord approve → IG.

### Entity

- **Brand** (dynamic, bisa add): nama, handle, logo, template, warna, akun IG (Zernio
  accountId), Discord channel, RSS feeds (opsional, adjustable), aturan copy.
  1 brand = 1 akun IG = 1 channel Discord. Seed awal: Potenstudio, Planningbox, Heartsync.
- **Job/Post**: brand + mode (`rss` | `topic` | `materials`) + topik + materials[] +
  status (`queued → generating → preview → approved/regen → published/failed`).
- **Material**: gambar (dulu; video nanti) + catatan/review teks. Dua peran:
  (a) sumber pengetahuan AI untuk copy, (b) bisa langsung dipakai jadi background slide
  menggantikan generate Higgsfield — AI yang milih per slide.
- **Template**: HTML+CSS upload-able (nunggu final Figma jimin), dengan **kontrak
  placeholder** terdokumentasi (`{{headline}}`, `{{body_block}}`, dst) supaya designer
  bisa bikin template tanpa sentuh kode. Template sekarang jadi "default potenlab".

### Arsitektur

- **App lokal di Mac + Cloudflare Tunnel** (tim akses via HTTPS; Mac harus nyala).
- Satu app Node: web UI + API + worker queue dalam satu proses.
  SQLite untuk brands/jobs, file tetap di `out/<post-id>/`.
- Worker jalankan pipeline yang sudah ada (claude → higgsfield → render → approve-bot
  per channel brand → publish per akun brand).
- Auth: shared password (cookie session).
- Cron RSS harian hanya untuk brand yang feed-nya diaktifkan di UI.

### Halaman UI (minimal)

1. Login (password)
2. **New Post**: pilih brand → topik → upload materials → submit
3. **Queue/History**: status job, thumbnail preview, retry
4. **Brands**: add/edit brand, pilih akun IG (dari Zernio), channel Discord, feeds, warna
5. **Templates**: upload + preview dummy + assign ke brand (fase C)

### Urutan build

- **A**: skeleton app + auth + brand CRUD (seed 3 brand) + new post (topik) + queue +
  wire pipeline lama + tunnel → tim langsung bisa pakai
- **B**: materials upload + AI pakai material (copy + background dari foto upload)
- **C**: template upload + kontrak placeholder + preview (nunggu jimin final)
- **D**: RSS per brand di UI + scheduling/jadwal posting
- Nanti: video/shorts sebagai material, output Reels 9:16

### Open items

- Nama tunnel: quick tunnel URL berubah tiap restart — kalau mau URL tetap, butuh
  named tunnel + domain (punya domain nganggur?)
- Akun IG Planningbox & Heartsync belum connect Zernio
- Figma jimin: tunggu final → konversi ke template HTML pertama yang di-upload
