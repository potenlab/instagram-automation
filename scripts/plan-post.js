// Sub-agent PLANNER: menentukan posting hari ini untuk satu brand.
//
// 1. Sync seluruh folder Google Drive brand ke library lokal (app/library/<brand_id>/)
//    — foto lama boleh dipakai ulang, bukan hanya file baru seperti drive-pull.
// 2. AI membuka foto-foto library + membaca riwayat post terakhir, lalu memutuskan:
//    angle hari ini, 3–6 foto terpilih, dan catatan source material per foto.
// 3. Hasil jadi job status 'stock' + materials — creator (generate.sh) tinggal jalan.
//
// Usage: node scripts/plan-post.js <brand_id> [--dry-run] [--queue]
//   --queue: langsung set status 'queued' (worker angkat dalam 10 detik)
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const db = require('../app/db');

const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'app', 'uploads');
const LIBRARY = path.join(ROOT, 'app', 'library');
const now = () => new Date().toISOString();
const IMAGE = /^image\/(png|jpe?g|webp)/;

function gws(args) {
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

const safeName = n => path.basename(String(n)).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_') || 'file';

// download file Drive yang belum ada di library; hapus yang sudah tidak ada di Drive
function syncLibrary(brandId, folderId) {
  const dir = path.join(LIBRARY, String(brandId));
  fs.mkdirSync(dir, { recursive: true });
  const remote = listFolder(folderId).filter(f => IMAGE.test(f.mimeType || ''));
  const keep = new Set();
  for (const f of remote) {
    const name = safeName(f.name);
    keep.add(name);
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    try {
      gws(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: f.id, alt: 'media' }), '--output', dest]);
      console.error(`  ↓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${String(e.message).slice(0, 120)}`);
      fs.rmSync(dest, { force: true });
    }
  }
  for (const name of fs.readdirSync(dir)) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  return { dir, files: fs.readdirSync(dir).sort() };
}

function claudePlan(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--allowedTools', 'Read'], { cwd: ROOT });
    let out = '', err = '';
    child.stdin.end(prompt);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('claude exit ' + code + ': ' + (err || out).slice(-300)));
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      if (a < 0 || b < a) return reject(new Error('bukan JSON: ' + out.slice(0, 300)));
      try { resolve(JSON.parse(out.slice(a, b + 1))); }
      catch (e) { reject(new Error('JSON rusak: ' + e.message + ' — ' + out.slice(a, a + 200))); }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const brandId = parseInt(args[0], 10);
  const dryRun = args.includes('--dry-run');
  const queue = args.includes('--queue');
  if (!brandId) { console.error('usage: node scripts/plan-post.js <brand_id> [--dry-run] [--queue]'); process.exit(1); }
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
  if (!brand) { console.error(`brand #${brandId} tidak ada`); process.exit(1); }
  const folderId = String(brand.drive_folder_id || '').trim();
  if (!folderId) { console.error(`brand "${brand.name}" belum punya drive_folder_id`); process.exit(1); }

  console.error(`planner: ${brand.name} — sync library dari Drive…`);
  const lib = syncLibrary(brandId, folderId);
  if (!lib.files.length) { console.error('library kosong — setiap post wajib pakai foto Drive, berhenti.'); process.exit(1); }
  console.error(`library: ${lib.files.length} foto`);

  // riwayat: topik post terakhir supaya tidak mengulang tema
  const history = db.prepare(`SELECT topic, status FROM jobs
    WHERE brand_id=? AND status IN ('preview','approved','published') AND topic != ''
    ORDER BY id DESC LIMIT 8`).all(brandId);
  // foto yang baru saja dipakai (rotasi: hindari dulu, boleh kalau memang paling cocok)
  const recentUsed = db.prepare(`SELECT name FROM drive_seen WHERE brand_id=? ORDER BY seen_at DESC LIMIT 12`)
    .all(brandId).map(r => safeName(r.name));

  let prompt = `너는 인스타그램 브랜드 계정의 콘텐츠 기획자다. 오늘 올릴 게시물 **하나**를 기획해라.

## 브랜드
${brand.name} (${brand.handle || ''})
${brand.prompt_rules || ''}

## 사진 라이브러리 (Google Drive)
아래 사진을 **Read 도구로 한 장씩 실제로 열어서 본 뒤** 골라라. 파일명만 보고 고르지 마라.
`;
  for (const f of lib.files) prompt += `- ${path.join(lib.dir, f)}\n`;
  prompt += `
최근에 이미 쓴 사진 (다른 각도·다른 공간을 우선하되, 오늘 주제에 정말 맞으면 재사용해도 된다):
${recentUsed.length ? recentUsed.map(n => '- ' + n).join('\n') : '- (없음)'}

## 최근 게시물 (같은 주제 반복 금지)
${history.length ? history.map(h => '- ' + String(h.topic).split('\n')[0].slice(0, 80)).join('\n') : '- (없음)'}

## 규칙
- 사진 선정 기준은 엄격하게: 흐림·노출 무너짐·잡동사니·기울어진 구도·중복 각도·얼굴 나온 사람은 떨어뜨려라.
- **4–8장을 후보로 골라라** (좋은 순서대로). 최종 선택은 사람이 Discord에서 한다 — 고를 여지가 있어야 한다. 게시물은 반드시 실제 사진으로 만든다 — 사진 없이는 게시물도 없다.
- angle은 최근 게시물과 겹치지 않는 새로운 방향으로.
- note는 카피라이터에게 넘기는 소재 메모다: 그 사진에서 뭘 보여줄지, 어떤 슬라이드감인지 구체적으로.

## 출력 — JSON만. 마크다운 펜스·설명 금지.
{
  "angle": "오늘 게시물의 구체적인 방향 한 문장 (한국어)",
  "picks": [
    { "file": "파일명", "note": "이 사진의 소재 메모 (한국어, 한 문장)" }
  ]
}
`;

  console.error('planner: AI memilih foto + angle…');
  const plan = await claudePlan(prompt);
  const valid = new Set(lib.files);
  const picks = (plan.picks || [])
    .map(p => ({ file: safeName(p.file || ''), note: String(p.note || '').slice(0, 300) }))
    .filter(p => valid.has(p.file));
  if (!picks.length) { console.error('planner tidak memilih foto satu pun — berhenti (post wajib pakai foto).'); process.exit(1); }

  console.error(`angle: ${plan.angle || '-'}`);
  for (const p of picks) console.error(`  ✓ ${p.file} — ${p.note}`);
  if (dryRun) { console.log(JSON.stringify({ angle: plan.angle, picks }, null, 1)); return; }

  const topic = `${plan.angle || ''}\n\n## 소재 메모 (기획자)\n${picks.map(p => `- ${p.file}: ${p.note}`).join('\n')}`.trim();
  const ts = now();
  // selection dibiarkan NULL — kandidat planner masih harus dipilih manusia di
  // Discord (intake.selectMaterials) sebelum generate jalan
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
    VALUES (?, 'drive', ?, ?, ?, ?)`).run(brandId, topic, queue ? 'queued' : 'stock', ts, ts);
  const jobId = r.lastInsertRowid;
  const dir = path.join(UPLOADS, String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const insMat = db.prepare('INSERT INTO materials(job_id, filename, note) VALUES (?,?,?)');
  const insSeen = db.prepare('INSERT OR REPLACE INTO drive_seen(brand_id, file_id, name, job_id, seen_at) VALUES (?,?,?,?,?)');
  for (const p of picks) {
    fs.copyFileSync(path.join(lib.dir, p.file), path.join(dir, p.file));
    insMat.run(jobId, p.file, p.note);
    // file_id tidak selalu diketahui di sini — pakai nama sebagai kunci rotasi
    insSeen.run(brandId, 'lib:' + p.file, p.file, jobId, now());
  }
  console.log(`job #${jobId} dibuat (${queue ? 'queued' : 'stock'}) dengan ${picks.length} foto.`);
}

main().catch(e => { console.error('plan-post:', e.message); process.exit(1); });
