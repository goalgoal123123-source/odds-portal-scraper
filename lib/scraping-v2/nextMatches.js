import logger from '../logger.js';
import { getUrlFrom } from '../utils/leagues.js';
import { setOddsFormat } from './setOddsFormat.js';
import { collectMatchLinks } from './collectMatchLinks.js';
import { scrapeMatch } from './scrapeMatch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throttleMs = () => 1500 + Math.floor(Math.random() * 1500);

/**
 * Scrapes upcoming matches for a league (v2, current markup).
 */
export async function nextMatchesScraper(browser, leagueName, oddsFormat, onResult, limit) {
    const baseUrl = getUrlFrom(leagueName);
    logger.info(`v2 next-matches: ${baseUrl}`);

    const page = await browser.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1200 });
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // trigger lazy loading of the fixture list
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, 1600));
            await page.waitForTimeout(1200);
        }

        await setOddsFormat(page, oddsFormat);
        const links = await collectMatchLinks(page, limit);

        let first = true;
        for (const link of links) {
            if (!first) await sleep(throttleMs());
            first = false;
            try {
                const data = await scrapeMatch(page, link, leagueName, oddsFormat);
                await onResult({ data });
            } catch (error) {
                logger.error(`match failed (${link}): ${error.message}`);
                await onResult({ link, error: error.message });
            }
        }
    } finally {
        if (!page.isClosed()) await page.close();
    }
}
