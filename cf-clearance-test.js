/**
 * 快速診斷：CoinPoker Cloudflare challenge 而家係咩樣？
 * 唔等成個驗證，goto 完即刻截圖，45 秒內返。
 */
import { chromium } from 'playwright';

export async function testClearance() {
  const t0 = Date.now();
  const result = { ok: false, title: '', url: '', cookies: [], error: null, ms: 0 };
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    result.launchMs = Date.now() - t0;
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    try {
      await page.goto('https://play.coinpoker.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      result.gotoError = String(e.message || e).slice(0, 150);
    }
    await page.waitForTimeout(8000);
    result.title = await page.title().catch(() => '?');
    result.url = page.url();
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 50 });
      result.screenshotB64 = shot.toString('base64');
    } catch (e) { result.screenshotB64 = null; }
    try {
      const html = await page.content();
      result.htmlHead = html.slice(0, 2000);
    } catch (e) { result.htmlHead = null; }
    const cookies = await ctx.cookies().catch(() => []);
    result.cookies = cookies.map(c => ({ name: c.name, len: c.value.length }));
    result.ok = cookies.some(c => c.name === 'cf_clearance');
    await ctx.close().catch(() => {});
  } catch (e) {
    result.error = String(e.message || e).slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  result.ms = Date.now() - t0;
  return result;
}
