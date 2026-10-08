/**
 * Test: can Playwright (real Chromium) pass CoinPoker's Cloudflare challenge
 * and obtain a cf_clearance cookie?
 */
import { chromium } from 'playwright';

export async function testClearance() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const result = { ok: false, title: '', cookies: [], error: null };
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto('https://play.coinpoker.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for challenge to potentially clear (up to 20s)
    await page.waitForTimeout(20000);
    result.title = await page.title();
    result.url = page.url();
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
      result.screenshotB64 = shot.toString('base64');
    } catch (e) { result.screenshotB64 = null; }
    try {
      const html = await page.content();
      result.htmlHead = html.slice(0, 3000);
    } catch (e) { result.htmlHead = null; }
    const cookies = await ctx.cookies();
    result.cookies = cookies.map(c => ({ name: c.name, len: c.value.length }));
    result.ok = cookies.some(c => c.name === 'cf_clearance');
    await ctx.close();
  } catch (e) {
    result.error = String(e.message || e).slice(0, 300);
  } finally {
    await browser.close();
  }
  return result;
}
