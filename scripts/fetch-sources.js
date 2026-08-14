// Ambil isi halaman referensi brand (web, Naver Place, blog) sebagai teks.
//
// Usage: node scripts/fetch-sources.js <brand_id>            → teks ke stdout
//        node scripts/fetch-sources.js --urls "a,b" [--out f]
//
// Halaman-halaman ini dirender JavaScript (potenstudio.xyz dan Naver Place
// dua-duanya mengirim cangkang kosong ke curl), jadi harus lewat browser.
const fs = require('fs');
const { chromium } = require('playwright');

const MAX_PER_PAGE = 6000;   // potong supaya prompt tidak membengkak

async function fetchOne(page, url) {
  // networkidle menggantung di situs yang menjaga koneksi terbuka (potenstudio.xyz),
  // jadi tunggu DOM lalu beri jeda untuk render klien.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  const text = await page.evaluate(() => {
    const main = document.querySelector('[role="main"]') || document.body;
    return main.innerText;
  });
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

  let urls = [];
  if (args.includes('--urls')) {
    urls = flag('--urls', '').split(/[,\n]/);
  } else {
    const brandId = parseInt(args[0], 10);
    if (!brandId) { console.error('usage: node scripts/fetch-sources.js <brand_id>'); process.exit(1); }
    const db = require('../app/db');
    const brand = db.prepare('SELECT source_urls FROM brands WHERE id=?').get(brandId);
    urls = String(brand?.source_urls || '').split(/[,\n]/);
  }
  urls = urls.map(u => u.trim()).filter(u => /^https?:\/\//.test(u));
  if (!urls.length) { process.exit(0); }   // tidak ada link = bukan error

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const blocks = [];
  for (const url of urls) {
    try {
      const text = await fetchOne(page, url);
      if (text.length < 40) throw new Error('halaman kosong / tidak ter-render');
      blocks.push(`### ${url}\n\n${text.slice(0, MAX_PER_PAGE)}`);
      console.error(`fetch-sources: ${url} → ${text.length} karakter`);
    } catch (e) {
      console.error(`fetch-sources: ${url} GAGAL — ${String(e.message).slice(0, 120)}`);
    }
  }
  await browser.close();

  if (!blocks.length) process.exit(0);
  const out = `## 참고 자료 (아래 링크에서 방금 읽어온 실제 내용)\n\n`
    + `가격·시설·후기 같은 사실은 반드시 아래 내용에서 가져와라. 여기 없는 숫자나 시설을 지어내지 마라.\n\n`
    + blocks.join('\n\n---\n\n') + '\n';

  const dest = flag('--out', '');
  if (dest) fs.writeFileSync(dest, out);
  else process.stdout.write(out);
}

main().catch(e => { console.error('fetch-sources:', e.message); process.exit(1); });
