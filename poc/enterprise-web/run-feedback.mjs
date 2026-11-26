// POC 第二段：員工在成品頁面上回饋 → 平台 Agent（遠端 MCP 長輪詢）收到 → 修改成品並回覆 → 員工在瀏覽器看到。
// A. 「問 Agent」面板送出修改要求（ask_…，沒有 thread，Agent 在平台自己的對話裡回覆）
// B. 在投影片上留言並勾選「Send to Agent」（comment thread，Agent 可在 thread 內回覆並結案）
import { chromium } from './pw.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const PLATFORM = 'http://127.0.0.1:4920';
const { deck } = JSON.parse(await readFile('shots/state.json', 'utf8'));
const results = JSON.parse(await readFile('shots/results.json', 'utf8')).filter((r) => !r.name.startsWith('[回饋]') && !r.name.startsWith('[回饋'));
const step = (name, ok, detail) => { results.push({ name: `[回饋] ${name}`, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); };

const browser = await chromium.launch();
const platCtx = await browser.newContext();
const plat = await platCtx.newPage();
await plat.goto(`${PLATFORM}/login?as=alice`);
const agent = async (op, args = {}) => {
  const out = await plat.evaluate(async ([op, args]) => {
    const r = await fetch(`/api/agent/${op}`, { method: 'POST', body: JSON.stringify(args) });
    return { status: r.status, body: await r.json() };
  }, [op, args]);
  if (out.status !== 200) throw new Error(`${op}: ${JSON.stringify(out.body)}`);
  return out.body;
};
const editSlide2 = async (from, to) => {
  const file = await agent('read', { url: deck.url, path: 'project/slides/s-poc2.html' });
  const next = file.content.replace(from, to);
  return agent('publishFiles', { url: deck.url, files: { 'project/slides/s-poc2.html': next } });
};

const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 }, storageState: 'shots/alice-state.json' });
const page = await ctx.newPage();
const slideText = async () => (await Promise.all(page.frames().map((f) => f.content().catch(() => '')))).join('\n');

try {
  // ---------- A. 問 Agent ----------
  let t0 = Date.now();
  let waiting = agent('wait', { url: deck.url, timeout: 60000 });
  await page.goto(deck.view_url); await page.waitForLoadState('networkidle'); await page.waitForTimeout(2500);
  await page.click('button[title*="发消息"]'); await page.waitForTimeout(800);
  await page.fill('textarea[placeholder="想改什么？"]', '第二頁的目標請加上「4. 導入 AI 客服，回覆時間縮短 50%」');
  await page.screenshot({ path: 'shots/alice-6-ask-panel.png' });
  await page.click('button:has-text("发给")');
  let got = await waiting;
  const askText = (got.wake_texts ?? []).join('\n');
  step(`A. 「問 Agent」訊息經 ArtifactComments wait 送達平台（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`, askText.includes('AI 客服'), askText);
  await writeFile('shots/wait-ask.json', JSON.stringify(got, null, 2));
  await editSlide2('<p>3. 客戶續約率 90% 以上</p>', '<p>3. 客戶續約率 90% 以上</p><p>4. 導入 AI 客服，回覆時間縮短 50%</p>');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'shots/alice-7-after-ask.png' });
  step('A. Agent 修改後，員工畫面即時更新（不用重新整理）', (await slideText()).includes('導入 AI 客服'));

  // ---------- B. 留言 thread ----------
  await page.goto(deck.view_url + '#slide-~s-poc2'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(2500);
  t0 = Date.now();
  waiting = agent('wait', { url: deck.url, timeout: 60000 });
  await page.click('button[aria-label="评论"]'); await page.waitForTimeout(800);
  await page.mouse.click(660, 600); await page.waitForTimeout(1200);
  const frame = page.frames().find((f) => f.url().includes('content.localhost'));
  await frame.fill('textarea[aria-label="Comment"]', '「營收成長 15%」改成 18%');
  await frame.click('text=Send to');
  await page.screenshot({ path: 'shots/alice-8-comment.png' });
  await frame.click('button[aria-label="Send"]');
  got = await waiting;
  const commentText = (got.wake_texts ?? []).join('\n');
  step(`B. 留言（勾選 Send to Agent）經 wait 送達平台（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`, commentText.includes('18%'), commentText);
  await writeFile('shots/wait-comment.json', JSON.stringify(got, null, 2));

  const threads = await agent('comments', { url: deck.url });
  await writeFile('shots/comments-read.json', JSON.stringify(threads, null, 2));
  const thread = (threads.threads ?? []).find((t) => JSON.stringify(t).includes('18%'));
  const threadId = thread?.id ?? thread?.thread_id;
  step('B. Agent 用 ArtifactComments read 找到 thread', !!threadId, thread);
  await editSlide2('營收成長 15%', '營收成長 18%');
  if (threadId) {
    const rep = await agent('reply', { url: deck.url, thread_id: threadId, text: '已改為 18%。', resolve: true });
    step('B. Agent 在 thread 內回覆並結案', !rep.error, rep);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'shots/alice-9-after-reply.png' });
  const now = await slideText();
  step('B. 員工畫面看到內容改為 18%', now.includes('營收成長 18%'));
  let seen = false;
  for (const f of page.frames()) { if (await f.getByText('已改為 18%').count().catch(() => 0)) seen = true; }
  step('B. 員工畫面看到 Agent 在 thread 的回覆', seen);
  // 觀察：Shell 上「問 Agent」訊息的狀態與 Agent 狀態指示
  const shellText = (await page.textContent('body')).replace(/\s+/g, ' ');
  step('觀察：Shell 上「問 Agent」訊息狀態', true, shellText.includes('等 Agent 接收') ? '仍顯示「等 Agent 接收」' : '已更新');
} catch (err) {
  step('未預期錯誤', false, err.stack);
} finally {
  await writeFile('shots/results.json', JSON.stringify(results, null, 2));
  await browser.close();
}
