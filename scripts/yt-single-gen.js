// Posting tunggal dari video YouTube: GPT Image (Higgsfield) menggambar ulang
// poster dari thumbnail, caption ditulis AI dari konteks video.
//
// Usage: node scripts/yt-single-gen.js <post-dir>
// Butuh: <post-dir>/topic.txt (info video) + <post-dir>/materials/*.jpg (thumbnail)
// Idempotent: slide-1.png sudah ada → langsung selesai. Hapus untuk regenerate.
// Env: BRAND_NAME, BRAND_HANDLE (opsional, untuk caption)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dir = path.resolve(process.argv[2] || '');
if (!fs.existsSync(dir)) { console.error('usage: node scripts/yt-single-gen.js <post-dir>'); process.exit(1); }

const MODEL = process.env.YT_IMAGE_MODEL || 'gpt_image_2';

function claude(prompt, tools) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--allowedTools', tools], { cwd: ROOT });
    let out = '', err = '';
    child.stdin.end(prompt);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('claude exit ' + code + ': ' + (err || out).slice(-300)));
      resolve(out);
    });
  });
}

// badge YouTube ditempel setelah fit — deterministik, bukan hasil gambar AI
async function overlayBadge(channelName) {
  const { chromium } = require('playwright');
  const slide = path.join(dir, 'slide-1.png');
  const html = `<!doctype html><style>
    *{margin:0}body{width:1080px;height:1350px;position:relative;overflow:hidden}
    .bg{position:absolute;inset:0;background:url('file://${slide}') center/cover no-repeat}
    .badge{position:absolute;left:48px;bottom:48px;display:flex;align-items:center;gap:14px;
      background:rgba(0,0,0,.55);backdrop-filter:blur(6px);border-radius:999px;
      padding:14px 26px 14px 16px;font-family:-apple-system,'Pretendard',sans-serif}
    .play{width:44px;height:31px;background:#FF0033;border-radius:8px;position:relative}
    .play::after{content:'';position:absolute;left:17px;top:8px;
      border-left:14px solid #fff;border-top:7.5px solid transparent;border-bottom:7.5px solid transparent}
    .t{color:#fff;font-size:21px;font-weight:700;letter-spacing:.02em}
    .t small{display:block;font-size:14px;font-weight:500;opacity:.85;letter-spacing:.12em;text-transform:uppercase}
  </style>
  <div class="bg"></div>
  <div class="badge"><div class="play"></div>
    <div class="t"><small>ON YOUTUBE</small>${channelName}</div></div>`;
  const tmp = path.join(dir, `.badge-tmp-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  await page.goto('file://' + tmp, { waitUntil: 'networkidle' });
  await page.screenshot({ path: slide });
  await browser.close();
  fs.unlinkSync(tmp);
}

async function main() {
  if (fs.existsSync(path.join(dir, 'slide-1.png'))) { console.log('slide-1.png sudah ada — selesai.'); return; }
  const topic = fs.readFileSync(path.join(dir, 'topic.txt'), 'utf8');
  const channelName = (topic.match(/- 채널:\s*(.+)/) || [])[1] || 'YouTube';
  const mats = path.join(dir, 'materials');
  const thumb = fs.readdirSync(mats).find(f => /\.(jpe?g|png|webp)$/i.test(f));
  if (!thumb) throw new Error('thumbnail tidak ada di materials/');
  const thumbPath = path.join(mats, thumb);

  // gambar sudah pernah dibuat (raw/01.png ada) → langsung fit + badge, tanpa
  // bayar claude/higgsfield lagi
  if (fs.existsSync(path.join(dir, 'raw', '01.png'))) {
    console.log('== raw ada — fit + badge saja ==');
    execFileSync('node', [path.join(ROOT, 'scripts', 'fit-slides.js'), dir], { stdio: 'inherit' });
    await overlayBadge(channelName);
    console.log('selesai: ' + path.join(dir, 'slide-1.png'));
    return;
  }

  // 1. claude: lihat thumbnail + konteks video → prompt gambar + caption
  console.log('== claude -p: prompt gambar + caption ==');
  const brandName = process.env.BRAND_NAME || 'Potenstudio';
  const prompt = `너는 인스타그램 브랜드 계정(${brandName}, ${process.env.BRAND_HANDLE || ''})의 디자이너 겸 카피라이터다.

아래 유튜브 영상의 썸네일을 **Read 도구로 실제로 열어서 본 뒤**, 이 썸네일을 바탕으로
인스타그램 피드에 올릴 **한 장짜리 포스터**를 만들 준비를 해라.

## 썸네일
${thumbPath}

## 영상 정보
${topic.slice(0, 4000)}

## 출력 — JSON만. 마크다운 펜스·설명 금지.
{
  "image_prompt": "GPT 이미지 모델에 줄 영어 프롬프트. 첨부된 썸네일 이미지를 재해석해 세련된 인스타그램 포스터로 만들어라: 원본 인물·장면의 느낌은 유지하되 지저분한 유튜브 텍스트/화살표는 빼고, 미니멀한 편집 디자인. 짧은 영문 타이틀 텍스트 하나 정도는 포스터에 넣어도 된다 (한글 텍스트는 넣지 마라 — 모델이 한글을 자주 틀린다). 세로 3:4 구도.",
  "caption": "인스타그램 캡션 (한국어). 이 크리에이터/영상이 ${brandName}에서 촬영됐다는 걸 담백하게 알린다. 과장·이모지 남발 금지, 2–4문장 + 해시태그 3–5개."
}`;
  const raw = await claude(prompt, 'Read');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('output claude bukan JSON: ' + raw.slice(0, 200));
  const plan = JSON.parse(raw.slice(a, b + 1));
  if (!plan.image_prompt || !plan.caption) throw new Error('image_prompt/caption kosong');
  fs.writeFileSync(path.join(dir, 'caption.txt'), String(plan.caption).trim());

  // 2. higgsfield GPT Image: thumbnail sebagai referensi
  console.log(`== higgsfield ${MODEL}: generate poster ==`);
  const out = execFileSync('higgsfield', ['generate', 'create', MODEL,
    '--prompt', String(plan.image_prompt).slice(0, 2000),
    '--image-references', thumbPath,
    '--aspect_ratio', '3:4', '--quality', 'high', '--wait', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, 'job-image.json'), out);
  const url = (out.match(/"result_url"\s*:\s*"([^"]+)"/) || [])[1]
    || (JSON.stringify(JSON.parse(out)).match(/https?:[^"]+\.(?:png|jpe?g|webp)[^"]*/) || [])[0];
  if (!url) throw new Error('result_url tidak ada — cek job-image.json');

  const rawDir = path.join(dir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  execFileSync('curl', ['-sSfL', url, '-o', path.join(rawDir, '01.png')]);

  // 3. fit ke 1080x1350 + badge YouTube
  console.log('== fit 1080x1350 + badge ==');
  execFileSync('node', [path.join(ROOT, 'scripts', 'fit-slides.js'), dir], { stdio: 'inherit' });
  await overlayBadge(channelName);
  console.log('selesai: ' + path.join(dir, 'slide-1.png'));
}

main().catch(e => { console.error('yt-single-gen:', e.message); process.exit(1); });
