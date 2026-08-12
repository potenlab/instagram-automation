// Card News Studio — web UI (Fase A+B). npm run ui → http://localhost:3002
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const worker = require('./worker');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const UPLOADS = path.join(__dirname, 'uploads');

// .env: pastikan UI_PASSWORD ada (append, jangan rewrite), lalu load ke process.env
const envPath = path.join(ROOT, '.env');
let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
if (!/^UI_PASSWORD=/m.test(envText)) {
  const add = (envText && !envText.endsWith('\n') ? '\n' : '') + 'UI_PASSWORD=potenlab2026\n';
  fs.appendFileSync(envPath, add);
  envText += add;
}
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const app = express();
const sessions = new Set(); // ponytail: in-memory session, restart = login ulang

// --- auth ---
const OPEN = new Set(['/login.html', '/api/login', '/style.css']);
app.use((req, res, next) => {
  if (OPEN.has(req.path)) return next();
  const sid = (req.headers.cookie || '').split(/;\s*/)
    .map(c => c.split('=')).find(([k]) => k === 'sid')?.[1];
  if (sid && sessions.has(sid)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  res.redirect('/login.html');
});

app.post('/api/login', express.json(), (req, res) => {
  if ((req.body || {}).password !== process.env.UI_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ ok: true });
});

// --- brands CRUD ---
const BRAND_FIELDS = ['name', 'handle', 'discord_channel_id', 'ig_account_id', 'rss_feeds', 'template', 'prompt_rules'];
const brandBody = b => BRAND_FIELDS.map(f => String(b[f] ?? ''));

app.get('/api/brands', (req, res) => {
  res.json(db.prepare('SELECT * FROM brands ORDER BY id').all());
});

app.post('/api/brands', express.json(), (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: '이름은 필수입니다' });
  const vals = brandBody(req.body);
  if (!vals[5]) vals[5] = 'slide.html';
  const r = db.prepare(`INSERT INTO brands(${BRAND_FIELDS.join(',')}, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(...vals, new Date().toISOString());
  res.json(db.prepare('SELECT * FROM brands WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/brands/:id', express.json(), (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: '브랜드가 없습니다' });
  const merged = { ...brand, ...req.body };
  db.prepare(`UPDATE brands SET ${BRAND_FIELDS.map(f => f + '=?').join(',')} WHERE id=?`)
    .run(...brandBody(merged), brand.id);
  res.json(db.prepare('SELECT * FROM brands WHERE id=?').get(brand.id));
});

app.delete('/api/brands/:id', (req, res) => {
  db.prepare('DELETE FROM brands WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- jobs ---
const upload = multer({
  dest: path.join(UPLOADS, 'tmp'),
  limits: { files: 10, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.post('/api/jobs', upload.array('materials', 10), (req, res) => {
  const { brand_id, topic, note } = req.body || {};
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brand_id);
  if (!brand) return res.status(400).json({ error: '브랜드를 선택하세요' });
  const files = req.files || [];
  if ((!topic || !topic.trim()) && !files.length) return res.status(400).json({ error: '주제 또는 자료 이미지를 넣어주세요' });

  const mode = files.length ? 'materials' : 'topic';
  const ts = new Date().toISOString();
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
    VALUES (?, ?, ?, 'stock', ?, ?)`).run(brand.id, mode, (topic || '').trim(), ts, ts);
  const jobId = r.lastInsertRowid;

  if (files.length) {
    const dir = path.join(UPLOADS, String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    const insMat = db.prepare('INSERT INTO materials(job_id, filename, note) VALUES (?,?,?)');
    const used = new Set();
    for (const f of files) {
      // multer originalname = latin1; balikin ke utf8 (nama file Korea)
      let name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      name = path.basename(name).replace(/[\\\/:*?"<>|\x00-\x1f]+/g, "_");
      if (used.has(name) || !name) name = crypto.randomBytes(4).toString('hex') + '-' + name;
      used.add(name);
      fs.renameSync(f.path, path.join(dir, name));
      insMat.run(jobId, name, String(note || ''));
    }
  }
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId));
});

app.get('/api/jobs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const jobs = db.prepare(`SELECT j.*, b.name AS brand_name,
      (SELECT COUNT(*) FROM materials m WHERE m.job_id = j.id) AS material_count
    FROM jobs j LEFT JOIN brands b ON b.id = j.brand_id ORDER BY j.id DESC LIMIT ?`).all(limit);
  for (const j of jobs) {
    j.slides = [];
    if (j.post_dir) {
      try {
        j.slides = fs.readdirSync(path.join(OUT, j.post_dir))
          .filter(f => /^slide-\d+\.png$/.test(f))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
          .map(f => `/files/${j.post_dir}/${f}`);
      } catch {}
    }
  }
  res.json(jobs);
});

// --- settings (env-backed, editable dari web UI) ---
const SETTING_KEYS = ['ZERNIO_API_KEY', 'DAILY_HOUR', 'REGEN_SCOPE', 'REGEN_MAX', 'HF_MODEL'];
const SECRET_KEYS = new Set(['ZERNIO_API_KEY']);

function envWrite(key, value) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    text += (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
  }
  fs.writeFileSync(envPath, text);
  process.env[key] = value;
}

app.get('/api/settings', (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) {
    const v = process.env[k] || '';
    out[k] = SECRET_KEYS.has(k) && v ? v.slice(0, 3) + '…' + v.slice(-4) : v;
  }
  out._secrets = [...SECRET_KEYS];
  res.json(out);
});

app.put('/api/settings', express.json(), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!SETTING_KEYS.includes(k)) continue;
    if (typeof v !== 'string') continue;
    if (SECRET_KEYS.has(k) && v.includes('…')) continue; // nilai masked dikirim balik = tidak diubah
    envWrite(k, v.trim());
  }
  res.json({ ok: true });
});

// akun Zernio yang terhubung — buat isi ig_account_id di brand
app.get('/api/zernio/accounts', async (req, res) => {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) return res.status(400).json({ error: 'ZERNIO_API_KEY가 설정되지 않았습니다' });
  try {
    const r = await fetch('https://zernio.com/api/v1/accounts', { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(body).slice(0, 200) });
    const accounts = (body.data?.accounts || body.accounts || []).map(a => ({
      id: a._id, platform: a.platform, username: a.username || a.name || '',
    }));
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업이 없습니다' });
  if (job.status !== 'stock' && job.status !== 'failed') return res.status(400).json({ error: '자료함/실패 상태만 삭제할 수 있습니다' });
  db.prepare('DELETE FROM materials WHERE job_id=?').run(job.id);
  db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  fs.rmSync(path.join(UPLOADS, String(job.id)), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업이 없습니다' });
  if (job.status !== 'failed' && job.status !== 'stock') return res.status(400).json({ error: '실패했거나 대기 중인 작업만 실행할 수 있습니다' });
  db.prepare(`UPDATE jobs SET status='queued', error=NULL, updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), job.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id));
});

// --- files dari out/<post-id>/ (path traversal guard) ---
app.get('/files/:post/:file', (req, res) => {
  const p = path.resolve(OUT, req.params.post, req.params.file);
  if (!p.startsWith(OUT + path.sep)) return res.status(400).end();
  res.sendFile(p, err => { if (err && !res.headersSent) res.status(404).end(); });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Card News Studio: http://localhost:${PORT}`);
  worker.start();
});
