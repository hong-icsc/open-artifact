// 取得環境中已安裝的 Playwright（CommonJS 套件，ESM 不會走 NODE_PATH）
import { createRequire } from 'node:module';
export const { chromium } = createRequire(import.meta.url)('playwright');
