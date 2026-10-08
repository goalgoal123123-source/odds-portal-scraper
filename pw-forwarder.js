/**
 * Playwright in-page fetch forwarder for CoinPoker.
 * Uses page.evaluate(fetch()) INSIDE a real Chromium page on play.coinpoker.com.
 * This has the correct TLS fingerprint, executes JS, and sends cookies automatically.
 *
 * 2026-10-09 修復：舊版只靠 page title 判斷驗證有冇過，但 Cloudflare clearance
 * 過期之後 title 照舊係 "CoinPoker - Launch"，in-page fetch 會一直食 403
 * "Just a moment..."，個壞 page 永遠唔會被換走。而家：
 *  1. warm-up 用真實 in-page fetch 驗證（唔止睇 title）
 *  2. pwFetch 撞到 challenge 回應會作廢個 page、重新 warm-up、再試一次
 */

import { chromium } from 'playwright';

let browser = null;
let page = null;
let initPromise = null;
let lastWarm = 0;

const CP_ROOT = 'https://play.coinpoker.com/';

function looksChallenged(status, text) {
  // 只會喺 403/503 嗰陣用嚟判斷；正常 CoinPoker app HTML 唔會有呢啲字
  if (typeof text !== 'string') return false;
  return text.indexOf('Just a moment') !== -1 ||
         text.indexOf('cf-challenge') !== -1 ||
         /Attention Required.*Cloudflare/i.test(text);
}

// 用 in-page fetch 打 root，睇下係咪真係過到驗證
async function fetchOk(pg) {
  try {
    const r = await pg.evaluate(async (url) => {
      const resp = await fetch(url, { method: 'GET' });
      const txt = await resp.text();
      return { status: resp.status, head: txt.slice(0, 4000) };
    }, CP_ROOT);
    if (r.status === 403 || r.status === 503) return false;
    if (looksChallenged(r.status, r.head)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function dropPage() {
  if (page) page.close().catch(() => {});
  page = null;
  lastWarm = 0;
}

async function ensurePage() {
  if (page && Date.now() - lastWarm < 10 * 60 * 1000) {
    // 快速檢查 page 仲生唔生、係咪已過驗證
    try {
      const t = await page.title();
      if (t && t.indexOf('Just a moment') === -1) {
        // title 唔可靠（clearance 過期 title 照舊），抽查一次真 fetch
        if (await fetchOk(page)) return page;
        console.log('[pw-fwd] cached page fetch check failed, re-warming');
      }
    } catch (e) { /* page 死咗，重新起 */ }
    dropPage();
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (!browser) {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        });
      }
      dropPage();
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
      });
      page = await ctx.newPage();
      await page.goto(CP_ROOT, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // 等驗證通過（最多 60 秒）：title + 真實 fetch 雙重確認
      let passed = false;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(5000);
        try {
          const t = await page.title();
          if (t && t.indexOf('Just a moment') === -1 && t.indexOf('CoinPoker') !== -1) {
            if (await fetchOk(page)) { passed = true; break; }
            console.log('[pw-fwd] warm-up: title ok but fetch challenged, waiting…');
          }
        } catch (e) { break; }
      }
      if (!passed) {
        console.log('[pw-fwd] warm-up FAILED (challenge not passed)');
        dropPage();
        throw new Error('challenge not passed');
      }
      lastWarm = Date.now();
      console.log('[pw-fwd] page ready, challenge passed (fetch verified)');
      return page;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

async function doPwFetch(pg, url, method, headers, bodyB64) {
  return await pg.evaluate(async ({ url, method, headers, bodyB64 }) => {
    const init = { method, headers };
    if (bodyB64 && method !== 'GET' && method !== 'HEAD') {
      const bin = atob(bodyB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      init.body = bytes;
    }
    const resp = await fetch(url, init);
    const buf = await resp.arrayBuffer();
    const h = {};
    resp.headers.forEach((v, k) => { h[k] = v; });
    // Convert to base64 for efficient transfer
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    // 回傳頭 4KB 文字用嚟判斷係咪 challenge 頁（唔使成份 body 轉多次）
    let head = '';
    try { head = new TextDecoder().decode(bytes.subarray(0, 4000)); } catch (e) {}
    return { status: resp.status, headers: h, bodyB64: btoa(bin), head };
  }, { url, method, headers, bodyB64 });
}

export async function pwFetch(url, options = {}) {  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const bodyB64 = options.body ? Buffer.from(options.body).toString('base64') : null;

  let pg = await ensurePage();
  let result = await doPwFetch(pg, url, method, headers, bodyB64);

  // 撞到 Cloudflare challenge：作廢個 page，重新 warm-up，再試一次
  if ((result.status === 403 || result.status === 503) && looksChallenged(result.status, result.head)) {
    console.log('[pw-fwd] fetch challenged (status ' + result.status + '), re-warming and retrying once');
    dropPage();
    pg = await ensurePage();
    result = await doPwFetch(pg, url, method, headers, bodyB64);
    if ((result.status === 403 || result.status === 503) && looksChallenged(result.status, result.head)) {
      console.log('[pw-fwd] retry still challenged, giving up');
    }
  }

  return {
    status: result.status,
    headers: result.headers,
    body: Buffer.from(result.bodyB64, 'base64'),
  };
}

// Server 啟動時預熱（唔 block）：等第一個用戶 request 嚟嗰陣個 page 已經 ready，
// 唔使喺 request 入面等成個 warm-up（會超過 Cloudflare edge timeout）
export function warmupPw() {
  ensurePage()
    .then(() => console.log('[pw-fwd] startup warmup done'))
    .catch((e) => console.log('[pw-fwd] startup warmup failed: ' + String(e.message || e).slice(0, 200)));
}
