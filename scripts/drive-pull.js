// Tarik bahan dari folder Google Drive brand → jadi job 'stock' + materials.
//
// Usage: node scripts/drive-pull.js <brand_id> [--limit N] [--dry-run] [--note "..."]
//
// Auth lewat `gws` (Google Workspace CLI). Di server headless keyring macOS tidak
// bisa dibuka, jadi set GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file di sana.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../app/db');

const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'app', 'uploads');
const now = () => new Date().toISOString();

// tipe yang berguna sebagai bahan. Video ikut diambil — pemakaiannya menyusul,
// tapi didaftarkan sejak awal supaya tidak perlu tarik ulang folder nanti.
const USABLE = /^(image\/(png|jpe?g|webp|gif)|video\/)/;

function gws(args) {
  // stdout gws murni JSON; baris "Using keyring backend" masuk stderr
  const out = execFileSync('gws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function listFolder(folderId) {
  const files = [];
  let pageToken = null;
  do {
    const params = {
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
      pageSize: 100,
      orderBy: 'modifiedTime desc',
      ...(pageToken ? { pageToken } : {}),
    };
    const res = gws(['drive', 'files', 'list', '--params', JSON.stringify(params)]);
    if (res.error) throw new Error(`Drive: ${res.error.message || JSON.stringify(res.error).slice(0, 200)}`);
    files.push(...(res.files || []));
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return files;
}

function download(fileId, dest) {
  gws(['drive', 'files', 'get', '--params', JSON.stringify({ fileId, alt: 'media' }), '--output', dest]);
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`unduhan kosong: ${dest}`);
}

const safeName = n => path.basename(String(n)).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_') || 'file';

function main() {
  const args = process.argv.slice(2);
  const brandId = parseInt(args[0], 10);
  // indexOf -1 + 1 = 0 → tanpa penjaga ini, args[0] (brand id) terbaca sebagai nilai flag
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const limit = parseInt(flag('--limit', '8'), 10) || 8;   // banyak kandidat; manusia yang memilih di Discord
  const dryRun = args.includes('--dry-run');
  const note = flag('--note', 'Google Drive');

  if (!brandId) { console.error('usage: node scripts/drive-pull.js <brand_id> [--limit N] [--dry-run]'); process.exit(1); }
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
  if (!brand) { console.error(`brand #${brandId} tidak ada`); process.exit(1); }
  const folderId = String(brand.drive_folder_id || '').trim();
  if (!folderId) { console.error(`brand "${brand.name}" belum punya drive_folder_id`); process.exit(1); }

  console.log(`brand: ${brand.name} | folder: ${folderId}`);
  const all = listFolder(folderId);
  const usable = all.filter(f => USABLE.test(f.mimeType || ''));
  const seen = new Set(db.prepare('SELECT file_id FROM drive_seen WHERE brand_id=?').all(brandId).map(r => r.file_id));
  const fresh = usable.filter(f => !seen.has(f.id));

  console.log(`isi folder: ${all.length} file | terpakai: ${usable.length} | belum pernah diambil: ${fresh.length}`);
  if (!fresh.length) { console.log('tidak ada bahan baru — selesai.'); return; }

  const pick = fresh.slice(0, limit);
  console.log(`ambil ${pick.length}:`);
  for (const f of pick) console.log(`  - ${f.name} (${f.mimeType}, ${Math.round((f.size || 0) / 1024)}KB)`);
  if (dryRun) { console.log('\n--dry-run: tidak ada yang diunduh atau disimpan.'); return; }

  const ts = now();
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
    VALUES (?, 'drive', '', 'stock', ?, ?)`).run(brandId, ts, ts);
  const jobId = r.lastInsertRowid;
  const dir = path.join(UPLOADS, String(jobId));
  fs.mkdirSync(dir, { recursive: true });

  const insMat = db.prepare('INSERT INTO materials(job_id, filename, note) VALUES (?,?,?)');
  const insSeen = db.prepare('INSERT OR REPLACE INTO drive_seen(brand_id, file_id, name, job_id, seen_at) VALUES (?,?,?,?,?)');
  const used = new Set();
  let ok = 0;

  for (const f of pick) {
    let name = safeName(f.name);
    if (used.has(name)) name = `${ok + 1}-${name}`;
    used.add(name);
    try {
      download(f.id, path.join(dir, name));
      insMat.run(jobId, name, note);
      insSeen.run(brandId, f.id, f.name, jobId, now());
      ok++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${String(e.message).slice(0, 160)}`);
    }
  }

  if (!ok) {
    // tidak ada yang berhasil → jangan tinggalkan job kosong
    db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    console.error('semua unduhan gagal — job dibatalkan.');
    process.exit(1);
  }

  db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(now(), jobId);
  console.log(`\njob #${jobId} dibuat (status stock) dengan ${ok} bahan.`);
  console.log(`jalankan sekarang: web UI 대기열 → 실행, atau set status='queued'.`);
}

main();
