// SQLite (better-sqlite3) — brands / jobs / materials + seed 3 brand awal.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS brands(
  id INTEGER PRIMARY KEY,
  name TEXT,
  handle TEXT,
  discord_channel_id TEXT,
  ig_account_id TEXT,
  rss_feeds TEXT,
  template TEXT DEFAULT 'slide.html',
  prompt_rules TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  brand_id INTEGER,
  mode TEXT,
  topic TEXT,
  status TEXT,
  post_dir TEXT,
  error TEXT,
  discord_message_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS materials(
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  filename TEXT,
  note TEXT
);
`);

// migrasi ringan: jobs.template (pilihan template per job dari web UI)
try { db.exec('ALTER TABLE jobs ADD COLUMN template TEXT'); } catch {}

// migrasi ringan: brands.zernio_api_key — tiap akun IG bisa ada di workspace Zernio
// yang berbeda, jadi key-nya per brand. Kosong = pakai ZERNIO_API_KEY dari 설정.
try { db.exec('ALTER TABLE brands ADD COLUMN zernio_api_key TEXT'); } catch {}

// migrasi ringan: brands.drive_folder_id — folder Google Drive per brand.
// Isinya jadi bahan otomatis; kosong = fitur mati untuk brand itu.
try { db.exec('ALTER TABLE brands ADD COLUMN drive_folder_id TEXT'); } catch {}

// migrasi ringan: brands.source_urls — link referensi brand (web, Naver, blog).
// Diambil ulang tiap generate supaya fakta selalu terbaru, bukan hafalan prompt.
try { db.exec('ALTER TABLE brands ADD COLUMN source_urls TEXT'); } catch {}

// migrasi ringan: jobs.selection — tahap pilih foto sebelum generate.
// null = belum ditawarkan, 'pending' = menunggu pilihan di Discord, 'done' = sudah dipilih.
try { db.exec('ALTER TABLE jobs ADD COLUMN selection TEXT'); } catch {}

// File Drive yang sudah pernah dipakai, supaya tidak diambil berulang tiap hari.
db.exec(`CREATE TABLE IF NOT EXISTS drive_seen(
  brand_id INTEGER,
  file_id TEXT,
  name TEXT,
  job_id INTEGER,
  seen_at TEXT,
  PRIMARY KEY (brand_id, file_id)
)`);

// seed sekali saja kalau brands kosong
if (db.prepare('SELECT COUNT(*) AS c FROM brands').get().c === 0) {
  let channel = '';
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^DISCORD_CHANNEL_ID=(.*)$/m);
    if (m) channel = m[1].trim();
  } catch {}
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO brands(name, handle, discord_channel_id, ig_account_id, rss_feeds, template, prompt_rules, created_at)
    VALUES (?, '', ?, '', '', 'slide.html', '', ?)`);
  ins.run('Potenstudio', channel, now);
  ins.run('Planningbox', '', now);
  ins.run('Heartsync', '', now);
}

module.exports = db;
