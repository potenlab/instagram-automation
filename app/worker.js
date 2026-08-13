// Queue worker — jalankan pipeline lama (generate.sh → approve-bot) per job.
// ponytail: satu job sekali jalan (flag `running`), paralel nanti kalau perlu.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
let running = false;

const now = () => new Date().toISOString();

function setStatus(id, status, error = null) {
  db.prepare('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?').run(status, error, now(), id);
}

function slug(topic) {
  const s = String(topic || '').split(/\s+/).slice(0, 4).join(' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'post';
}

function spawnLogged(cmd, args, opts, logFile) {
  return new Promise(resolve => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, opts);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('error', err => { log.write('spawn error: ' + err.message + '\n'); resolve(1); });
    child.on('close', code => resolve(code));
  });
}

async function runJob(job) {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(job.brand_id);
  if (!brand) return setStatus(job.id, 'failed', '브랜드를 찾을 수 없습니다. 브랜드 설정을 확인하세요.');
  if (!brand.discord_channel_id) {
    return setStatus(job.id, 'failed', `브랜드 "${brand.name}"에 Discord 채널 ID가 없습니다. 브랜드 설정에서 채널을 등록하세요.`);
  }
  setStatus(job.id, 'generating');

  // 1. post dir + materials copy
  const postDir = job.post_dir || `${now().slice(0, 10)}-${slug(job.topic)}-j${job.id}`;
  db.prepare('UPDATE jobs SET post_dir=?, updated_at=? WHERE id=?').run(postDir, now(), job.id);
  const dir = path.join(OUT, postDir);
  fs.mkdirSync(dir, { recursive: true });
  const mats = db.prepare('SELECT * FROM materials WHERE job_id=?').all(job.id);
  if (mats.length) {
    fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
    for (const m of mats) {
      const src = path.join(__dirname, 'uploads', String(job.id), m.filename);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'materials', m.filename));
    }
  }

  // 2. TOPIC string — topik kosong: AI tentukan sendiri dari materi
  let topic = job.topic || '주제가 지정되지 않았다. 아래 자료 이미지를 보고 어울리는 주제를 정해서 카드뉴스를 만들어라.';
  if (brand.prompt_rules) topic += '\n\n## 브랜드 규칙\n' + brand.prompt_rules;
  if (mats.length) {
    topic += '\n\n## 자료 (materials)\n';
    for (const m of mats) topic += `- out/${postDir}/materials/${m.filename} — ${m.note || ''}\n`;
    topic += '자료 이미지가 슬라이드 배경으로 적합하면 해당 slide에 "background_material": "<filename>" 필드를 넣어라. Read 도구로 자료 이미지를 먼저 봐라.';
  }

  // 3. generate.sh
  const code = await spawnLogged(
    path.join(ROOT, 'scripts', 'generate.sh'), [postDir, topic],
    { cwd: ROOT, env: { ...process.env, HF_MODEL: process.env.HF_MODEL || '', TEMPLATE: job.template || brand.template || 'slide.html', BRAND_NAME: brand.name || '', BRAND_HANDLE: brand.handle || '' } },
    path.join(dir, 'pipeline.log'),
  );
  if (code !== 0) {
    let tail = '';
    try { tail = fs.readFileSync(path.join(dir, 'pipeline.log'), 'utf8').slice(-500); } catch {}
    return setStatus(job.id, 'failed', tail || `generate.sh exit ${code}`);
  }

  // 4. approve-bot (detached, tidak di-await)
  const approveLog = fs.openSync(path.join(dir, 'approve.log'), 'a');
  const bot = spawn('node', [path.join(ROOT, 'scripts', 'approve-bot.js'), 'out/' + postDir], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', approveLog, approveLog],
    env: {
      ...process.env,
      DISCORD_CHANNEL_ID: brand.discord_channel_id,
      ZERNIO_IG_ACCOUNT_ID: brand.ig_account_id || '',
    },
  });
  bot.unref();
  fs.closeSync(approveLog);
  setStatus(job.id, 'preview');
}

// preview/approved → cek file marker dari approve-bot / publish.js
function checkMarkers() {
  const rows = db.prepare(`SELECT id, post_dir, status FROM jobs WHERE status IN ('preview','approved') AND post_dir IS NOT NULL`).all();
  for (const j of rows) {
    const dir = path.join(OUT, j.post_dir);
    if (fs.existsSync(path.join(dir, 'published.json'))) {
      if (j.status !== 'published') setStatus(j.id, 'published');
    } else if (fs.existsSync(path.join(dir, 'approved'))) {
      if (j.status !== 'approved') setStatus(j.id, 'approved');
    }
  }
}

// --- scheduler harian: 1 post per brand per hari dari stok materi (atau RSS) ---
db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
const getMeta = k => (db.prepare('SELECT v FROM meta WHERE k=?').get(k) || {}).v;
const setMeta = (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);

function fetchRssTopic(feeds) {
  return new Promise(resolve => {
    const child = spawn('node', [path.join(ROOT, 'scripts', 'fetch-news.js')], {
      cwd: ROOT, env: { ...process.env, RSS_FEEDS: feeds },
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    child.on('error', () => resolve(null));
  });
}

async function dailyTrigger() {
  const hour = parseInt(process.env.DAILY_HOUR || '9', 10);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (now.getHours() < hour || getMeta('last_daily') === today) return;
  setMeta('last_daily', today);
  const ts = new Date().toISOString();
  for (const b of db.prepare('SELECT * FROM brands').all()) {
    const stock = db.prepare(`SELECT id FROM jobs WHERE brand_id=? AND status='stock' ORDER BY id LIMIT 1`).get(b.id);
    if (stock) {
      db.prepare(`UPDATE jobs SET status='queued', updated_at=? WHERE id=?`).run(ts, stock.id);
      console.log(`daily: brand ${b.name} → job #${stock.id} dari stok`);
    } else if (b.rss_feeds && b.rss_feeds.trim()) {
      const pick = await fetchRssTopic(b.rss_feeds.trim());
      if (!pick) { console.error(`daily: brand ${b.name} — RSS kosong/gagal`); continue; }
      db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
        VALUES (?, 'rss', ?, 'queued', ?, ?)`).run(b.id, pick.topic, ts, ts);
      console.log(`daily: brand ${b.name} → RSS "${pick.topic.slice(0, 60)}"`);
    }
  }
}

function tick() {
  dailyTrigger().catch(e => console.error('worker daily:', e));
  try { checkMarkers(); } catch (e) { console.error('worker checkMarkers:', e); }
  if (running) return;
  let job;
  try {
    job = db.prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1`).get();
  } catch (e) { console.error('worker pick:', e); return; }
  if (!job) return;
  running = true;
  runJob(job)
    .catch(e => { try { setStatus(job.id, 'failed', String(e && e.message || e).slice(0, 500)); } catch (e2) { console.error('worker setStatus:', e2); } })
    .finally(() => { running = false; });
}

function start() {
  setInterval(tick, 10_000);
  console.log('worker: loop 10s aktif');
}

module.exports = { start };
