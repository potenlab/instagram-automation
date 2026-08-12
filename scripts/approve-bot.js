// Usage: node scripts/approve-bot.js out/<post-id>
// Posts slide preview to Discord with Approve / Regenerate buttons.
// Env (.env): DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID,
//   REGEN_SCOPE=full|backgrounds  (full = tulis ulang copy + background; backgrounds = copy tetap, gambar baru)
//   REGEN_MAX=3                   (batas regenerate per sesi)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ponytail: .env parser 4 baris, dotenv tidak perlu
const ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const postDir = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(postDir, 'content.json'))) {
  console.error('usage: node scripts/approve-bot.js out/<post-id> (butuh content.json)');
  process.exit(1);
}
const postId = path.basename(postDir);
const SCOPE = process.env.REGEN_SCOPE || 'full';
const MAX = parseInt(process.env.REGEN_MAX || '3', 10);

function slideFiles() {
  return fs.readdirSync(postDir)
    .filter(f => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
    .map(f => path.join(postDir, f));
}

function wipeForRegen() {
  const del = [];
  if (SCOPE === 'full') del.push('content.json', 'caption.txt');
  for (const f of fs.readdirSync(postDir)) {
    if (/^slide-\d+\.png$/.test(f) || /^job-\d+\.json$/.test(f)) del.push(f);
  }
  for (const f of del) fs.rmSync(path.join(postDir, f), { force: true });
  fs.rmSync(path.join(postDir, 'backgrounds'), { recursive: true, force: true });
}

function regenerate() {
  const topicFile = path.join(postDir, 'topic.txt');
  const topic = fs.existsSync(topicFile) ? fs.readFileSync(topicFile, 'utf8').trim() : '';
  if (SCOPE === 'full' && !topic) throw new Error('REGEN_SCOPE=full butuh topic.txt di ' + postDir);
  wipeForRegen();
  execFileSync(path.join(ROOT, 'scripts/generate.sh'), [postId, topic], { stdio: 'inherit' });
}

const REGEN_LABEL = SCOPE === 'backgrounds' ? '🔄 디자인 재생성' : '🔄 전체 재생성';

function buttons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('approve').setLabel('✅ 승인').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('regen').setLabel(REGEN_LABEL).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

async function postPreview(channel, attempt) {
  const caption = fs.readFileSync(path.join(postDir, 'caption.txt'), 'utf8');
  const header = `📰 **${postId}** — 미리보기${attempt > 0 ? ` (재생성 ${attempt}/${MAX})` : ''}\n\n`;
  return channel.send({
    content: (header + caption).slice(0, 2000),
    files: slideFiles(),
    components: [buttons()],
  });
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);

  let attempt = 0;
  let msg = await postPreview(channel, attempt);
  console.log('preview posted:', msg.id);

  for (;;) {
    const press = await msg.awaitMessageComponent({ time: 24 * 3600 * 1000 }).catch(() => null);
    if (!press) {
      await msg.edit({ components: [buttons(true)] });
      console.log('timeout 24h, tidak ada keputusan');
      process.exit(1);
    }

    if (press.customId === 'approve') {
      fs.writeFileSync(path.join(postDir, 'approved'), new Date().toISOString() + '\n');
      if (process.env.ZERNIO_API_KEY && process.env.ZERNIO_IG_ACCOUNT_ID) {
        await press.update({ content: `⏳ **${postId}** — 승인됨, 인스타그램에 게시 중…`, components: [] });
        try {
          execFileSync('node', [path.join(__dirname, 'publish.js'), postDir], { stdio: 'inherit' });
          await channel.send(`🚀 **${postId}** — 인스타그램에 게시했습니다!`);
        } catch (e) {
          await channel.send(`❌ **${postId}** — 게시 실패: ${String(e.message).slice(0, 500)}`);
          process.exit(1);
        }
      } else {
        await press.update({ content: `✅ **${postId}** — ${press.user.username}님이 승인했습니다 (Zernio 미설정 — 게시 건너뜀)`.slice(0, 2000), components: [] });
      }
      console.log('approved');
      process.exit(0);
    }

    // regen
    attempt++;
    if (attempt > MAX) {
      await press.update({ content: `⛔ **${postId}** — 재생성 한도(${MAX}회)에 도달했습니다.`, components: [] });
      process.exit(1);
    }
    await press.update({ content: `🔄 **${postId}** — 재생성 중 (${attempt}/${MAX})… 몇 분 정도 걸려요.`, components: [] });
    try {
      regenerate();
    } catch (e) {
      await channel.send(`❌ **${postId}** — 재생성 실패: ${String(e.message).slice(0, 500)}`);
      process.exit(1);
    }
    msg = await postPreview(channel, attempt);
    console.log('re-posted:', msg.id);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
