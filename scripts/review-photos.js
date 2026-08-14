// AI melihat tiap foto kandidat, menilainya, lalu merekomendasikan yang layak pakai
// beserta sudut pandang postingannya.
//
// Usage: node scripts/review-photos.js <job_id>   → JSON ke stdout
//
// Output: { "angle": "...", "photos": [{ "file","verdict","reason" }], "picks": ["file", ...] }
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../app/db');

const ROOT = path.resolve(__dirname, '..');
const UPLOADS = path.join(ROOT, 'app', 'uploads');

const PROMPT = `너는 인스타그램 브랜드 계정을 운영하는 아트 디렉터다.

아래 사진들을 **Read 도구로 한 장씩 실제로 열어서 본 뒤** 게시물에 쓸 만한지 판정해라.
파일명만 보고 판단하지 마라 — 반드시 이미지를 열어봐야 한다.

## 판정 기준 — 엄격하게

떨어뜨려야 할 사진:
- 흐리거나 초점이 나갔다
- 노출이 무너졌다 (너무 어둡거나 날아갔다)
- 잡동사니·전선·쓰레기통 등 정리 안 된 것이 눈에 띈다
- 구도가 기울었거나 잘렸다
- 다른 사진과 거의 같은 각도라 중복이다 (그중 제일 나은 하나만 남겨라)
- 얼굴이 알아볼 수 있게 찍힌 사람이 있다 (초상권)
- 화면 캡처, 도면, 문서 스캔처럼 사진이 아닌 것 (배경으로는 부적합)

**"쓸 수 있다" 수준은 통과시키지 마라. 정말 좋은 것만 고른다.**
좋은 게 하나뿐이면 하나만 골라라. 하나도 없으면 picks를 빈 배열로 둬라.

## 출력

**JSON만 출력해라.** 마크다운 펜스·설명·인사말 금지.

{
  "angle": "이 사진들로 만들 게시물의 구체적인 방향 한 문장 (한국어)",
  "photos": [
    { "file": "파일명", "verdict": "good" | "ok" | "bad", "reason": "한국어로 15자 내외, 무엇이 좋거나 나쁜지 구체적으로" }
  ],
  "picks": ["실제로 쓸 파일명만, 좋은 순서대로"]
}

reason은 "좋다" 같은 말 말고 구체적으로 써라 — "조명 고르고 정면 구도", "왼쪽에 전선 노출", "3번과 같은 각도" 처럼.

## 사진 목록
`;

function main() {
  const jobId = parseInt(process.argv[2], 10);
  if (!jobId) { console.error('usage: node scripts/review-photos.js <job_id>'); process.exit(1); }
  const mats = db.prepare('SELECT * FROM materials WHERE job_id=? ORDER BY id').all(jobId);
  if (!mats.length) { console.error('tidak ada bahan'); process.exit(1); }
  const dir = path.join(UPLOADS, String(jobId));

  let prompt = PROMPT;
  for (const m of mats) {
    const p = path.join(dir, m.filename);
    if (fs.existsSync(p)) prompt += `- ${p}\n`;
  }

  const child = spawn('claude', ['-p', '--allowedTools', 'Read'], { cwd: ROOT });
  let out = '', err = '';
  child.stdin.end(prompt);
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('error', e => { console.error('claude:', e.message); process.exit(1); });
  child.on('close', code => {
    if (code !== 0) { console.error('claude exit ' + code + ': ' + (err || out).slice(-300)); process.exit(1); }
    const a = out.indexOf('{'), b = out.lastIndexOf('}');
    if (a < 0 || b < a) { console.error('bukan JSON: ' + out.slice(0, 300)); process.exit(1); }
    let parsed;
    try { parsed = JSON.parse(out.slice(a, b + 1)); }
    catch (e) { console.error('JSON rusak: ' + e.message); process.exit(1); }

    // hanya file yang benar-benar ada yang boleh lolos
    const valid = new Set(mats.map(m => m.filename));
    parsed.picks = (parsed.picks || []).map(f => path.basename(String(f))).filter(f => valid.has(f));
    parsed.photos = (parsed.photos || []).filter(p => valid.has(path.basename(String(p.file || ''))));
    process.stdout.write(JSON.stringify(parsed));
  });
}

main();
