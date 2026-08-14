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
const BRAND_FIELDS = ['name', 'handle', 'discord_channel_id', 'ig_account_id', 'rss_feeds', 'template', 'prompt_rules', 'zernio_api_key', 'drive_folder_id'];
const TEMPLATE_IDX = BRAND_FIELDS.indexOf('template');
const brandBody = b => BRAND_FIELDS.map(f => String(b[f] ?? ''));

// key tidak pernah dikirim utuh ke browser — sama seperti /api/settings
const maskKey = v => (v ? v.slice(0, 3) + '…' + v.slice(-4) : '');
const brandOut = b => (b ? { ...b, zernio_api_key: maskKey(b.zernio_api_key || '') } : b);
const isMasked = v => String(v ?? '').includes('…');

app.get('/api/brands', (req, res) => {
  res.json(db.prepare('SELECT * FROM brands ORDER BY id').all().map(brandOut));
});

app.post('/api/brands', express.json(), (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: '이름은 필수입니다' });
  const body = { ...req.body };
  if (isMasked(body.zernio_api_key)) body.zernio_api_key = '';
  const vals = brandBody(body);
  if (!vals[TEMPLATE_IDX]) vals[TEMPLATE_IDX] = 'slide.html';
  const r = db.prepare(`INSERT INTO brands(${BRAND_FIELDS.join(',')}, created_at)
      VALUES (${BRAND_FIELDS.map(() => '?').join(',')}, ?)`)
    .run(...vals, new Date().toISOString());
  res.json(brandOut(db.prepare('SELECT * FROM brands WHERE id=?').get(r.lastInsertRowid)));
});

app.put('/api/brands/:id', express.json(), (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: '브랜드가 없습니다' });
  const merged = { ...brand, ...req.body };
  // nilai masked dikirim balik dari form = key tidak diubah
  if (isMasked(req.body?.zernio_api_key)) merged.zernio_api_key = brand.zernio_api_key || '';
  db.prepare(`UPDATE brands SET ${BRAND_FIELDS.map(f => f + '=?').join(',')} WHERE id=?`)
    .run(...brandBody(merged), brand.id);
  res.json(brandOut(db.prepare('SELECT * FROM brands WHERE id=?').get(brand.id)));
});

app.delete('/api/brands/:id', (req, res) => {
  db.prepare('DELETE FROM brands WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- templates (families + preview untuk picker di 자료함) ---
const fill = require('../scripts/fill');
const TPL_ROOT = path.join(ROOT, 'template');

function templateCatalog() {
  const out = [
    { id: 'slide.html', name: '기본 (다크)', layouts: [], previews: [{ name: '미리보기', url: '/tpl-preview/slide.html' }] },
    { id: 'slide-light.html', name: '기본 (라이트)', layouts: [], previews: [{ name: '미리보기', url: '/tpl-preview/slide-light.html' }] },
  ];
  for (const d of fs.readdirSync(TPL_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mf = path.join(TPL_ROOT, d.name, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const layouts = fs.readdirSync(path.join(TPL_ROOT, d.name)).filter(f => f.endsWith('.html')).sort();
    out.push({
      id: d.name, name: manifest.name || d.name, layouts,
      previews: layouts.map(l => ({ name: l.replace('.html', ''), url: `/tpl-preview/${d.name}/${l}` })),
    });
  }
  return out;
}

app.get('/api/templates', (req, res) => res.json(templateCatalog()));

// sample data — semua {{key}} yang dipakai layout mana pun
const SAMPLE_BG = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="135"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b4d63"/><stop offset=".55" stop-color="#3c6e71"/><stop offset="1" stop-color="#b8874f"/></linearGradient></defs><rect width="108" height="135" fill="url(#g)"/></svg>`);
const TPL_SAMPLE = {
  logo_block: '<div class="logo">브랜드<span class="dot">.</span></div>',
  brand_name: '브랜드', brand_initial: 'B', handle: '@brand', source: '@출처',
  page: 2, total: 6, bg_url: SAMPLE_BG,
  headline: '인스타 카드뉴스\n<span class="hl">타이틀</span>',
  headline_lines: '<span class="line">인스타 카드뉴스</span><span class="line"><span class="hl">타이틀</span></span>',
  sub: '서브 타이틀', body: '내용을 작성해주세요.\n중요한 부분은 <span class="hl">하이라이트</span> 처리돼요.',
  badge: 'TOPIC', number: '01', cta: '팔로우하고 소식받기', tip: 'tip 내용을 작성해주세요',
  q: '질문을 작성해주세요.', note_hand: 'Check this out!', emoji: '🫶', avatar_style: '',
  tags: '#키워드  #키워드  #키워드',
  item1_icon: '💡', item1_title: '제목', item1_desc: '한 줄 설명',
  item2_icon: '🚀', item2_title: '제목', item2_desc: '한 줄 설명',
  item3_icon: '✨', item3_title: '제목', item3_desc: '한 줄 설명',
  chat1: '질문 있어요!', chat2: '이거 어떻게 해요?', chat3: '답변을 작성해주세요.', chat4: '자세한 내용은 다음 장에!',
  notif1_icon: '✉️', notif1_title: 'Title', notif1_desc: 'Description.',
  notif2_icon: '🔔', notif2_title: 'Title', notif2_desc: 'Description.',
};

// legacy single-file templates (template root) — placeholder set beda dari family
app.get('/tpl-preview/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(TPL_ROOT, file);
  if (!file.endsWith('.html') || !fs.existsSync(p)) return res.status(404).end();
  const css = file.includes('light') ? 'brand-light.css' : 'brand.css';
  const html = fill(fs.readFileSync(p, 'utf8'), {
    ...TPL_SAMPLE,
    role_class: 'cover',
    badge: '<div class="badge">TOPIC</div>',
    number: '',
    source_chip: '',
    body_block: '<div class="sub">서브 타이틀 — 내용을 작성해주세요</div>',
    cta_block: '',
    footer_right: '밀어서 넘기기 →',
  }).replace(`href="${css}"`, `href="/tpl-src/${css}"`);
  res.type('html').send(html);
});

app.get('/tpl-preview/:family/:file', (req, res) => {
  const p = path.resolve(TPL_ROOT, req.params.family, req.params.file);
  if (!p.startsWith(TPL_ROOT + path.sep) || !p.endsWith('.html') || !fs.existsSync(p)) return res.status(404).end();
  // layout dirender via file:// saat produksi, jadi link-nya relatif — di preview
  // (URL) style.css dan ../assets/* harus diarahkan ke /tpl-src
  const html = fill(fs.readFileSync(p, 'utf8'), TPL_SAMPLE)
    .replace('href="style.css"', `href="/tpl-src/${req.params.family}/style.css"`)
    .replace(/["']\.\.\/assets\//g, '"/tpl-src/assets/');
  res.type('html').send(html);
});
app.use('/tpl-src', express.static(TPL_ROOT));

// --- jobs ---
const upload = multer({
  dest: path.join(UPLOADS, 'tmp'),
  limits: { files: 10, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.post('/api/jobs', upload.array('materials', 10), (req, res) => {
  const { brand_id, topic, note, template } = req.body || {};
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brand_id);
  if (!brand) return res.status(400).json({ error: '브랜드를 선택하세요' });
  const files = req.files || [];
  if ((!topic || !topic.trim()) && !files.length) return res.status(400).json({ error: '주제 또는 자료 이미지를 넣어주세요' });

  const tpl = templateCatalog().some(t => t.id === template) ? template : null; // null = ikut default brand
  const mode = files.length ? 'materials' : 'topic';
  const ts = new Date().toISOString();
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, template, created_at, updated_at)
    VALUES (?, ?, ?, 'stock', ?, ?, ?)`).run(brand.id, mode, (topic || '').trim(), tpl, ts, ts);
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

// akun Zernio yang terhubung — buat isi ig_account_id di brand.
// key: ?key=sk_… (yang sedang diketik di form) → ?brand_id=N (key tersimpan brand itu) → 기본 키 di 설정
app.get('/api/zernio/accounts', async (req, res) => {
  let key = String(req.query.key || '').trim();
  if (isMasked(key)) key = '';
  if (!key && req.query.brand_id) {
    const b = db.prepare('SELECT zernio_api_key FROM brands WHERE id=?').get(req.query.brand_id);
    key = String(b?.zernio_api_key || '').trim();
  }
  if (!key) key = process.env.ZERNIO_API_KEY || '';
  if (!key) return res.status(400).json({ error: 'Zernio API 키가 없습니다 — 브랜드에 입력하거나 설정에서 기본 키를 넣어주세요' });
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
  require('./intake').start();
});
