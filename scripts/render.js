// Usage: node scripts/render.js out/<post-id>
// Expects out/<post-id>/content.json and out/<post-id>/backgrounds/slide-N.png
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const postDir = path.resolve(process.argv[2] || '.');
const content = JSON.parse(fs.readFileSync(path.join(postDir, 'content.json'), 'utf8'));
const templateDir = path.resolve(__dirname, '../template');
const template = fs.readFileSync(path.join(templateDir, content.template || 'slide.html'), 'utf8');

const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// **word** in headline → blue highlight span
const hl = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  const total = content.slides.length;

  for (let i = 0; i < total; i++) {
    const s = content.slides[i];
    const roleClass = { cover: 'cover', body: 'slide-body', cta: 'cta' }[s.role] || 'slide-body';
    const bg = path.join(postDir, 'backgrounds', `slide-${i + 1}.png`);
    const logoBlock = content.brand && content.brand.logo
      ? `<img class="logo-img" src="file://${path.resolve(templateDir, content.brand.logo)}">`
      : `<div class="logo">${esc(content.brand.name)}<span class="dot">.</span></div>`;
    const html = template
      .replace('{{role_class}}', roleClass)
      .replace('{{bg_url}}', fs.existsSync(bg) ? 'file://' + bg : '')
      .replace('{{logo_block}}', logoBlock)
      .replace('{{brand_name}}', esc(content.brand.name))
      .replace('{{number}}', s.number ? `<div class="number">${esc(s.number)}</div>` : '')
      .replace('{{source_chip}}', s.source ? `<div class="source-chip">${esc(s.source)}</div>` : '')
      .replace('{{page}}', i + 1)
      .replace('{{total}}', total)
      .replace('{{badge}}', s.badge ? `<div class="badge">${esc(s.badge)}</div>` : '')
      .replace('{{headline}}', hl(s.headline))
      .replace('{{body_block}}', s.role === 'cover'
        ? `<div class="sub">${esc(s.sub)}</div>`
        : s.body ? `<div class="body">${esc(s.body)}</div>` : '')
      .replace('{{cta_block}}', s.cta ? `<div class="button">${esc(s.cta)}</div>` : '')
      .replace('{{handle}}', esc(content.brand.handle))
      .replace('{{footer_right}}', i < total - 1 ? '밀어서 넘기기 →' : esc(content.brand.handle));

    // write next to template so brand.css relative link resolves
    const tmp = path.join(templateDir, `.render-tmp-${process.pid}.html`);
    fs.writeFileSync(tmp, html);
    await page.goto('file://' + tmp, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const outFile = path.join(postDir, `slide-${i + 1}.png`);
    await page.screenshot({ path: outFile });
    fs.unlinkSync(tmp);
    console.log('rendered', outFile);
  }

  fs.writeFileSync(path.join(postDir, 'caption.txt'), content.caption || '');
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
