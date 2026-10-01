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
 *   GET /api/search?q=<keyword>&leagues=<csv>&format=<eu|uk|us|...>
 *   GET /api/odds?url=<oddsportal h2h url>&format=<eu|uk|us|...>
 */

import express from 'express';
import launchBrowser from './lib/browser.js';
import { historicScraper, nextMatchesScraper, searchMatches } from './lib/scraping-v2/index.js';
import { scrapeMatch } from './lib/scraping-v2/scrapeMatch.js';
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
  const browser = await launchBrowser({ timezoneId: "UTC", locale: "en-GB" });
  const results = [];
  const errors = [];
  const onResult = async (r) => {
    if (r.data) results.push(r.data);
    else errors.push({ link: r.link, error: r.error });
  };
  try {
    if (kind === 'next') {
      await nextMatchesScraper(browser, params.league, params.format, onResult, params.limit);
    } else {
      await historicScraper(browser, params.league, params.startYear, params.endYear,
        params.format, onResult, params.limit);
    }
    return { results, errors };
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

  const { results: matches, errors } = await runScrape('next', { league, format, limit });
  res.json({ league, format, count: matches.length, matches, ...(errors.length ? { errors } : {}) });
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

  const { results: matches, errors } = await runScrape('historic', { league, format, startYear, endYear, limit });
  res.json({ league, format, startYear, endYear, count: matches.length, matches, ...(errors.length ? { errors } : {}) });
}));

app.get('/api/search', withJob(async (req, res) => {
  const q = (req.query.q || '').trim();
  const format = req.query.format || DEFAULT_FORMAT;
  if (!q) return badRequest(res, 'missing required query param: q (keyword, e.g. ?q=arsenal)');
  const formatErr = checkFormat(format);
  if (formatErr) return badRequest(res, formatErr, { formats: FORMATS });
  const leagues = String(req.query.leagues || '').split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = leagues.filter((l) => !leaguesUrlsMap[l]);
  if (unknown.length) return badRequest(res, `unknown league(s): ${unknown.join(', ')}`, { leagues: LEAGUES });

  const browser = await launchBrowser({ timezoneId: "UTC", locale: "en-GB" });
  try {
    const results = await searchMatches(browser, q, leagues.length ? leagues : undefined);
    res.json({ ok: true, query: q, count: results.length, results });
  } finally {
    try { await browser.close(); } catch (e) { logger.warn(`browser close failed: ${e}`); }
  }
}));

app.get('/api/odds', withJob(async (req, res) => {
  const url = (req.query.url || '').trim();
  const format = req.query.format || DEFAULT_FORMAT;
  const formatErr = checkFormat(format);
  if (formatErr) return badRequest(res, formatErr, { formats: FORMATS });
  const m = url.match(/^https:\/\/(www\.)?oddsportal\.com(\/football\/h2h\/[^?#]+)/);
  if (!m) return badRequest(res, 'url must be an oddsportal.com football h2h match URL');

  const browser = await launchBrowser({ timezoneId: "UTC", locale: "en-GB" });
  try {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 1600, height: 1200 });
      const data = await scrapeMatch(page, m[2], 'search', format);
      const books = (data.mlFullTime || [])
        .filter((b) => b.bookmaker)
        .map((b) => [b.bookmaker, b.home, b.draw, b.away]);
      res.json({
        ok: true,
        snapshot: {
          home: data.homeTeam,
          away: data.awayTeam,
          day: data.day,
          date: data.date,
          time: data.time,
          books,
          match_url: data.matchUrl,
          scraped_at: data.scrapedAt,
          note: '1X2 odds as seen from this server (Singapore for -sg)',
        },
      });
    } finally {
      if (!page.isClosed()) await page.close();
    }
  } finally {
    try { await browser.close(); } catch (e) { logger.warn(`browser close failed: ${e}`); }
  }
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
      'GET /api/search?q=<keyword>&leagues=<csv>&format=<format>',
      'GET /api/odds?url=<match url>&format=<format>',
    ],
  });
});


app.listen(PORT, '0.0.0.0', () => {
  logger.info(`odds-portal-scraper API listening on port ${PORT}`);
});
