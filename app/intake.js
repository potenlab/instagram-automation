// Discord bot tunggal — semua brand, dibedakan hanya oleh channel ID (mapping di web UI 브랜드).
// - Mention @bot + gambar          → Mode A: gambar jadi slide final, AI tulis caption, preview + approval
// - Mention @bot + teks (± 브리프) → Mode B: brief masuk pipeline penuh (worker → generate.sh)
// - preview(jobId)                 → dipanggil worker setelah generate: post preview + approval di channel brand
// Butuh Message Content Intent aktif di Discord Developer Portal.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./db');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const UPLOADS = path.join(__dirname, 'uploads');

let client = null;

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function setStatus(id, status, error = null) {
  db.prepare('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?').run(status, error, now(), id);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).slice(-800)));
      else resolve(stdout);
    });
  });
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url.slice(0, 80)}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// claude -p: tulis caption dari gambar + pesan
function writeCaption(dir, brand, text) {
  return new Promise((resolve, reject) => {
    const slides = fs.readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f)).sort();
    let prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'discord-caption.md'), 'utf8');
    prompt += `\n## 브랜드\n${brand.name} (${brand.handle || ''})\n`;
    if (brand.prompt_rules) prompt += '\n## 브랜드 규칙\n' + brand.prompt_rules + '\n';
    prompt += `\n## 요청 메시지\n${text || '(없음)'}\n\n## 슬라이드 이미지\n`;
    for (const f of slides) prompt += `- ${path.join(dir, f)}\n`;
    const child = spawn('claude', ['-p', '--allowedTools', 'Read'], { cwd: ROOT });
    let out = '', errOut = '';
    child.stdin.end(prompt);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => errOut += d);
    child.on('error', reject);
    child.on('close', code => {
      const caption = out.trim();
      if (code !== 0 || !caption) return reject(new Error('caption gagal: ' + (errOut || out).slice(-300)));
      fs.writeFileSync(path.join(dir, 'caption.txt'), caption);
      resolve(caption);
    });
  });
}

function buttons(regenLabel, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('approve').setLabel('✅ 승인·게시').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('regen').setLabel(regenLabel).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function slideFiles(dir) {
  return fs.readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
    .map(f => path.join(dir, f));
}

async function publishJob(jobId, dir, brand, channel, press) {
  fs.writeFileSync(path.join(dir, 'approved'), now() + '\n');
  setStatus(jobId, 'approved');
  // key per brand (akun IG bisa beda workspace Zernio); kosong = 기본 키 di 설정
  const zernioKey = String(brand.zernio_api_key || '').trim() || process.env.ZERNIO_API_KEY;
  if (!zernioKey || !brand.ig_account_id) {
    return press.update({ content: `✅ **#${jobId}** — ${press.user.username}님이 승인했습니다 (Zernio/계정 미설정 — 게시 건너뜀)`, components: [] });
  }
  await press.update({ content: `⏳ **#${jobId}** — 승인됨, 인스타그램에 게시 중…`, components: [] });
  try {
    await run('node', [path.join(ROOT, 'scripts', 'publish.js'), dir],
      { env: { ...process.env, ZERNIO_API_KEY: zernioKey, ZERNIO_IG_ACCOUNT_ID: brand.ig_account_id } });
    setStatus(jobId, 'published');
    await channel.send(`🚀 **#${jobId}** — 인스타그램에 게시했습니다!`);
  } catch (e) {
    setStatus(jobId, 'failed', String(e.message).slice(0, 500));
    await channel.send(`❌ **#${jobId}** — 게시 실패: ${String(e.message).slice(0, 400)}`);
  }
}

// Loop preview + tombol. regen(attempt) melempar error kalau gagal; return caption baru.
async function approvalLoop({ channel, jobId, brand, dir, title, regenLabel, regenWait, maxRegen, regen }) {
  const caption = () => fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8');
  const content = attempt =>
    `📰 **#${jobId} ${brand.name}** — ${title}${attempt ? ` (재생성 ${attempt}/${maxRegen})` : ''}\n\n${caption()}`.slice(0, 2000);

  let attempt = 0;
  let msg = await channel.send({ content: content(attempt), files: slideFiles(dir), components: [buttons(regenLabel)] });
  setStatus(jobId, 'preview');

  for (;;) {
    const press = await msg.awaitMessageComponent({ time: 24 * 3600 * 1000 }).catch(() => null);
    if (!press) return msg.edit({ components: [buttons(regenLabel, true)] });

    if (press.customId === 'approve') return publishJob(jobId, dir, brand, channel, press);

    if (press.customId === 'cancel') {
      setStatus(jobId, 'failed', `취소됨 (${press.user.username})`);
      return press.update({ content: `❌ **#${jobId}** — 취소되었습니다.`, components: [] });
    }

    attempt++;
    if (attempt > maxRegen) {
      return press.update({ content: `⛔ **#${jobId}** — 재생성 한도(${maxRegen}회) 도달.`, components: [] });
    }
    await press.update({ content: `🔄 **#${jobId}** — 재생성 중 (${attempt}/${maxRegen})… ${regenWait}`, components: [] });
    try {
      await regen(attempt);
    } catch (e) {
      setStatus(jobId, 'failed', String(e.message).slice(0, 500));
      return channel.send(`❌ **#${jobId}** — 재생성 실패: ${String(e.message).slice(0, 300)}`);
    }
    msg = await channel.send({ content: content(attempt), files: slideFiles(dir), components: [buttons(regenLabel)] });
  }
}

// ---- dipanggil worker saat job gagal ----
// Tanpa ini, dari sisi Discord "gagal" dan "masih diproses" sama-sama sunyi.
async function notifyFailure(jobId, reason) {
  if (!client || !client.isReady()) return;
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return;
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(job.brand_id);
  if (!brand || !brand.discord_channel_id) return;
  const channel = await client.channels.fetch(brand.discord_channel_id);
  const detail = String(reason || '').trim().slice(-600) || '(원인 불명)';
  await channel.send(
    `❌ **#${jobId} ${brand.name}** — 생성 실패\n\`\`\`\n${detail}\n\`\`\`\n원인을 고친 뒤 웹 UI 대기열에서 다시 실행하세요. 브리프는 그대로 보관돼 있어요.`
      .slice(0, 2000));
}

// ---- dipanggil worker: preview + approval untuk job hasil pipeline ----
async function preview(jobId) {
  if (!client || !client.isReady()) throw new Error('Discord bot belum siap');
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(job.brand_id);
  const channel = await client.channels.fetch(brand.discord_channel_id);
  const dir = path.join(OUT, job.post_dir);
  const scope = process.env.REGEN_SCOPE || 'backgrounds';

  await approvalLoop({
    channel, jobId, brand, dir,
    title: '미리보기',
    regenLabel: scope === 'full' ? '🔄 전체 재생성' : '🔄 디자인 재생성',
    regenWait: '몇 분 정도 걸려요.',
    maxRegen: parseInt(process.env.REGEN_MAX || '3', 10),
    regen: async () => {
      const topicFile = path.join(dir, 'topic.txt');
      const topic = fs.existsSync(topicFile) ? fs.readFileSync(topicFile, 'utf8').trim() : '';
      if (scope === 'full' && !topic) throw new Error('REGEN_SCOPE=full butuh topic.txt');
      const del = scope === 'full' ? ['content.json', 'caption.txt'] : [];
      for (const f of fs.readdirSync(dir)) if (/^slide-\d+\.png$/.test(f) || /^job-\d+\.json$/.test(f)) del.push(f);
      for (const f of del) fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, 'backgrounds'), { recursive: true, force: true });
      await run(path.join(ROOT, 'scripts', 'generate.sh'), [job.post_dir, topic], {
        env: { ...process.env, TEMPLATE: job.template || brand.template || 'slide.html', BRAND_NAME: brand.name || '', BRAND_HANDLE: brand.handle || '' },
      });
    },
  });
}

// ---- Mode A: gambar jadi → fit 4:5 → caption → approval ----
async function handleUpload(message, brand, text, images) {
  const ts = now();
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
    VALUES (?, 'discord-upload', ?, 'generating', ?, ?)`).run(brand.id, text.slice(0, 500), ts, ts);
  const jobId = r.lastInsertRowid;
  const postDir = `${today()}-upload-j${jobId}`;
  db.prepare('UPDATE jobs SET post_dir=?, updated_at=? WHERE id=?').run(postDir, now(), jobId);
  const dir = path.join(OUT, postDir);
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });

  const status = await message.reply(`⏳ **#${jobId}** — 이미지 ${images.length}장 수신, 캡션 작성 중… (1–2분)`);
  try {
    for (let i = 0; i < images.length; i++) {
      const ext = (images[i].name || 'img.png').match(/\.\w+$/)?.[0] || '.png';
      await download(images[i].url, path.join(dir, 'raw', `${String(i + 1).padStart(2, '0')}${ext}`));
    }
    await run('node', [path.join(ROOT, 'scripts', 'fit-slides.js'), dir]);
    await writeCaption(dir, brand, text);
  } catch (e) {
    setStatus(jobId, 'failed', String(e.message).slice(0, 500));
    return status.edit(`❌ **#${jobId}** — 실패: ${String(e.message).slice(0, 300)}`);
  }
  await status.delete().catch(() => {});

  await approvalLoop({
    channel: message.channel, jobId, brand, dir,
    title: '업로드 미리보기',
    regenLabel: '🔄 캡션 재생성',
    regenWait: '1분 정도 걸려요.',
    maxRegen: 3,
    regen: () => writeCaption(dir, brand, text + '\n\n(이전 캡션과 다른 각도로 다시 써라)'),
  });
}

// ---- Mode B: brief → job queued, pipeline lama yang kerjakan ----
async function handleBrief(message, brand, text, images) {
  if (!text) return message.reply('브리프 내용이 비어 있어요. 텍스트를 함께 보내주세요.');
  const ts = now();
  const r = db.prepare(`INSERT INTO jobs(brand_id, mode, topic, status, created_at, updated_at)
    VALUES (?, 'discord-brief', ?, 'queued', ?, ?)`).run(brand.id, text.slice(0, 2000), ts, ts);
  const jobId = r.lastInsertRowid;
  if (images.length) {
    const mdir = path.join(UPLOADS, String(jobId));
    fs.mkdirSync(mdir, { recursive: true });
    const ins = db.prepare('INSERT INTO materials(job_id, filename, note) VALUES (?,?,?)');
    for (let i = 0; i < images.length; i++) {
      const name = `${String(i + 1).padStart(2, '0')}-${(images[i].name || 'img.png').replace(/[\\\/:*?"<>|\x00-\x1f]+/g, '_')}`;
      await download(images[i].url, path.join(mdir, name));
      ins.run(jobId, name, 'Discord 브리프 첨부');
    }
  }
  await message.reply(`📥 **#${jobId} ${brand.name}** — 브리프 접수! 생성 시작합니다 (완성되면 이 채널로 미리보기가 올라와요, 몇 분 소요).`);
}

async function handleMessage(message) {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;
  const brand = db.prepare('SELECT * FROM brands WHERE discord_channel_id=?').get(message.channel.id);
  if (!brand) return message.reply('이 채널은 브랜드와 연결되어 있지 않아요. 웹 UI 브랜드 설정에서 채널 ID를 등록해주세요.');

  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  const images = [...message.attachments.values()]
    .filter(a => (a.contentType || '').startsWith('image/'))
    .slice(0, 10);

  // gambar tanpa kata "브리프/brief" = slide jadi (Mode A); selain itu brief (Mode B)
  if (images.length && !/브리프|brief/i.test(text)) return handleUpload(message, brand, text, images);
  return handleBrief(message, brand, text, images);
}

function start() {
  if (!process.env.DISCORD_BOT_TOKEN) return console.log('intake: DISCORD_BOT_TOKEN kosong — bot tidak dijalankan');
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  client.on('messageCreate', m => handleMessage(m).catch(e => {
    console.error('intake:', e);
    m.reply('❌ 처리 중 오류: ' + String(e.message).slice(0, 200)).catch(() => {});
  }));
  client.once('clientReady', () => console.log(`intake: bot aktif sebagai ${client.user.tag}`));
  client.login(process.env.DISCORD_BOT_TOKEN).catch(e => console.error('intake login gagal:', e.message));
}

module.exports = { start, preview, notifyFailure };
