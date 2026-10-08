/**
 * Playwright-based forwarder for CoinPoker.
 * Uses a persistent real Chromium browser context to forward requests.
 * This passes Cloudflare's bot challenge because it's a REAL browser
 * (correct TLS fingerprint, JS execution, cookies).
 */
import { chromium } from 'playwright';

let browser = null;
let context = null;
let initPromise = null;

async function ensureContext() {
  if (context) return context;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    // Pre-warm: visit CoinPoker to pass challenge and get cookies
    const page = await context.newPage();
    try {
      await page.goto('https://play.coinpoker.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(15000);
      console.log('[pw-fwd] pre-warm done, title=' + await page.title().catch(() => '?'));
    } catch (e) {
      console.log('[pw-fwd] pre-warm error: ' + String(e.message || e).slice(0, 150));
    } finally {
      await page.close();
    }
    return context;
  })();
  return initPromise;
}

export async function pwFetch(url, options = {}) {
  const ctx = await ensureContext();
  const req = ctx.request;
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const data = options.body || undefined;

  let resp;
  const fetchOpts = { headers, data, timeout: 45000 };
  if (method === 'GET') resp = await req.get(url, fetchOpts);
  else if (method === 'POST') resp = await req.post(url, fetchOpts);
  else if (method === 'PUT') resp = await req.put(url, fetchOpts);
  else if (method === 'DELETE') resp = await req.delete(url, fetchOpts);
  else if (method === 'PATCH') resp = await req.patch(url, fetchOpts);
  else if (method === 'HEAD') resp = await req.head(url, fetchOpts);
  else resp = await req.fetch(url, { ...fetchOpts, method });

  const body = await resp.body();
  const headersObj = {};
  const h = resp.headers();
  for (const k of Object.keys(h)) headersObj[k] = h[k];
  return { status: resp.status(), headers: headersObj, body };
}
