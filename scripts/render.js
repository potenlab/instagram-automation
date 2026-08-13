// Usage: node scripts/render.js out/<post-id>
// Expects out/<post-id>/content.json and out/<post-id>/backgrounds/slide-N.png
// content.template: "slide.html" (legacy single file) or a family dir ("modern", "ios")
// where each slide picks a layout file via slide.layout (fallback: manifest defaults per role).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fill = require('./fill');

const postDir = path.resolve(process.argv[2] || '.');
const content = JSON.parse(fs.readFileSync(path.join(postDir, 'content.json'), 'utf8'));
const templateRoot = path.resolve(__dirname, '../template');
const tplName = content.template || 'slide.html';
const isFamily = !tplName.endsWith('.html');

const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// **word** → highlight span
const hl = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>');

function logoBlock() {
  return content.brand && content.brand.logo
    ? `<img class="logo-img" src="file://${path.resolve(templateRoot, content.brand.logo)}">`
    : `<div class="logo">${esc(content.brand.name)}<span class="dot">.</span></div>`;
}

// Flatten one slide into a {{key}} data map for family templates.
function slideData(s, i, total) {
  const d = {
    page: i + 1,
    total,
    brand_name: esc(content.brand.name),
    brand_initial: esc((content.brand.name || 'P')[0]).toUpperCase(),
    handle: esc(content.brand.handle),
    logo_block: logoBlock(),
    source: esc(s.source || (content.source && content.source.publisher ? '@' + content.source.publisher : '')),
    headline: hl(s.headline),
    headline_lines: (s.headline || '').split('\n').filter(Boolean)
      .map(l => `<span class="line">${hl(l)}</span>`).join(''),
    sub: esc(s.sub),
    body: hl(s.body),
    badge: esc(s.badge),
    number: esc(s.number || String(i + 1).padStart(2, '0')),
    cta: esc(s.cta || '팔로우하고 소식받기'),
    tip: esc(s.tip),
    q: esc(s.q),
    note_hand: esc(s.note_hand),
    emoji: esc(s.emoji || '🫶'),
    // avatar: brand logo kalau ada; kosong → CSS gradient fallback (inline url('') akan menimpanya)
    avatar_style: content.brand && content.brand.logo
      ? `style="background-image:url('file://${path.resolve(templateRoot, content.brand.logo)}');background-color:#fff;background-size:70%;background-repeat:no-repeat;background-position:center"`
      : '',
    tags: (s.tags || []).map(t => '#' + String(t).replace(/^#/, '')).join('  '),
  };
  (s.items || []).slice(0, 3).forEach((it, j) => {
    d[`item${j + 1}_icon`] = esc(it.icon || '✦');
    d[`item${j + 1}_title`] = esc(it.title);
    d[`item${j + 1}_desc`] = esc(it.desc);
  });
  (s.chat || []).slice(0, 4).forEach((t, j) => { d[`chat${j + 1}`] = esc(t); });
  (s.notifs || []).slice(0, 2).forEach((n, j) => {
    d[`notif${j + 1}_icon`] = esc(n.icon || '✉️');
    d[`notif${j + 1}_title`] = esc(n.title);
    d[`notif${j + 1}_desc`] = esc(n.desc);
  });
  for (let j = 1; j <= 2; j++) {
    d[`notif${j}_icon`] = d[`notif${j}_icon`] || '✉️';
  }
  return d;
}

function familyHtml(s, i, total, bgUrl) {
  const familyDir = path.join(templateRoot, tplName);
  const manifest = JSON.parse(fs.readFileSync(path.join(familyDir, 'manifest.json'), 'utf8'));
  let layout = s.layout && fs.existsSync(path.join(familyDir, path.basename(String(s.layout))))
    ? path.basename(String(s.layout))
    : manifest.defaults[s.role] || manifest.defaults.body;
  const template = fs.readFileSync(path.join(familyDir, layout), 'utf8');
  return { dir: familyDir, html: fill(template, { ...slideData(s, i, total), bg_url: bgUrl }) };
}

function legacyHtml(s, i, total, bgUrl) {
  const template = fs.readFileSync(path.join(templateRoot, tplName), 'utf8');
  const roleClass = { cover: 'cover', body: 'slide-body', cta: 'cta' }[s.role] || 'slide-body';
  const html = template
    .replace('{{role_class}}', roleClass)
    .replace('{{bg_url}}', bgUrl)
    .replace('{{logo_block}}', logoBlock())
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
  return { dir: templateRoot, html };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  const total = content.slides.length;

  for (let i = 0; i < total; i++) {
    const s = content.slides[i];
    const bg = path.join(postDir, 'backgrounds', `slide-${i + 1}.png`);
    const bgUrl = fs.existsSync(bg) ? 'file://' + bg : '';
    const { dir, html } = isFamily ? familyHtml(s, i, total, bgUrl) : legacyHtml(s, i, total, bgUrl);

    // write next to template so relative css/asset links resolve
    const tmp = path.join(dir, `.render-tmp-${process.pid}.html`);
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
