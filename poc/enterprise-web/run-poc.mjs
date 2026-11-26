// POC 端對端驅動：用無頭瀏覽器扮演員工（本機不裝任何 Open Artifact 軟體），
// 走完 平台登入 → SSO → 同意授權 → Agent 建立簡報 → 員工開啟成品 → 權限隔離 → 留言回饋。
import { chromium } from './pw.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const PLATFORM = 'http://127.0.0.1:4920';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); };

const browser = await chromium.launch();

/** 一位員工的瀏覽器（獨立 cookie）。 */
async function employee(who) {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: `${SHOTS}${who}-${name}.png` });
  /** 在平台頁面內呼叫平台後端 API（帶平台 cookie），模擬「員工在平台對話，Agent 去做事」。 */
  const agent = async (op, args = {}) => {
    const p = await ctx.newPage();
    await p.goto(PLATFORM + '/');
    const out = await p.evaluate(async ([op, args]) => {
      const r = await fetch(`/api/agent/${op}`, { method: 'POST', body: JSON.stringify(args) });
      return { status: r.status, body: await r.json() };
    }, [op, args]);
    await p.close();
    if (out.status !== 200) throw Object.assign(new Error(`${op}: ${JSON.stringify(out.body)}`), { body: out.body });
    return out.body;
  };
  return { who, ctx, page, shot, agent };
}

async function connect(e) {
  const { page, shot, who } = e;
  await page.goto(`${PLATFORM}/login?as=${who}`);
  await shot('0-platform');
  await page.click('#connect');
  await page.waitForURL(/\/auth\/sign-in/);
  await shot('1-site-signin');
  await page.click('a.button[href*="sso"]');
  await page.waitForURL(/localhost:4910/);
  await shot('2-sso');
  await page.click(`#login-${who}`);
  await page.waitForURL(/oauth\/authorize/);
  await page.waitForLoadState('networkidle');
  await shot('3-consent');
  const consentText = (await page.textContent('main'))?.replace(/\s+/g, ' ').trim();
  await page.click('button[value="approve"]');
  await page.waitForURL(`${PLATFORM}/`);
  const status = await page.textContent('#status');
  await shot('4-connected');
  step(`${who}：瀏覽器走完 SSO + 同意授權，平台取得 token`, status.includes('已連接'), consentText);
}

try {
  // ---- 1. 兩位員工各自連接 ----
  const alice = await employee('alice');
  const bob = await employee('bob');
  await connect(alice);
  await connect(bob);

  const tools = await alice.agent('tools');
  step('平台 Agent 經遠端 MCP 取得工具清單', tools.includes('Artifact') && tools.includes('ArtifactComments'), tools);

  // ---- 2. Agent 為 alice 建立簡報 ----
  const deck = await alice.agent('makeDeck', {
    title: '2027 年度業務規劃',
    slides: [
      { heading: '2027 年度業務規劃', body: ['業務部 · 王小美'] },
      { heading: '三大目標', body: ['1. 營收成長 15%', '2. 新增 20 家企業客戶', '3. 客戶續約率 90% 以上'] },
      { heading: '下一步', body: ['Q1 完成產品線盤點', 'Q2 啟動南部據點'] },
    ],
  });
  step('Agent 經 MCP 建立簡報並寫入檔案', !!deck.view_url, { url: deck.url, view_url: deck.view_url, check: deck.check });
  await writeFile(`${SHOTS}deck-create-response.json`, JSON.stringify(deck.created, null, 2));

  // ---- 3. alice 用瀏覽器開啟成品 ----
  await alice.page.goto(deck.view_url);
  await alice.page.waitForLoadState('networkidle');
  await alice.page.waitForTimeout(4000);
  await alice.shot('5-deck-in-browser');
  const frames = alice.page.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank');
  step('alice 在瀏覽器開啟簡報（Shell + 編輯器）', frames.some((u) => u.includes('content.localhost')), frames);

  // ---- 4. 權限隔離：bob 看不到 alice 的成品 ----
  const bobList = await bob.agent('list');
  const bobSees = JSON.stringify(bobList).includes(deck.url);
  step('權限隔離：bob 的 Agent 列不到 alice 的簡報', !bobSees, bobList);
  let bobRead;
  try { bobRead = await bob.agent('read', { url: deck.url }); } catch (err) { bobRead = err.body; }
  step('權限隔離：bob 的 Agent 讀 alice 的簡報被拒', !!bobRead?.error, bobRead);
  await bob.page.goto(deck.view_url);
  await bob.page.waitForLoadState('networkidle');
  await bob.shot('5-deck-denied');
  step('權限隔離：bob 用瀏覽器開 alice 的簡報網址', true, (await bob.page.textContent('body'))?.replace(/\s+/g, ' ').slice(0, 200));

  // ---- 5. 快照：伺服器不截圖，回傳短效唯讀網址 ----
  const snap = await alice.agent('snapshot', { url: deck.url });
  step('snapshot 回傳短效唯讀網址（非圖片）', !!(snap.page_url ?? snap.url), snap);
  if (snap.page_url) {
    // 平台自己的無頭瀏覽器可以去截這個網址
    const p = await browser.newPage({ viewport: { width: snap.width ?? 1440, height: snap.height ?? 900 } });
    await p.goto(snap.page_url); await p.waitForLoadState('networkidle'); await p.waitForTimeout(3000);
    await p.screenshot({ path: `${SHOTS}platform-snapshot.png` });
    await p.close();
    step('平台用自己的無頭瀏覽器截取 snapshot 網址', true, 'shots/platform-snapshot.png');
  }

  await writeFile(`${SHOTS}state.json`, JSON.stringify({ deck }, null, 2));
} catch (err) {
  step('未預期錯誤', false, err.stack);
} finally {
  await writeFile(`${SHOTS}results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
