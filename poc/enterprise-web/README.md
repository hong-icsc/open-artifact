# POC：企業 AI Agent 平台＋Open Artifact，員工只用瀏覽器

驗證題目：企業自建的 AI Agent 平台（Web），讓員工只用瀏覽器就能使用 Open Artifact 的功能，員工電腦**不安裝任何軟體**。

結論：**可行。** 在乾淨環境從頭執行，18 項檢查全部通過（2026-11-26，Open Artifact host 0.16.3）。

## 架構

```
 員工瀏覽器 ──▶ 企業 AI Agent 平台（platform.mjs，模擬你的平台後端）
     │              │  遠端 MCP（Streamable HTTP），每位員工一組 OAuth token
     │              ▼
     │        Open Artifact Site（packages/host，官方程式，未修改）
     │          ├ /oauth/*、/mcp
     │          ├ App：http://localhost:4900
     │          └ 內容：http://{id}.content.localhost:4900
     │              ▲
     └── 開新分頁 ──┘  檢視、編輯、留言、「問 Agent」
                    ▲
 公司 SSO（mock-sso.mjs，模擬 Entra ID 或 Keycloak 的 OIDC）
```

| 檔案 | 角色 |
|---|---|
| `mock-sso.mjs` | 模擬公司 SSO（OIDC、RS256、PKCE），內建兩位員工 alice（業務部）、bob（研發部） |
| `platform.mjs` | 模擬 Agent 平台後端：OAuth client、按員工保存 token 並自動 refresh、最小 MCP client，再用固定腳本代替 LLM 呼叫工具 |
| `start.sh` | 啟動三個服務，含 Site 的企業設定 |
| `run-poc.mjs` | 第一段：連接、建立簡報、瀏覽器開啟、權限隔離、快照 |
| `run-feedback.mjs` | 第二段：員工回饋 → Agent 收到 → 修改並回覆 |
| `run-all.sh` | 清空資料後依序執行全部項目 |

Site 的設定（見 `start.sh`）：

- `OA_AUTH`：owner key 加公司 SSO（OIDC，含 `groups` claim）
- `OA_SIGNUP=domain:corp.example`：只有公司網域的信箱能建立帳號
- `OA_PUBLIC_ACCESS=false`：成品不能設為公開
- `OA_OAUTH_CLIENTS`：預先登記平台的 `client_id` 和 `redirect_uri`

## 執行方式

```bash
npm ci && npm run build        # 在 repo 根目錄執行一次
poc/enterprise-web/run-all.sh  # 需要 Node 22.18 以上和 Playwright（Chromium）
```

截圖與 JSON 紀錄會輸出到 `poc/enterprise-web/shots/`。

## 驗證結果

| # | 項目 | 結果 |
|---|---|---|
| 1-2 | alice、bob 只用瀏覽器走完「平台 → Site 登入 → 公司 SSO → 同意授權頁 → 回到平台」，平台拿到各自的 token（有效 1 小時，refresh token 30 天） | 通過 |
| 3 | 平台經遠端 MCP 取得工具：`Artifact`、`ArtifactData`、`ArtifactComments`、`ShowArtifact` | 通過 |
| 4 | 平台 Agent 以 `quickstart` → `publish` 建立 3 頁簡報並寫入檔案，`check` 結果 0 個問題 | 通過 |
| 5 | alice 在瀏覽器開啟 `view_url`，看到完整的簡報編輯器 | 通過 |
| 6-8 | 權限隔離：bob 的 Agent 列不出、也讀不到 alice 的簡報（`not_found`）；bob 用瀏覽器直接開網址，顯示「無權存取」 | 通過 |
| 9-10 | `snapshot` 不回傳圖片，而是回傳 5 分鐘有效的唯讀網址；平台用自己的無頭瀏覽器截圖成功 | 通過 |
| 11-12 | A. alice 在 Shell 的「問 Agent」面板送出修改要求 → 平台的 `ArtifactComments wait` 約 4.5 秒收到 → Agent 修改後，alice 的畫面**即時更新** | 通過 |
| 13-17 | B. alice 在投影片上留言並勾選「Send to Agent」→ 約 2.3 秒收到 → Agent 讀取 thread、修改內容、在 thread 回覆並結案 → alice 在畫面上看到修改和回覆 | 通過 |

## 給平台工程師的介接重點

1. **OAuth**：
   - 用 authorization code 加 PKCE（S256），`resource` 帶 `<Site>/mcp`，scope 是 `artifacts.read artifacts.write comments share.read`。
   - token 要按員工分開保存，過期前用 `refresh_token` 換新。refresh token 每次都會輪替，用過的舊 token 再送一次會讓整組授權被撤銷，所以要原子性地更新保存值。
2. **MCP**：
   - 用 `POST /mcp` 送 JSON-RPC，header 帶 `Authorization: Bearer`、`MCP-Protocol-Version: 2025-06-18`，`Accept: application/json, text/event-stream`。
   - 從瀏覽器前端直接呼叫的話，要把平台網域加進 `OA_MCP_ORIGINS`。本 POC 是由後端呼叫。
3. **員工回饋（喚醒）**：
   - 不會主動推播給平台，要由平台呼叫 `ArtifactComments {action:"wait", timeout_ms}` 長輪詢。伺服器每次最多等 **25 秒**，逾時會回 `timedOut`，平台要自己迴圈持續呼叫。
   - 訊息出現在 MCP 結果的**第二個以後的 text content**，是寫給 LLM 讀的提示文字。開頭為 `[Artifact edit request sent to agent]`，裡面附上原文、位置（第幾頁、座標）、thread id。
   - 只要帶 `url` 呼叫任何工具，該成品累積的訊息也會一併附在結果裡。
4. **兩種回饋的差別**：
   - 「問 Agent」面板（`Request: ask_…`）沒有 thread，Agent 要在**平台自己的對話**裡回覆員工。
   - 留言（`c_…`）有 thread，可以用 `ArtifactComments reply` 在頁面上回覆並結案（`resolve: true`）。
5. **成品網址**：`view_url` 是 `<Site>/a/<id>`，只能**開新分頁**。Site 頁面帶 `frame-ancestors 'none'`，不能嵌進平台的 iframe。
6. **LLM 的指引**：`initialize` 回傳的 `instructions`，以及 `publish` 建立成品時回傳的類型說明（SKILL），要放進 LLM 的 context，讓模型知道怎麼寫各類型的檔案。

## 觀察到的限制與待辦

| 項目 | 說明 | 影響 |
|---|---|---|
| 介面語言 | 登入頁和同意頁顯示**簡體中文**，編輯器介面大多是**英文**，沒有繁體中文 | 對台灣同仁的使用體驗有影響；可以自行補 zh-TW 翻譯 |
| 「問 Agent」狀態 | Agent 已經收到並處理後，面板上的訊息仍顯示「等 Agent 接收」，標題列持續顯示「正在工作…」 | 只影響顯示，功能正常；需要進一步查原因或回報上游 |
| Agent 在線狀態 | 長輪詢期間面板仍顯示「離線」 | 員工可能誤以為 Agent 沒在線 |
| 無法嵌入 | 成品只能在新分頁開啟 | UI 設計上要接受「另開分頁」 |
| 伺服器不截圖、不匯出 | Agent 想「看」成品，要由平台自己用無頭瀏覽器開 snapshot 網址；匯出 PDF、PPTX 由員工在瀏覽器裡做 | 平台需要部署 Playwright 或 Chromium，Agent 才能看到成品畫面 |
| 單一程序 | Site 不能做叢集 | 大規模使用要評估主機規格，或分站部署 |
| Data 即時連接器 | 伺服器不執行連接器 | 儀表板要改用上傳資料，或另外架一台 daemon 當資料來源 |
| 正式環境 | POC 使用 http 和 `*.localhost`；正式環境需要兩個網域、萬用字元 DNS 和 HTTPS 憑證 | 部署前要先請網管準備 |

## POC 沒有涵蓋的部分

- 沒有接真的 LLM。Agent 的工具呼叫順序是寫死的腳本，不過 `instructions` 和 SKILL 都已經正確回傳。
- 沒有測試 Docker 加 Caddy 的正式部署，也沒有做壓力測試。
- 沒有測試分享流程（Share 面板授權給同事或群組），也沒有測試 refresh token 實際過期後的換發。
