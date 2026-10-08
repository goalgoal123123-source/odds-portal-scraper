/**
 * CoinPoker SG forward proxy (dumb pipe).
 * The Cloudflare worker (coinpoker-frame) does all smart processing
 * (framing headers, cookies, HTML rewriting, frame-buster neutering);
 * this module only changes the egress country to Singapore.
 *   /fwd/<host>/<path...>?<query>  ->  https://<host>/<path...>?<query>
 * Host allowlist: *.coinpoker.com only. Requires x-fwd-token == CP_FWD_TOKEN.
 * WebSocket upgrades on /fwd/<host>/<path> are tunneled via TLS to <host>:443.
 */
import https from 'https';
import tls from 'tls';
import { getClearance } from './cf-clearance.js';
import { pwFetch } from './pw-forwarder.js';

const FWD_TOKEN = process.env.CP_FWD_TOKEN || '';
const FWD_HOST_RE = /^([a-z0-9-]+\.)*coinpoker\.com$/i;
const FWD_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function fwdParse(url) {
  const m = /^\/([a-z0-9.-]+)(\/[^?]*)?(\?.*)?$/i.exec(url);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!FWD_HOST_RE.test(host)) return null;
  return { host, target: 'https://' + host + (m[2] || '/') + (m[3] || '') };
}

function fwdAuthOk(req) {
  if (!FWD_TOKEN) return true;
  return req.headers['x-fwd-token'] === FWD_TOKEN;
}

export function mountFwd(app) {
  // 臨時測試：Playwright 能否通過 CoinPoker 驗證
  app.get('/fwd-clearance-test', async (req, res) => {
    if (!fwdAuthOk(req)) return res.status(403).send('forbidden');
    try {
      const { testClearance } = await import('./cf-clearance-test.js');
      const r = await testClearance();
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e).slice(0, 300) });
    }
  });

  app.use('/fwd', (req, res) => {
    if (!fwdAuthOk(req)) return res.status(403).send('forbidden');
    const t = fwdParse(req.url);
    if (!t) return res.status(403).send('bad target');
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (FWD_HOP_HEADERS.has(lk) || lk === 'x-fwd-token' || lk === 'content-length' || lk === 'host' || lk === 'cookie') continue;
      outHeaders[k] = v;
    }
    // Host 必須係目標域名：轉發錯誤嘅 Host 會令 CoinPoker 嗰邊 TLS handshake 失敗
    outHeaders['host'] = t.host;
    // 加上 cf_clearance cookie 過 Cloudflare 機械人驗證（Playwright 定時 refresh）
    // 同用戶本身嘅 cookie 合併，唔好覆蓋
    const clearance = getClearance();
    const userCookie = req.headers['cookie'];
    const parts = [];
    if (userCookie) parts.push(userCookie);
    if (clearance) parts.push('cf_clearance=' + clearance);
    if (parts.length) outHeaders['cookie'] = parts.join('; ');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      if (body) outHeaders['content-length'] = String(body.length);
      try {
        // 用 Playwright 真瀏覽器轉發（過 Cloudflare 機械人驗證）
        const pwRes = await pwFetch(t.target, {
          method: req.method,
          headers: outHeaders,
          body: body,
        });
        const rh = {};
        for (const [k, v] of Object.entries(pwRes.headers)) {
          if (FWD_HOP_HEADERS.has(k.toLowerCase())) continue;
          rh[k] = v;
        }
        delete rh['content-encoding'];
        delete rh['transfer-encoding'];
        res.writeHead(pwRes.status, rh);
        res.end(pwRes.body);
      } catch (e) {
        console.log('[fwd] pwFetch error: ' + String(e.message || e).slice(0, 200));
        if (!res.headersSent) res.status(502).send('upstream error');
        else { try { res.end(); } catch (ee) {} }
      }
    });
    req.on('error', () => { try { res.end(); } catch (e) {} });
  });
}

export function attachFwdUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const deny = () => { try { socket.destroy(); } catch (e) {} };
    if (!fwdAuthOk(req)) return deny();
    const m = /^\/fwd\/([a-z0-9.-]+)(\/[^?]*)?(\?.*)?$/i.exec(req.url);
    if (!m || !FWD_HOST_RE.test(m[1])) return deny();
    const host = m[1].toLowerCase();
    const path = (m[2] || '/') + (m[3] || '');
    const upstream = tls.connect(443, host, { servername: host }, () => {
      let raw = 'GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\n';
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'x-fwd-token' || lk === 'cookie') continue;
        raw += k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n';
      }
      // WebSocket 也要帶 cf_clearance 過驗證（同用戶 cookie 合併）
      const clearance = getClearance();
      const userCk = req.headers['cookie'];
      const ckParts = [];
      if (userCk) ckParts.push(userCk);
      if (clearance) ckParts.push('cf_clearance=' + clearance);
      if (ckParts.length) raw += 'Cookie: ' + ckParts.join('; ') + '\r\n';
      raw += 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on('close', () => { try { upstream.destroy(); } catch (e) {} });
      upstream.on('close', () => { try { socket.destroy(); } catch (e) {} });
    });
    upstream.on('error', deny);
    socket.on('error', () => { try { upstream.destroy(); } catch (e) {} });
  });
}
