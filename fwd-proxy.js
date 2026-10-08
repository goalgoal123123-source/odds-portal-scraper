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
  app.use('/fwd', (req, res) => {
    if (!fwdAuthOk(req)) return res.status(403).send('forbidden');
    const t = fwdParse(req.url);
    if (!t) return res.status(403).send('bad target');
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (FWD_HOP_HEADERS.has(lk) || lk === 'x-fwd-token' || lk === 'content-length' || lk === 'host') continue;
      outHeaders[k] = v;
    }
    // Host 必須係目標域名：轉發錯誤嘅 Host 會令 CoinPoker 嗰邊 TLS handshake 失敗
    outHeaders['host'] = t.host;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      if (body) outHeaders['content-length'] = String(body.length);
      const up = https.request(t.target, { method: req.method, headers: outHeaders }, (upRes) => {
        const rh = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (FWD_HOP_HEADERS.has(k.toLowerCase())) continue;
          rh[k] = v;
        }
        res.writeHead(upRes.statusCode, rh);
        upRes.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) res.status(502).send('upstream error');
        else { try { res.end(); } catch (e) {} }
      });
      if (body) up.write(body);
      up.end();
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
        if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'x-fwd-token') continue;
        raw += k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n';
      }
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
