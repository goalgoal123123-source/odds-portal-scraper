import logger from '../logger.js';
import { setOddsFormat } from './setOddsFormat.js';

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
 * Best-effort live score extraction for in-play pages.
 * Live pages show a breathing-dot <p class="result-live"> next to a line
 * like "2nd Set 0:1 (3:6, 4:3)". Returns the raw text or null.
 */
async function extractLiveScore(page) {
    try {
        const dot = page.locator('p.result-live').first();
        if ((await dot.count()) === 0) return null;
        const txt = (await dot.locator('xpath=..').innerText() || '')
            .replace(/\s+/g, ' ').trim();
        return txt || null;
    } catch {
        return null;
    }
}

/**
 * Parses the moneyline odds table (default tab).
 * Football shows 1/X/2; sports without draws (tennis, basketball, …)
 * show 1/2 on their default "Home/Away" tab — the X column is optional
 * and comes back as null when absent.
 * Header cells read Bookmakers | 1 | [X] | 2 | Payout; each body row holds
 * the bookmaker name in its first cell and the odds after it.
 * Works for both pre-match and in-play (/inplay-odds/) pages — the live
 * table has the same shape, with odds links inside the cells.
 *
 * @returns {Promise<{rows: Array<{rowIndex: number, bookmaker: string|null, home: string|null, draw: string|null, away: string|null}>, colHome: number, colDraw: number, colAway: number}>}
 *   rows carry their tbody rowIndex plus the header column indices so the
 *   opening-odds hover pass can address the exact same cells.
 */
async function extractMoneyline(page) {
    await page.locator('table').first().waitFor({ timeout: 30000 });
    // give the odds XHR a moment to fill the table
    await page.waitForTimeout(2500);

    const parsed = await page.$$eval('table', (tables) => {
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
        if (idx1 < 0 || idx2 < 0) return null;
        const rows = [...target.querySelectorAll('tbody tr')].map((tr, rowIndex) => {
            const tds = [...tr.querySelectorAll('td')];
            const nameEl = tds[0]?.querySelector('p');
            const cell = (i) => {
                const txt = (tds[i]?.innerText || '').trim();
                return txt === '' || txt === '-' ? null : txt;
            };
            return {
                rowIndex,
                bookmaker: nameEl ? nameEl.innerText.trim() : null,
                home: cell(idx1),
                draw: idxX >= 0 ? cell(idxX) : null,
                away: cell(idx2),
            };
        });
        return { rows, idx1, idxX, idx2 };
    });

    if (!parsed) throw new Error('moneyline odds table not found on match page');
    const usable = parsed.rows.filter((r) => r.bookmaker && (r.home || r.draw || r.away));
    logger.info(`parsed moneyline odds for ${usable.length} bookmakers`);
    return { rows: usable, colHome: parsed.idx1, colDraw: parsed.idxX, colAway: parsed.idx2 };
}

/**
 * Best-effort opening-odds extraction via the "ODDS MOVEMENT" hover tooltip.
 * Each moneyline odds cell, when hovered, renders a div.tooltip-popup inside
 * the <td> whose text looks like:
 *   "ODDS MOVEMENT 17 Sept, 19:07 1.25 -0.02 Opening odds: 11 Sept, 04:45 1.27 Click to BET NOW"
 * The opening data is NOT in the cell DOM — hovering is the only reliable
 * way to read it. Cells whose tooltip never appears are skipped (null).
 * NOTE: on in-play pages the "Opening odds" is the kickoff price, not the
 * pre-match opening price.
 *
 * @returns {Promise<Object<string, {opening: string|null, openingTime: string|null, changeTime: string|null}>>}
 *   keyed by `${tbodyRowIndex}:${tdColumnIndex}`.
 */
async function extractOpeningOdds(page) {
    const moves = {};
    try {
        const table = page.locator('table').filter({
            has: page.locator('thead', { hasText: /bookmakers/i }),
        }).first();
        await table.waitFor({ timeout: 15000 });

        const headerText = (await table.locator('thead th').allInnerTexts())
            .map((h) => h.trim().toLowerCase());
        const colHome = headerText.findIndex((h) => h === '1');
        const colDraw = headerText.findIndex((h) => h === 'x');
        const colAway = headerText.findIndex((h) => h === '2');
        if (colHome < 0 || colAway < 0) return moves;
        const cols = [colHome, colDraw, colAway].filter((c) => c >= 0);

        const rows = table.locator('tbody tr');
        const n = Math.min(await rows.count(), 60);
        for (let r = 0; r < n; r++) {
            const tds = rows.nth(r).locator('td');
            for (const c of cols) {
                const td = tds.nth(c);
                let cellText = '';
                try { cellText = (await td.innerText()).trim(); } catch { continue; }
                if (!cellText || cellText === '-') continue;
                try {
                    await td.hover({ timeout: 8000 });
                    const tip = td.locator('div.tooltip-popup');
                    await tip.waitFor({ timeout: 3000 });
                    const tipText = (await tip.innerText()).replace(/\s+/g, ' ').trim();
                    const open = tipText.match(/opening odds:\s*([0-9]{1,2} [A-Za-z]{3,},?\s*\d{1,2}:\d{2})\s+(\d+(?:\.\d+)?)/i);
                    const cur = tipText.match(/odds movement\s*([0-9]{1,2} [A-Za-z]{3,},?\s*\d{1,2}:\d{2})\s+(\d+(?:\.\d+)?)/i);
                    if (open) {
                        moves[`${r}:${c}`] = {
                            opening: open[2],
                            openingTime: open[1].replace(/\s+/g, ' '),
                            changeTime: cur ? cur[1].replace(/\s+/g, ' ') : null,
                        };
                    }
                } catch {
                    // no tooltip for this cell — leave it out
                }
            }
        }
        // park the mouse away so no tooltip lingers over the table
        try { await page.mouse.move(4, 4); } catch { /* ignore */ }
    } catch (e) {
        logger.warn(`opening-odds extraction failed: ${e.message}`);
    }
    return moves;
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
 * Scrapes one match page: metadata + moneyline odds (1X2, or 1/2 for
 * sports without draws) (+ best-effort O/U probe).
 * Also handles in-play pages (/inplay-odds/ URLs): the moneyline table has
 * the same shape, and the current score is captured best-effort.
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
    await setOddsFormat(page, format);

    // wait for the app to hydrate (odds table renders client-side)
    await page.locator('table').first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);

    const metadata = await extractMetadata(page);
    const ml = await extractMoneyline(page);
    // opening odds must be read while the moneyline tab is still showing
    // (extractOverUnder switches tabs afterwards)
    const opening = await extractOpeningOdds(page);
    const pick = (row, col) => (col >= 0 ? opening[`${row.rowIndex}:${col}`] || null : null);
    const mlFullTime = ml.rows.map((row) => {
        const oH = pick(row, ml.colHome);
        const oD = pick(row, ml.colDraw);
        const oA = pick(row, ml.colAway);
        return {
            bookmaker: row.bookmaker,
            home: row.home,
            draw: row.draw,
            away: row.away,
            openHome: oH?.opening ?? null,
            openDraw: oD?.opening ?? null,
            openAway: oA?.opening ?? null,
            openHomeTime: oH?.openingTime ?? null,
            openDrawTime: oD?.openingTime ?? null,
            openAwayTime: oA?.openingTime ?? null,
            changeHomeTime: oH?.changeTime ?? null,
            changeDrawTime: oD?.changeTime ?? null,
            changeAwayTime: oA?.changeTime ?? null,
        };
    });
    const underOver = await extractOverUnder(page);
    const liveScore = await extractLiveScore(page);
    const live = link.includes('/inplay-odds/') || liveScore !== null;

    return {
        scrapedAt: new Date().toISOString(),
        leagueName,
        matchUrl: url,
        live,
        liveScore,
        ...metadata,
        mlFullTime,
        underOver,
    };
}
