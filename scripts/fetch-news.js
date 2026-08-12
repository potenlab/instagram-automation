// Usage: node scripts/fetch-news.js
// Ambil artikel terbaru yang belum pernah dipakai dari RSS_FEEDS (comma-separated),
// catat di out/.seen-urls.txt, print JSON {id, topic} untuk generate.sh.
// ponytail: parser RSS <item> saja (regex) — feed Atom (<entry>) belum didukung, tambah kalau perlu.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FEEDS = (process.env.RSS_FEEDS || 'https://techcrunch.com/feed/').split(',').map(s => s.trim());
const seenFile = path.join(ROOT, 'out', '.seen-urls.txt');
const seen = new Set(fs.existsSync(seenFile) ? fs.readFileSync(seenFile, 'utf8').split('\n') : []);

async function main() {
  const items = [];
  for (const feed of FEEDS) {
    const xml = await fetch(feed).then(r => r.text()).catch(() => '');
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const g = re => {
        const x = block.match(re);
        return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      };
      items.push({
        title: g(/<title>([\s\S]*?)<\/title>/),
        link: g(/<link>([\s\S]*?)<\/link>/),
        date: new Date(g(/<pubDate>([\s\S]*?)<\/pubDate>/) || 0),
        desc: g(/<description>([\s\S]*?)<\/description>/).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
      });
    }
  }
  const pick = items.filter(i => i.link && i.title && !seen.has(i.link)).sort((a, b) => b.date - a.date)[0];
  if (!pick) { console.error('tidak ada artikel baru di feed'); process.exit(1); }

  fs.mkdirSync(path.dirname(seenFile), { recursive: true });
  fs.appendFileSync(seenFile, pick.link + '\n');

  const slug = pick.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-');
  const id = new Date().toISOString().slice(0, 10) + '-' + slug;
  console.log(JSON.stringify({ id, topic: `${pick.title}\n${pick.link}\n\n${pick.desc}` }));
}

main().catch(err => { console.error(err); process.exit(1); });
