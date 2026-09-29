import logger from '../logger.js';
import { getHistoricUrls } from '../utils/leagues.js';
import { setOddsFormat } from './setOddsFormat.js';
import { collectMatchLinks } from './collectMatchLinks.js';
import { scrapeMatch } from './scrapeMatch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throttleMs = () => 1500 + Math.floor(Math.random() * 1500);

/**
 * Scrapes historic (finished) matches for a league across seasons (v2).
 * Each season's results page lists finished fixtures as h2h links.
 */
export async function historicScraper(browser, leagueName, startYear, endYear, oddsFormat, onResult, limit) {
    const seasonUrls = getHistoricUrls(leagueName, startYear, endYear);
    logger.info(`v2 historic: ${seasonUrls.length} season(s)`);

    const page = await browser.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1200 });
        let formatSet = false;

        for (const seasonUrl of seasonUrls) {
            logger.info(`season page: ${seasonUrl}`);
            await page.goto(seasonUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 1600));
                await page.waitForTimeout(1200);
            }

            if (!formatSet) {
                await setOddsFormat(page, oddsFormat);
                formatSet = true;
            }
            const links = await collectMatchLinks(page, limit);

            let first = true;
            for (const link of links) {
                if (!first) await sleep(throttleMs());
                first = false;
                try {
                    const data = await scrapeMatch(page, link, leagueName, oddsFormat);
                    await onResult(data);
                } catch (error) {
                    logger.error(`match failed (${link}): ${error.message}`);
                }
            }
        }
    } finally {
        if (!page.isClosed()) await page.close();
    }
}
