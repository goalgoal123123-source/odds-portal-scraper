import logger from '../logger.js';
import { oddsFormatMap } from '../constants.js';

const shortLabel = (longLabel) => longLabel.replace(/\s*\(.*\)\s*$/, '');

/**
 * Sets the odds format via the site header dropdown.
 * Current markup: div.group > button (label "Decimal Odds") opens a
 * ul > li > button menu with options like "Decimal Odds (1.50)".
 *
 * @param {import('playwright').Page} page
 * @param {string} format one of eu/us/uk/hk/ma/in
 */
export async function setOddsFormat(page, format) {
    const longLabel = oddsFormatMap[format];
    if (!longLabel) throw new Error(`format '${format}' is not supported`);
    const want = shortLabel(longLabel);

    try {
        const button = page.locator('div.group > button', { hasText: /Odds/ }).first();
        await button.waitFor({ timeout: 8000 });
        const current = (await button.innerText()).trim();
        if (current.startsWith(want)) {
            logger.info(`odds format already '${want}', skipping`);
            return;
        }
        await button.click();
        const option = page.locator('div.group ul li button', { hasText: longLabel }).first();
        await option.waitFor({ timeout: 5000 });
        await option.click();
        await page.waitForTimeout(1500);
        logger.info(`odds format set to '${longLabel}'`);
    } catch (error) {
        logger.warn(`could not switch odds format to '${longLabel}': ${error.message}`);
    }
}
