// 模擬企業 SSO（OIDC 身分提供者），扮演 Entra ID / Keycloak 的角色。
// 只供 POC 使用：登入頁讓人選一位員工，不驗密碼。
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const PORT = Number(process.env.SSO_PORT ?? 4910);
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = process.env.SSO_CLIENT_ID ?? 'open-artifact';

export const EMPLOYEES = {
  alice: { name: '王小美', email: 'alice@corp.example', groups: ['sales'] },
  bob: { name: '陳大文', email: 'bob@corp.example', groups: ['rd'] },
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'poc-1', alg: 'RS256', use: 'sig' };
const codes = new Map();

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function idToken(claims) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'poc-1' });
  const body = b64(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(res, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url.pathname === '/jwks') return json(res, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const who = url.searchParams.get('login_as');
    if (!who) {
      // 登入頁：員工選自己的帳號
      const links = Object.entries(EMPLOYEES).map(([id, e]) => {
        const u = new URL(url); u.searchParams.set('login_as', id);
        return `<li><a id="login-${id}" href="${u}">${e.name}（${e.email}）</a></li>`;
      }).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>公司 SSO</title><h1>公司 SSO 登入（模擬）</h1><ul>${links}</ul>`);
    }
    const code = randomBytes(16).toString('base64url');
    codes.set(code, {
      who,
      nonce: url.searchParams.get('nonce'),
      challenge: url.searchParams.get('code_challenge'),
      redirect: url.searchParams.get('redirect_uri'),
    });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    const rec = codes.get(form.get('code')); codes.delete(form.get('code'));
    if (!rec) return json(res, { error: 'invalid_grant' }, 400);
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== rec.challenge) return json(res, { error: 'invalid_grant', error_description: 'pkce' }, 400);
    const e = EMPLOYEES[rec.who];
    const now = Math.floor(Date.now() / 1000);
    return json(res, {
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      id_token: idToken({ iss: ISSUER, aud: CLIENT_ID, sub: rec.who, nonce: rec.nonce, iat: now, exp: now + 300, email: e.email, email_verified: true, name: e.name, groups: e.groups }),
    });
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`mock SSO at ${ISSUER}`));
