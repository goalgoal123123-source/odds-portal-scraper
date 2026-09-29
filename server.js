#!/usr/bin/env node
/**
 * HTTP API wrapper around the odds-portal-scraper library.
 *
 * Exposes the CLI's scraping capabilities as REST endpoints so the scraper
 * can run as a web service (e.g. on Render's free tier).
 *
 * Endpoints:
 *   GET /api/health
 *   GET /api/leagues
 *   GET /api/odds-formats
 *   GET /api/next-matches?league=<league>&format=<eu|uk|us|...>&limit=<n>
 *   GET /api/historic?league=<league>&start=<yyyy>&end=<yyyy>&format=<...>&limit=<n> (per season)
 */

import express from 'express';
import launchBrowser from './lib/browser.js';
import { historicScraper, nextMatchesScraper } from './lib/scraping-v2/index.js';
import { leaguesUrlsMap, oddsFormatMap } from './lib/constants.js';
import { getUrlFrom } from './lib/utils/leagues.js';
import logger from './lib/logger.js';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);
const DEFAULT_FORMAT = process.env.ODDS_FORMAT || 'eu';
const MAX_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10);
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || '20', 10);

let activeJobs = 0;

const LEAGUES = Object.keys(leaguesUrlsMap);
const FORMATS = Object.keys(oddsFormatMap);

function badRequest(res, message, extra) {
  return res.status(400).json({ error: message, ...extra });
}

function checkLeague(league) {
  if (!league) return 'missing required query param: league';
  if (!leaguesUrlsMap[league]) return `unknown league: ${league}`;
  return null;
}

function checkFormat(format) {
  if (!oddsFormatMap[format]) return `unknown odds format: ${format}`;
  return null;
}

async function runScrape(kind, params) {
  const browser = await launchBrowser();
  const results = [];
  try {
    if (kind === 'next') {
      await nextMatchesScraper(browser, params.league, params.format,
        async (data) => { results.push(data); }, params.limit);
    } else {
      await historicScraper(browser, params.league, params.startYear, params.endYear,
        params.format, async (data) => { results.push(data); }, params.limit);
    }
    return results;
  } finally {
    try { await browser.close(); } catch (e) { logger.warn(`browser close failed: ${e}`); }
  }
}

function withJob(fn) {
  return async (req, res) => {
    if (activeJobs >= MAX_JOBS) {
      return res.status(429).json({ error: 'a scrape job is already running, try again later' });
    }
    activeJobs += 1;
    const started = Date.now();
    try {
      await fn(req, res);
    } catch (err) {
      logger.error(`scrape failed: ${err}`);
      if (!res.headersSent) res.status(500).json({ error: 'scrape failed', detail: String(err && err.message || err) });
    } finally {
      activeJobs -= 1;
      logger.info(`job finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, activeJobs, maxJobs: MAX_JOBS, ts: new Date().toISOString() });
});

app.get('/api/leagues', (req, res) => {
  res.json({ leagues: LEAGUES });
});

app.get('/api/odds-formats', (req, res) => {
  res.json({ formats: FORMATS });
});

app.get('/api/next-matches', withJob(async (req, res) => {
  const league = req.query.league;
  const format = req.query.format || DEFAULT_FORMAT;
  const limit = parseInt(req.query.limit || String(DEFAULT_LIMIT), 10);

  const leagueErr = checkLeague(league);
  if (leagueErr) return badRequest(res, leagueErr, { leagues: LEAGUES });
  const formatErr = checkFormat(format);
  if (formatErr) return badRequest(res, formatErr, { formats: FORMATS });
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return badRequest(res, 'limit must be between 1 and 200');
  }

  const matches = await runScrape('next', { league, format, limit });
  res.json({ league, format, count: matches.length, matches });
}));

app.get('/api/historic', withJob(async (req, res) => {
  const league = req.query.league;
  const format = req.query.format || DEFAULT_FORMAT;
  const startYear = parseInt(req.query.start, 10);
  const endYear = parseInt(req.query.end, 10);
  const limit = parseInt(req.query.limit || '20', 10);

  const leagueErr = checkLeague(league);
  if (leagueErr) return badRequest(res, leagueErr, { leagues: LEAGUES });
  const formatErr = checkFormat(format);
  if (formatErr) return badRequest(res, formatErr, { formats: FORMATS });
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) {
    return badRequest(res, 'missing required query params: start, end (years, e.g. 2023)');
  }
  if (startYear > endYear) return badRequest(res, 'start must be <= end');
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return badRequest(res, 'limit must be between 1 and 200 (per season)');
  }

  const matches = await runScrape('historic', { league, format, startYear, endYear, limit });
  res.json({ league, format, startYear, endYear, count: matches.length, matches });
}));

app.get('/', (req, res) => {
  res.json({
    service: 'odds-portal-scraper',
    endpoints: [
      'GET /api/health',
      'GET /api/leagues',
      'GET /api/odds-formats',
      'GET /api/next-matches?league=<league>&format=<format>&limit=<n>',
      'GET /api/historic?league=<league>&start=<yyyy>&end=<yyyy>&format=<format>',
      'GET /api/debug-dom?league=<league>',
    ],
  });
});

// Diagnostic: dump what an OddsPortal page actually renders as, so
// selectors can be fixed when OddsPortal changes its markup or gating.
// ?league=<name> for league list pages, or ?path=/football/h2h/... for an arbitrary page path.
app.get('/api/debug-dom', withJob(async (req, res) => {
  let targetUrl;
  if (req.query.path) {
    const p = String(req.query.path);
    if (!p.startsWith('/') || p.includes('..')) return badRequest(res, 'path must be a site-relative path like /football/h2h/...');
    targetUrl = `https://www.oddsportal.com${p}`;
  } else {
    const league = req.query.league || 'premier-league';
    const leagueErr = checkLeague(league);
    if (leagueErr) return badRequest(res, leagueErr, { leagues: LEAGUES });
    targetUrl = getUrlFrom(league);
  }

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    // scroll to trigger lazy loading
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(1500);
    }
    const htmlSelector = req.query.html ? String(req.query.html) : null;
    const info = await page.evaluate((htmlSel) => {
      const q = (s) => document.querySelectorAll(s).length;
      const testids = {};
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const t = el.getAttribute('data-testid');
        testids[t] = (testids[t] || 0) + 1;
      });
      const bodyText = document.body.innerText || '';
      const tables = [...document.querySelectorAll('table')].slice(0, 3).map((t) =>
        t.innerText.slice(0, 300).replace(/\n/g, ' | '));
      const h2hLinks = [...document.querySelectorAll('a[href*="/h2h/"]')]
        .slice(0, 25).map((a) => a.getAttribute('href'));
      // optional: raw HTML of elements matching ?html=<selector> (comma-separated)
      let htmlSamples = null;
      if (htmlSel) {
        try {
          htmlSamples = {};
          for (const sel of htmlSel.split(',').map((s) => s.trim()).filter(Boolean)) {
            if (sel.startsWith('up=')) {
              // up=2,span -> outerHTML of 2nd ancestor of elements matching selector
              const m = sel.match(/^up=(\d+),(.+)$/);
              if (m) {
                const n = parseInt(m[1], 10);
                try {
                  htmlSamples[sel] = [...document.querySelectorAll(m[2])].slice(0, 3)
                    .map((el) => {
                      let a = el;
                      for (let i = 0; i < n && a.parentElement; i++) a = a.parentElement;
                      return a.outerHTML.slice(0, 4000);
                    });
                } catch (e) { htmlSamples[sel] = ['bad selector: ' + e.message]; }
                continue;
              }
            }
            if (sel.startsWith('text=')) {
              const needle = sel.slice(5).toLowerCase();
              const found = [];
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let node;
              while ((node = walker.nextNode()) && found.length < 3) {
                const t = (node.textContent || '').trim();
                if (t.length > 0 && t.length < 60 && t.toLowerCase().includes(needle)
                    && !['script', 'style'].includes(node.tagName.toLowerCase())) {
                  // prefer leaf-ish elements
                  if (![...node.children].some((c) => (c.textContent || '').trim() === t)) {
                    found.push(node.outerHTML.slice(0, 2500));
                  }
                }
              }
              htmlSamples[sel] = found;
              continue;
            }
            htmlSamples[sel] = [...document.querySelectorAll(sel)].slice(0, 3)
              .map((el) => el.outerHTML.slice(0, 4000));
          }
        } catch (e) { htmlSamples = { error: 'bad selector: ' + e.message }; }
      }
      return {
        title: document.title,
        url: location.href,
        bodyTextStart: bodyText.slice(0, 600),
        bodyTextLength: bodyText.length,
        hasBookmakersHeader: /bookmakers/i.test(bodyText),
        hasDroppingOdds: /dropping odds/i.test(bodyText),
        testidCounts: testids,
        counts: {
          'div[data-testid="game-row"]': q('div[data-testid="game-row"]'),
          '[data-testid]': q('[data-testid]'),
          'a[href*="/h2h/"]': q('a[href*="/h2h/"]'),
          'table': q('table'),
        },
        tableSamples: tables,
        h2hLinkSamples: h2hLinks,
        htmlSamples,
      };
    }, htmlSelector);
    res.json({ targetUrl, ...info });
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`odds-portal-scraper API listening on port ${PORT}`);
});
