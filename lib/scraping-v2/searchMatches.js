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

const SPORT_RE = /^\/([a-z][a-z0-9-]*)\/h2h\/[^/]+\/[^/]+/;
const UPCOMING_RE = /^\d{1,2}\/[A-Za-z]{3}\b/;
const SCORELINE_RE = /\b\d+\s*[-–:]\s*\d+\b/;

/**
 * "Arsenal Arsenal - Leeds Leeds" -> "Arsenal - Leeds".
 * Search result rows duplicate each team name (two <p> per side).
 */
function cleanTitle(text) {
    const noDate = text.replace(UPCOMING_RE, '').trim();
    const parts = noDate.split(/\s+-\s+/);
    if (parts.length < 2) return null;
    const cleanSide = (s) => {
        const words = s.trim().split(/\s+/);
        if (words.length >= 2 && words.length % 2 === 0) {
            const h = words.length / 2;
            if (words.slice(0, h).join(' ') === words.slice(h).join(' ')) {
                return words.slice(0, h).join(' ');
            }
        }
        return s.trim();
    };
    const home = cleanSide(parts[0]);
    const away = cleanSide(parts.slice(1).join(' - '));
    if (!home || !away) return null;
    return `${home} - ${away}`;
}

/**
 * Site-wide keyword search across ALL sports via OddsPortal's own search
 * page (https://www.oddsportal.com/search/<query>/). Results on the
 * "Next Matches" tab are grouped by Sport / Country / League; only
 * upcoming fixtures are returned (finished/live rows carry scorelines).
 *
 * @param {import('playwright').Browser} browser
 * @param {string} query e.g. "djokovic"
 * @returns {Promise<Array<{title,time,url,league,sport}>>} max 15
 */
export async function searchAllSports(browser, query) {
    const page = await browser.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1200 });
        const url = `${BASE}/search/${encodeURIComponent(query)}/`;
        logger.info(`all-sports search: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // best-effort: dismiss promo popup if it appears
        try {
            await page.locator('button:has-text("Close")').first().click({ timeout: 2500 });
        } catch { /* ignore */ }

        let rows = [];
        try {
            await page.locator('a.group[href*="/h2h/"]').first().waitFor({ timeout: 30000 });
            await page.waitForTimeout(1500);
            rows = await page.$$eval('a.group[href*="/h2h/"]', (anchors) => {
                const crumbs = [...document.querySelectorAll('div[class*="bg-gray-med_light"]')];
                return anchors.map((a) => {
                    let crumb = '';
                    for (const c of crumbs) {
                        if (c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            crumb = c.innerText.replace(/\s+/g, ' ').trim();
                        } else break;
                    }
                    return {
                        href: a.getAttribute('href') || '',
                        text: (a.innerText || '').replace(/\s+/g, ' ').trim(),
                        crumb,
                    };
                });
            });
        } catch (e) {
            logger.info(`all-sports search "${query}": no result rows (${e.message})`);
            return [];
        }

        const byKey = new Map();
        for (const r of rows) {
            const m = r.href.match(SPORT_RE);
            if (!m) continue;
            const sport = m[1];
            if (!UPCOMING_RE.test(r.text)) continue;
            const noDate = r.text.replace(UPCOMING_RE, '');
            if (SCORELINE_RE.test(noDate)) continue; // finished/live
            const title = cleanTitle(r.text);
            if (!title) continue;
            // the search page can render a stale duplicate entry under the
            // wrong sport group (different entity ids, no #fragment) — the
            // url sport must agree with the breadcrumb sport
            const crumbSport = (r.crumb.split('/')[0] || '').trim().toLowerCase();
            if (crumbSport && crumbSport !== sport.toLowerCase()) continue;
            const fullUrl = BASE + r.href; // keep #fragment: pins the exact fixture
            const time = (r.text.match(UPCOMING_RE) || [''])[0];
            // dedupe same fixture listed twice: prefer the url with #fragment
            const key = norm(title) + '|' + time;
            const prev = byKey.get(key);
            if (prev && (prev.url.includes('#') || !fullUrl.includes('#'))) continue;
            byKey.set(key, { title, time, url: fullUrl, league: r.crumb, sport });
        }
        const out = [...byKey.values()].slice(0, 15);
        logger.info(`all-sports search "${query}": ${out.length} upcoming fixtures`);
        return out;
    } finally {
        try { await page.close(); } catch { /* ignore */ }
    }
}

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
