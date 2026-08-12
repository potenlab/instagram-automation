// Publish approved post ke Instagram via Zernio.
// Usage: node scripts/publish.js out/<post-id>
//        node scripts/publish.js --accounts   (list akun terhubung, buat ambil accountId)
// Env (.env): ZERNIO_API_KEY, ZERNIO_IG_ACCOUNT_ID
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const API = 'https://zernio.com/api/v1';
const KEY = process.env.ZERNIO_API_KEY;
if (!KEY) { console.error('ZERNIO_API_KEY belum diisi di .env'); process.exit(1); }

async function zfetch(p, opts = {}) {
  const res = await fetch(API + p, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function uploadSlide(file) {
  const { uploadUrl, publicUrl } = await zfetch('/media/presign', {
    method: 'POST',
    body: JSON.stringify({ filename: path.basename(file), contentType: 'image/png' }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: fs.readFileSync(file) });
  if (!put.ok) throw new Error(`upload ${path.basename(file)} -> ${put.status}`);
  return publicUrl;
}

async function main() {
  if (process.argv[2] === '--accounts') {
    const res = await zfetch('/accounts');
    for (const a of res.data?.accounts || res.accounts || []) {
      console.log(`${a._id}\t${a.platform}\t${a.username || a.name || ''}`);
    }
    return;
  }

  const postDir = path.resolve(process.argv[2] || '');
  const accountId = process.env.ZERNIO_IG_ACCOUNT_ID;
  if (!accountId) { console.error('ZERNIO_IG_ACCOUNT_ID belum diisi — jalankan: node scripts/publish.js --accounts'); process.exit(1); }
  const caption = fs.readFileSync(path.join(postDir, 'caption.txt'), 'utf8').slice(0, 2200);
  const slides = fs.readdirSync(postDir)
    .filter(f => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
    .slice(0, 10)
    .map(f => path.join(postDir, f));
  if (!slides.length) { console.error('tidak ada slide-N.png di ' + postDir); process.exit(1); }

  const mediaItems = [];
  for (const file of slides) {
    console.log('upload', path.basename(file));
    mediaItems.push({ type: 'image', url: await uploadSlide(file) });
  }

  const post = await zfetch('/posts', {
    method: 'POST',
    body: JSON.stringify({
      content: caption,
      mediaItems,
      platforms: [{ platform: 'instagram', accountId }],
      publishNow: true,
    }),
  });
  fs.writeFileSync(path.join(postDir, 'published.json'), JSON.stringify(post, null, 2));
  console.log('published:', JSON.stringify(post).slice(0, 300));
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
