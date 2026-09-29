import logger from '../logger.js';

const BASE = 'https://www.oddsportal.com';

/**
 * Extracts match metadata from a match page.
 * Teams come from the h1 ("Liverpool vs Manchester City - Odds, ...");
 * kickoff comes from the event_start_time block
 * ("Sunday," / "11 Oct 2026," / "17:30").
 */
async function extractMetadata(page) {
    const h1 = (await page.locator('h1').first().innerText()).trim();
    // Formats seen in the wild:
    //   "Liverpool vs Manchester City - Odds, Predictions and H2H Results"
    //   "Arsenal - Leeds"
    let homeTeam = null, awayTeam = null;
    if (h1.includes(' vs ')) {
        [homeTeam, awayTeam] = h1.split(' - ')[0].split(' vs ').map((s) => s.trim());
    } else if (h1.includes(' - ')) {
        [homeTeam, awayTeam] = h1.split(' - ').map((s) => s.trim());
    }

    let day = null, date = null, time = null;
    try {
        const block = page.locator('div:has(> img[src*="event_start_time"])');
        await block.first().waitFor({ timeout: 8000 });
        const parts = await block.first().locator('p').allInnerTexts();
        [day, date, time] = parts.map((s) => s.replace(/,\s*$/, '').trim());
    } catch (e) {
        logger.warn(`match datetime not found: ${e.message}`);
    }

    if (!homeTeam || !awayTeam) {
        throw new Error(`could not parse teams from h1: "${h1}"`);
    }
    return { day, date, time, homeTeam, awayTeam };
}

/**
 * Parses the 1X2 odds table (default tab).
 * Header cells read Bookmakers | 1 | X | 2 | Payout; each body row holds
 * the bookmaker name in its first cell and the three odds after it.
 *
 * @returns {Promise<Array<{bookmaker: string|null, home: string|null, draw: string|null, away: string|null}>>}
 */
async function extractMoneyline(page) {
    await page.locator('table').first().waitFor({ timeout: 30000 });
    // give the odds XHR a moment to fill the table
    await page.waitForTimeout(2500);

    const rows = await page.$$eval('table', (tables) => {
        const target = tables.find((t) =>
            /bookmakers/i.test(t.querySelector('thead')?.innerText || '')
            && /\b1\b/.test(t.querySelector('thead')?.innerText || '')
        );
        if (!target) return null;
        const headerText = [...target.querySelectorAll('thead th')]
            .map((th) => th.innerText.trim().toLowerCase());
        const idx1 = headerText.findIndex((h) => h === '1');
        const idxX = headerText.findIndex((h) => h === 'x');
        const idx2 = headerText.findIndex((h) => h === '2');
        if (idx1 < 0 || idxX < 0 || idx2 < 0) return null;
        return [...target.querySelectorAll('tbody tr')].map((tr) => {
            const tds = [...tr.querySelectorAll('td')];
            const nameEl = tds[0]?.querySelector('p');
            const cell = (i) => {
                const txt = (tds[i]?.innerText || '').trim();
                return txt === '' || txt === '-' ? null : txt;
            };
            return {
                bookmaker: nameEl ? nameEl.innerText.trim() : null,
                home: cell(idx1),
                draw: cell(idxX),
                away: cell(idx2),
            };
        });
    });

    if (!rows) throw new Error('1X2 odds table not found on match page');
    const usable = rows.filter((r) => r.bookmaker && (r.home || r.draw || r.away));
    logger.info(`parsed 1X2 odds for ${usable.length} bookmakers`);
    return usable;
}

/**
 * Best-effort Over/Under extraction via the market tab.
 * The O/U view lists one aggregated row per total:
 *   Handicap "Over/Under +2.5" | Over | Under | Payout
 * Returns null (not throw) when the tab/table cannot be driven, so one
 * market never sinks the whole match.
 *
 * @returns {Promise<Array<{total: string|null, label: string|null, over: string|null, under: string|null, payout: string|null}>|null>}
 */
async function extractOverUnder(page) {
    try {
        const clicked = await page.evaluate(() => {
            const span = [...document.querySelectorAll('span')]
                .find((s) => s.textContent.trim() === 'Over/Under');
            if (!span) return 'tab-missing';
            let el = span;
            while (el && !['BUTTON', 'A'].includes(el.tagName)) el = el.parentElement;
            (el || span).click();
            return 'clicked';
        });
        if (clicked !== 'clicked') {
            logger.warn('over/under tab not found, skipping');
            return null;
        }
        await page.waitForTimeout(4000);

        const rows = await page.$$eval('table', (tables) => {
            const target = tables.find((t) => {
                const head = (t.querySelector('thead')?.innerText || '').toLowerCase();
                return head.includes('over') && head.includes('under') && head.includes('handicap');
            });
            if (!target) return null;
            const headers = [...target.querySelectorAll('thead th')]
                .map((th) => th.innerText.trim().toLowerCase());
            const idx = (name) => headers.findIndex((h) => h === name);
            const idxH = idx('handicap'), idxOver = idx('over'),
                  idxUnder = idx('under'), idxPayout = idx('payout');
            if (idxOver < 0 || idxUnder < 0) return null;
            const cell = (tds, i) => {
                const txt = (tds[i]?.innerText || '').trim().replace(/\s+/g, ' ');
                return (txt === '' || txt === '-') ? null : txt;
            };
            return [...target.querySelectorAll('tbody tr')].map((tr) => {
                const tds = [...tr.querySelectorAll('td')];
                const handicap = idxH >= 0 ? cell(tds, idxH) : null;
                const m = handicap ? handicap.match(/[+-]?\d+(?:\.\d+)?/) : null;
                return {
                    total: m ? m[0].replace(/^\+/, '') : null,
                    label: handicap,
                    over: cell(tds, idxOver),
                    under: cell(tds, idxUnder),
                    payout: idxPayout >= 0 ? cell(tds, idxPayout) : null,
                };
            }).filter((r) => r.total && (r.over || r.under));
        });

        if (!rows) {
            logger.warn('over/under table not found after tab click');
            return null;
        }
        logger.info(`parsed over/under for ${rows.length} totals`);
        return rows;
    } catch (e) {
        logger.warn(`over/under extraction failed: ${e.message}`);
        return null;
    }
}

/**
 * Scrapes one match page: metadata + 1X2 odds (+ best-effort O/U probe).
 *
 * @param {import('playwright').Page} page
 * @param {string} link site-relative match link
 * @param {string} leagueName
 * @param {string} format
 */
export async function scrapeMatch(page, link, leagueName, format) {
    const url = `${BASE}${link}`;
    logger.info(`scraping match: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // wait for the app to hydrate (odds table renders client-side)
    await page.locator('table').first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);

    const metadata = await extractMetadata(page);
    const mlFullTime = await extractMoneyline(page);
    const underOver = await extractOverUnder(page);

    return {
        scrapedAt: new Date().toISOString(),
        leagueName,
        matchUrl: url,
        ...metadata,
        mlFullTime,
        underOver,
    };
}
