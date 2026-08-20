// YouTube URL → bahan posting tunggal (bukan card news).
//
// Ambil satu video yang belum pernah dipakai dari daftar YT brand (atau --url),
// unduh thumbnail + judul/deskripsi/자막, lalu bikin job mode 'yt-single':
// nanti GPT Image (Higgsfield) menggambar ulang poster 1 slide dari thumbnail
// (lihat scripts/yt-single-gen.js), caption ditulis AI dari konteks video.
//
// Usage:
//   node scripts/yt-pull.js <brand_id> [--url <youtube-url>] [--queue] [--dry-run]
// Rotasi anti-ulang dicatat di drive_seen dengan kunci 'yt:<videoId>'.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const db = require('../app/db');

const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'app', 'uploads');
const now = () => new Date().toISOString();

// watch?v= / youtu.be/ / shorts/ → videoId; channel/playlist → null
function videoId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?[^ ]*v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function ytdlp(args, opts = {}) {
  return execFileSync('yt-dlp', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// srt/vtt → teks polos (header, nomor, timestamp dibuang; duplikat berurutan digabung)
function srtToText(file) {
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)
      && !/^(WEBVTT|Kind:|Language:)/.test(l.trim()));
  const out = [];
  for (const l of lines) {
    const t = l.replace(/<[^>]+>/g, '').trim();
    if (t && t !== out[out.length - 1]) out.push(t);
  }
  return out.join(' ');
}

async function main() {
  const args = process.argv.slice(2);
  const brandId = parseInt(args[0], 10);
  const urlFlag = args.indexOf('--url');
  const oneUrl = urlFlag >= 0 ? args[urlFlag + 1] : null;
  const queue = args.includes('--queue');
  const dryRun = args.includes('--dry-run');
  if (!brandId) { console.error('usage: node scripts/yt-pull.js <brand_id> [--url <url>] [--queue] [--dry-run]'); process.exit(1); }
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
  if (!brand) { console.error(`brand #${brandId} tidak ada`); process.exit(1); }

  // kandidat: --url menang; selain itu daftar yt_urls brand (satu URL per baris)
  const urls = oneUrl ? [oneUrl]
    : String(brand.yt_urls || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length) { console.error(`brand "${brand.name}" belum punya daftar YouTube (yt_urls)`); process.exit(1); }

  const seen = new Set(db.prepare("SELECT file_id FROM drive_seen WHERE brand_id=? AND file_id LIKE 'yt:%'").all(brandId).map(r => r.file_id));
  let pick = null, id = null;
  for (const u of urls) {
    const v = videoId(u);
    if (!v) { console.error(`  lewati (bukan link video): ${u.slice(0, 80)}`); continue; }
    if (!oneUrl && seen.has('yt:' + v)) continue;
    pick = u; id = v; break;
  }
  if (!pick) { console.error('tidak ada video baru — semua sudah pernah dipakai.'); process.exit(1); }
  console.error(`video: ${pick}`);

  const meta = JSON.parse(ytdlp(['-J', '--no-download', pick]));
  const title = meta.title || '';
  const channel = meta.channel || meta.uploader || '';
  console.error(`"${title}" — ${channel}`);
  if (dryRun) { console.log(JSON.stringify({ id, title, channel })); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  try {
    // 자막 (asli dulu, auto belakangan) — gagal bukan fatal.
    // yt-dlp bisa exit error karena satu bahasa kena 429 padahal bahasa lain sudah
    // terunduh — jadi file yang berhasil tetap dipungut, apa pun exit code-nya.
    let transcript = '';
    try {
      ytdlp(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ko,en',
        '--convert-subs', 'srt', '-o', path.join(tmp, 'sub'), pick], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { console.error('자막 sebagian gagal:', String(e.message).slice(0, 120)); }
    const subs = fs.readdirSync(tmp).filter(f => /\.(srt|vtt)$/.test(f));
    const sub = subs.find(f => f.includes('.ko.')) || subs[0];
    if (sub) transcript = srtToText(path.join(tmp, sub));
    console.error(`자막: ${transcript.length} karakter`);

    // thumbnail resolusi tertinggi
    ytdlp(['--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '-o', path.join(tmp, 'thumb'), pick], { stdio: ['ignore', 'pipe', 'pipe'] });
    const thumb = fs.readdirSync(tmp).find(f => /^thumb.*\.jpg$/.test(f));
    if (!thumb) throw new Error('thumbnail tidak terunduh');

    const topic = [
      `유튜브 영상 "${title}" (${channel})을 소재로 한 게시물.`,
      '이 채널/크리에이터가 포텐스튜디오에서 촬영했다는 사실이 핵심 소재다. 영상 내용을 과장하거나 지어내지 마라.',
      `\n## 영상 정보\n- 제목: ${title}\n- 채널: ${channel}\n- URL: ${pick}`,
      transcript ? `\n## 영상 자막 (발췌)\n${transcript.slice(0, 3000)}` : '',
    ].join('\n');
    const ts = now();
    const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
      VALUES (?, 'yt-single', ?, ?, ?, ?)`).run(brandId, topic, queue ? 'queued' : 'stock', ts, ts);
    const jobId = r.lastInsertRowid;
    const dir = path.join(UPLOADS, String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    const name = `yt-${id}-thumb.jpg`;
    fs.copyFileSync(path.join(tmp, thumb), path.join(dir, name));
    db.prepare('INSERT INTO materials(job_id, filename, note) VALUES (?,?,?)')
      .run(jobId, name, `유튜브 썸네일 — ${title}`.slice(0, 300));
    db.prepare('INSERT OR REPLACE INTO drive_seen(brand_id, file_id, name, job_id, seen_at) VALUES (?,?,?,?,?)')
      .run(brandId, 'yt:' + id, title.slice(0, 200), jobId, now());
    console.log(`job #${jobId} dibuat (${queue ? 'queued' : 'stock'}) — poster tunggal dari thumbnail "${title}".`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('yt-pull:', e.message); process.exit(1); });
