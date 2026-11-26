// 模擬「企業內部 AI Agent 平台」的後端。
// - 員工用瀏覽器登入平台（POC 以 ?as=<員工> 代表平台自己的登入）。
// - 平台以 OAuth 2.1 + PKCE 向 Open Artifact Site 取得「代表這位員工」的 MCP token，按員工分開保存。
// - 平台的 Agent 透過遠端 MCP（/mcp）建立、修改成品，讀取並回覆留言。
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.env.PLATFORM_PORT ?? 4920);
const SELF = `http://127.0.0.1:${PORT}`;
const SITE = process.env.SITE ?? 'http://localhost:4900';
const CLIENT_ID = 'enterprise-agent-platform';
const REDIRECT = `${SELF}/callback`;
const SCOPE = 'artifacts.read artifacts.write comments share.read';

const sessions = new Map(); // 平台 session id → 員工 id
const pending = new Map(); // OAuth state → { user, verifier }
const tokens = new Map(); // 員工 id → { access_token, refresh_token, expires_at }
export const log = [];
const note = (who, msg, data) => { const line = { at: new Date().toISOString(), who, msg, ...(data ? { data } : {}) }; log.push(line); console.log(`[platform] ${who}: ${msg}`); };

// ---------------- OAuth ----------------
async function refreshIfNeeded(user) {
  const t = tokens.get(user);
  if (!t) throw Object.assign(new Error('not connected'), { status: 409 });
  if (Date.now() < t.expires_at - 60_000) return t;
  const r = await fetch(`${SITE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(body)}`);
  const next = { ...body, expires_at: Date.now() + body.expires_in * 1000 };
  tokens.set(user, next);
  note(user, 'token refreshed (refresh token rotated)');
  return next;
}

// ---------------- 最小 MCP 用戶端（Streamable HTTP） ----------------
const sessionIds = new Map(); // 員工 → Mcp-Session-Id
let rpcId = 0;
async function rpc(user, method, params) {
  const { access_token } = await refreshIfNeeded(user);
  const headers = {
    authorization: `Bearer ${access_token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  const sid = sessionIds.get(user);
  if (sid) headers['mcp-session-id'] = sid;
  const r = await fetch(`${SITE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (r.headers.get('mcp-session-id')) sessionIds.set(user, r.headers.get('mcp-session-id'));
  const text = await r.text();
  let msg;
  if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    msg = JSON.parse(data.at(-1));
  } else msg = JSON.parse(text);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
async function tool(user, name, args) {
  const result = await rpc(user, 'tools/call', { name, arguments: args });
  if (name === 'ArtifactComments') note(user, `raw ${args.action}`, { result });
  const text = result.structuredContent ? JSON.stringify(result.structuredContent) : (result.content?.find((c) => c.type === 'text')?.text ?? '{}');
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  // 喚醒訊息（員工的留言、修改要求）以額外的 text 內容附在結果後面，寫給 LLM 讀
  const extra = (result.content ?? []).filter((c) => c.type === 'text').slice(1).map((c) => c.text);
  if (extra.length) parsed = { ...parsed, wake_texts: extra };
  if (result.isError) throw Object.assign(new Error(`${name} ${args.action ?? ''} failed: ${text}`), { detail: parsed });
  return parsed;
}
const inits = new Map();
function ensureInit(user) {
  if (!inits.has(user)) inits.set(user, doInit(user).catch((e) => { inits.delete(user); throw e; }));
  return inits.get(user);
}
async function doInit(user) {
  const init = await rpc(user, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'enterprise-agent-platform', version: '0.1' } });
  note(user, `MCP initialize ok (server ${init.serverInfo?.name} ${init.serverInfo?.version})`, { instructions: init.instructions });
  try { await rpc(user, 'notifications/initialized', {}); } catch { /* notification: 202 with no body */ }
}

// ---------------- 平台的「Agent」：示範動作 ----------------
// 真正的平台會由 LLM 決定要呼叫哪些工具；POC 用固定腳本代替 LLM。
const agent = {
  async tools(user) {
    await ensureInit(user);
    const list = await rpc(user, 'tools/list', {});
    return list.tools.map((t) => t.name);
  },
  async makeDeck(user, { title, slides }) {
    await ensureInit(user);
    const quick = await tool(user, 'Artifact', { action: 'quickstart', intent: 'slides' });
    note(user, `quickstart → recommended ${quick.recommended?.id}`);
    const created = await tool(user, 'Artifact', { ...quick.create, title });
    const url = created.url;
    note(user, `created ${url}`, { keys: Object.keys(created), instructionsChars: JSON.stringify(created).length });
    const ids = slides.map((_, i) => `s-poc${i + 1}`);
    const files = {
      'project/deck.json': JSON.stringify({ v: 5, lists: 'css', format: { v: 1, shared: ['project/deck.css'] }, title, order: ids, sections: {}, faces: {}, designSystems: [], attachments: {} }, null, 2),
      'project/deck.css': 'section { background: #ffffff; color: #1a1a1a; font-family: "Noto Sans TC", sans-serif; }\n',
    };
    slides.forEach((s, i) => {
      files[`project/slides/${ids[i]}.html`] =
        `<section id="${ids[i]}" data-flat style="padding:128px;background:${i === 0 ? '#0f3d63' : '#ffffff'};color:${i === 0 ? '#ffffff' : '#1a1a1a'}">\n` +
        `  <div data-text style="position:absolute;left:128px;top:${i === 0 ? 380 : 120}px;width:1664px;height:160px;font-size:${i === 0 ? 96 : 72}px;font-weight:700"><p>${s.heading}</p></div>\n` +
        (s.body ? `  <div data-text style="position:absolute;left:128px;top:${i === 0 ? 560 : 320}px;width:1664px;height:600px;font-size:44px;line-height:1.5">${s.body.map((b) => `<p>${b}</p>`).join('')}</div>\n` : '') +
        `</section>\n`;
    });
    const published = await tool(user, 'Artifact', { action: 'publish', url, files });
    note(user, `wrote ${Object.keys(files).length} files`, { published });
    let check = null;
    try { check = await tool(user, 'Artifact', { action: 'call', url, name: 'check' }); note(user, 'check', { check }); } catch (e) { note(user, `check failed: ${e.message}`); }
    const opened = await tool(user, 'Artifact', { action: 'open', url });
    note(user, `view_url ${opened.view_url}`);
    return { url, view_url: opened.view_url, created, check };
  },
  async list(user) { await ensureInit(user); return tool(user, 'Artifact', { action: 'list' }); },
  async read(user, url, path) { await ensureInit(user); return tool(user, 'Artifact', { action: 'read', url, ...(path ? { path } : {}) }); },
  async snapshot(user, url) { await ensureInit(user); return tool(user, 'Artifact', { action: 'call', url, name: 'snapshot' }); },
  async comments(user, url) { await ensureInit(user); return tool(user, 'ArtifactComments', { action: 'read', url }); },
  async wait(user, url, timeout) { await ensureInit(user); return tool(user, 'ArtifactComments', { action: 'wait', ...(url ? { url } : {}), ...(timeout ? { timeout_ms: timeout } : {}) }); },
  async reply(user, url, thread_id, text, resolve) { await ensureInit(user); return tool(user, 'ArtifactComments', { action: 'reply', url, thread_id, text, resolve }); },
  async publishFiles(user, url, files) { await ensureInit(user); return tool(user, 'Artifact', { action: 'publish', url, files }); },
  async raw(user, name, args) { await ensureInit(user); return tool(user, name, args); },
};

// ---------------- HTTP ----------------
const cookieOf = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };

createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  let user;
  try {
    if (url.pathname === '/login') {
      const sid = randomBytes(16).toString('base64url');
      sessions.set(sid, url.searchParams.get('as'));
      return send(res, 302, '', { location: '/', 'set-cookie': `plat=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    user = sessions.get(cookieOf(req).plat);
    if (!user) return send(res, 401, '<p>請先登入平台：<a href="/login?as=alice">alice</a> / <a href="/login?as=bob">bob</a></p>');

    if (url.pathname === '/') {
      const ok = tokens.has(user);
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Agent 平台</title><h1>企業 AI Agent 平台（模擬）</h1><p>你好，${user}。</p>` +
        `<p id="status">${ok ? 'Open Artifact：已連接' : 'Open Artifact：尚未連接'}</p>` + (ok ? '' : '<a id="connect" href="/connect">連接 Open Artifact</a>'));
    }
    if (url.pathname === '/connect') {
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(16).toString('base64url');
      pending.set(state, { user, verifier });
      const a = new URL(`${SITE}/oauth/authorize`);
      Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, state, resource: `${SITE}/mcp`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => a.searchParams.set(k, v));
      note(user, 'redirecting to Site consent');
      return send(res, 302, '', { location: a.toString() });
    }
    if (url.pathname === '/callback') {
      const p = pending.get(url.searchParams.get('state')); pending.delete(url.searchParams.get('state'));
      if (!p || p.user !== user) return send(res, 400, { error: 'bad state' });
      if (url.searchParams.get('error')) return send(res, 400, { error: url.searchParams.get('error') });
      const r = await fetch(`${SITE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: p.verifier, resource: `${SITE}/mcp` }),
      });
      const body = await r.json();
      if (!r.ok) return send(res, 400, body);
      tokens.set(user, { ...body, expires_at: Date.now() + body.expires_in * 1000 });
      note(user, `token issued, scope="${body.scope}", expires_in=${body.expires_in}`);
      return send(res, 302, '', { location: '/' });
    }
    if (url.pathname.startsWith('/api/agent/') && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const args = raw ? JSON.parse(raw) : {};
      const op = url.pathname.slice('/api/agent/'.length);
      const fn = agent[op];
      if (!fn) return send(res, 404, { error: 'no op' });
      const params = { tools: [], makeDeck: [args], list: [], read: [args.url, args.path], snapshot: [args.url], comments: [args.url], wait: [args.url, args.timeout], reply: [args.url, args.thread_id, args.text, args.resolve], publishFiles: [args.url, args.files], raw: [args.name, args.args] }[op];
      return send(res, 200, await fn(user, ...params));
    }
    if (url.pathname === '/api/log') return send(res, 200, log);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    note(user ?? '?', `error ${e.message}`);
    send(res, e.status ?? 500, { error: e.message, detail: e.detail });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`platform at ${SELF}`));
