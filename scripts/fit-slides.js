// Usage: node scripts/fit-slides.js <dir>
// Reads <dir>/raw/* (any aspect), writes <dir>/slide-N.png at 1080x1350:
// image contained + centered on a blurred cover of itself (no cropping of slide text).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const dir = path.resolve(process.argv[2] || '');
const raw = path.join(dir, 'raw');
const files = fs.readdirSync(raw)
  .filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
  .sort();
if (!files.length) { console.error('tidak ada gambar di ' + raw); process.exit(1); }

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  for (let i = 0; i < files.length; i++) {
    const url = 'file://' + path.join(raw, files[i]);
    const html = `<!doctype html><style>
      *{margin:0}body{width:1080px;height:1350px;overflow:hidden;position:relative;background:#000}
      .bg{position:absolute;inset:-40px;background:url('${url}') center/cover no-repeat;filter:blur(40px) brightness(.6)}
      .fg{position:absolute;inset:0;background:url('${url}') center/contain no-repeat}
    </style><div class="bg"></div><div class="fg"></div>`;
    const tmp = path.join(dir, `.fit-tmp-${process.pid}.html`);
    fs.writeFileSync(tmp, html);
    await page.goto('file://' + tmp, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(dir, `slide-${i + 1}.png`) });
    fs.unlinkSync(tmp);
    console.log('fitted', `slide-${i + 1}.png`, '<-', files[i]);
  }
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
