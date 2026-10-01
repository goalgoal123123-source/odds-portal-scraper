import logger from '../logger.js';
import { leaguesUrlsMap } from '../constants.js';
import { getUrlFrom } from '../utils/leagues.js';

const BASE = 'https://www.oddsportal.com';
const MATCH_LINK_RE = /^\/football\/h2h\/[^/]+\/[^/]+\/?$/;

/**
 * Leagues scanned by /api/search when the caller does not specify `leagues`.
 * Ordered by likelihood for keyword searches (top European competitions first).
 */
export const DEFAULT_SEARCH_LEAGUES = [
    'premier-league',
    'liga',
    'serie-a',
    'bundesliga',
    'ligue-1',
    'champions-league',
    'europa-league',
    'championship',
];

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Scans one league's upcoming page for fixture links whose text matches
 * all query words. Link text on current markup looks like
 * "13:30 Arsenal - Leeds" (kickoff time + "Home - Away").
 *
 * @returns {Promise<Array<{title,time,url,league}>>}
 */
async function scanLeague(browser, league, words) {
    const page = await browser.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1200 });
        await page.goto(getUrlFrom(league), { waitUntil: 'domcontentloaded', timeout: 60000 });
        // trigger lazy rendering of the fixture list
        await page.evaluate(() => window.scrollBy(0, 1600));
        await page.waitForTimeout(1200);

        const items = await page.$$eval('a[href*="/h2h/"]', (els) =>
            els.map((e) => ({
                href: e.getAttribute('href') || '',
                text: (e.innerText || '').replace(/\s+/g, ' ').trim(),
            }))
        );

        const out = [];
        const seen = new Set();
        for (const { href, text } of items) {
            const clean = href.split('#')[0];
            if (!MATCH_LINK_RE.test(clean)) continue;
            const tnorm = norm(text);
            // upcoming fixtures carry a kickoff time ("13:30 Arsenal - Leeds")
            if (!/\d{1,2}:\d{2}/.test(tnorm)) continue;
            // reject scorelines ("Arsenal 2 - 1 Leeds") — finished/live, not upcoming
            const noTime = tnorm.replace(/\d{1,2}:\d{2}/, '');
            if (/\b\d+\s*[-–:]\s*\d+\b/.test(noTime)) continue;
            if (!words.every((w) => tnorm.includes(w))) continue;

            const url = BASE + clean;
            if (seen.has(url)) continue;
            seen.add(url);
            const time = (text.match(/^\d{1,2}:\d{2}/) || [''])[0];
            const title = text.replace(/^\d{1,2}:\d{2}\s+/, '').trim();
            if (!title.includes('-')) continue;
            out.push({ title, time, url, league });
        }
        logger.info(`search scan ${league}: ${out.length} keyword hits`);
        return out;
    } catch (e) {
        logger.warn(`search scan ${league} failed: ${e.message}`);
        return [];
    } finally {
        try { await page.close(); } catch { /* ignore */ }
    }
}

/**
 * Keyword search over upcoming fixtures.
 * Scans league upcoming pages (2 at a time to stay within free-tier RAM)
 * and returns fixtures whose "Home - Away" title contains every query word.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} query e.g. "arsenal leeds"
 * @param {string[]} [leagueNames] defaults to DEFAULT_SEARCH_LEAGUES
 * @returns {Promise<Array<{title,time,url,league}>>} max 15, league-priority order
 */
export async function searchMatches(browser, query, leagueNames) {
    const leagues = (leagueNames && leagueNames.length ? leagueNames : DEFAULT_SEARCH_LEAGUES)
        .filter((l) => leaguesUrlsMap[l]);
    const words = norm(query).split(' ').filter(Boolean);
    if (!words.length || !leagues.length) return [];

    const results = [];
    const seen = new Set();
    for (let i = 0; i < leagues.length; i += 2) {
        const batch = leagues.slice(i, i + 2);
        const batchResults = await Promise.all(batch.map((l) => scanLeague(browser, l, words)));
        for (const r of batchResults.flat()) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            results.push(r);
            if (results.length >= 15) break;
        }
        if (results.length >= 15) break;
    }
    logger.info(`search "${query}": ${results.length} matches`);
    return results;
}
