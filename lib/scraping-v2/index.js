/**
 * v2 scraping layer for the current OddsPortal markup (2026).
 *
 * The upstream repo's selectors target an older layout that used
 * `data-testid` attributes (game-row, odd-container, ...). The live site no
 * longer renders any data-testid attributes, so this module re-implements
 * link collection, odds-format switching and match parsing against the
 * current Next.js markup.
 */
export { nextMatchesScraper } from './nextMatches.js';
export { historicScraper } from './historic.js';
export { searchMatches, searchAllSports, DEFAULT_SEARCH_LEAGUES } from './searchMatches.js';
