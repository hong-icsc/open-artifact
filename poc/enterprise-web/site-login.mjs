// 讓 alice 的瀏覽器以公司 SSO 登入 Site，並保存 cookie 給 run-feedback.mjs 使用。
import { chromium } from './pw.mjs';
import { readFile } from 'node:fs/promises';
const { deck } = JSON.parse(await readFile('shots/state.json', 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:4900/auth/sign-in?return_to=' + encodeURIComponent(new URL(deck.view_url).pathname));
await page.click('a.button[href*="sso"]'); await page.click('#login-alice');
await page.waitForURL(/\/a\//); await page.waitForLoadState('networkidle'); await page.waitForTimeout(3000);
await ctx.storageState({ path: 'shots/alice-state.json' });
await browser.close();
