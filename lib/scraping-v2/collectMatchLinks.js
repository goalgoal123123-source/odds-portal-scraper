import logger from '../logger.js';

const MATCH_LINK_RE = /^\/football\/h2h\/[^/]+\/[^/]+\/?$/;

/**
 * Collects match-detail links from a league list / results page.
 * Current markup has no data-testid rows; match links are anchors whose
 * href looks like /football/h2h/<team>-<id>/<team>-<id>/ (optionally with
 * a #tab fragment, which is stripped).
 *
 * @param {import('playwright').Page} page already on the list page
 * @param {number} [limit]
 * @returns {Promise<string[]>} site-relative links, deduplicated
 */
export async function collectMatchLinks(page, limit) {
    await page.waitForSelector('a[href*="/h2h/"]', { timeout: 45000 });

    const hrefs = await page.$$eval('a[href*="/h2h/"]', (els) =>
        els.map((e) => e.getAttribute('href')).filter(Boolean)
    );

    const seen = new Set();
    const links = [];
    for (const href of hrefs) {
        const clean = href.split('#')[0];
        if (!MATCH_LINK_RE.test(clean)) continue;
        if (seen.has(clean)) continue;
        seen.add(clean);
        links.push(clean);
        if (limit && links.length >= limit) break;
    }

    logger.info(`collected ${links.length} match links`);
    return links;
}
