/**
 * Cloudflare clearance manager for CoinPoker.
 * Uses Playwright (real Chromium) to pass the "Just a moment" challenge
 * and obtain a cf_clearance cookie, then refreshes it periodically.
 * The /fwd forwarder includes this cookie so CoinPoker doesn't 403.
 */
import { chromium } from 'playwright';

let clearance = null; // { value, obtainedAt }
let refreshing = false;

async function fetchClearance() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto('https://play.coinpoker.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(20000);
    const cookies = await ctx.cookies();
    const cf = cookies.find(c => c.name === 'cf_clearance');
    await ctx.close();
    if (cf && cf.value) {
      clearance = { value: cf.value, obtainedAt: Date.now() };
      console.log('[clearance] obtained, len=' + cf.value.length);
      return true;
    }
    console.log('[clearance] FAILED - no cf_clearance cookie, title=' + await page.title().catch(() => '?'));
    return false;
  } catch (e) {
    console.log('[clearance] ERROR: ' + String(e.message || e).slice(0, 200));
    return false;
  } finally {
    await browser.close();
  }
}

export function getClearance() {
  return clearance ? clearance.value : null;
}

export async function refreshClearance() {
  if (refreshing) return;
  refreshing = true;
  try {
    await fetchClearance();
  } finally {
    refreshing = false;
  }
}

// Start background refresh loop (every 15 min). Call once at server startup.
export function startClearanceLoop() {
  refreshClearance(); // initial (async, non-blocking)
  setInterval(() => { refreshClearance(); }, 15 * 60 * 1000);
}
