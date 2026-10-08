/**
 * Playwright in-page fetch forwarder for CoinPoker.
 * Uses page.evaluate(fetch()) INSIDE a real Chromium page on play.coinpoker.com.
 * This has the correct TLS fingerprint, executes JS, and sends cookies automatically.
 */
import { chromium } from 'playwright';

let browser = null;
let page = null;
let initPromise = null;
let lastWarm = 0;

async function ensurePage() {
  if (page && Date.now() - lastWarm < 10 * 60 * 1000) return page;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
    }
    if (page) await page.close().catch(() => {});
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    page = await ctx.newPage();
    await page.goto('https://play.coinpoker.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(15000);
    lastWarm = Date.now();
    console.log('[pw-fwd] page ready');
    initPromise = null;
    return page;
  })();
  return initPromise;
}

export async function pwFetch(url, options = {}) {
  const pg = await ensurePage();
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const bodyB64 = options.body ? Buffer.from(options.body).toString('base64') : null;

  const result = await pg.evaluate(async ({ url, method, headers, bodyB64 }) => {
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
    return { status: resp.status, headers: h, bodyB64: btoa(bin) };
  }, { url, method, headers, bodyB64 });

  return {
    status: result.status,
    headers: result.headers,
    body: Buffer.from(result.bodyB64, 'base64'),
  };
}
