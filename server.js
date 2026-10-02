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
import { historicScraper, nextMatchesScraper, searchMatches, searchAllSports } from './lib/scraping-v2/index.js';
import { scrapeMatch } from './lib/scraping-v2/scrapeMatch.js';
import { leaguesUrlsMap, oddsFormatMap } from './lib/constants.js';
import { getUrlFrom } from './lib/utils/leagues.js';
import logger from './lib/logger.js';

const app = express();
app.use(express.json());

// CORS: allow browser pages on any origin (e.g. the public comparison page
// served from dochost.co) to call this read-only API directly. Without this,
// browsers block the response and page fetches fail with "Failed to fetch"
// even though the API itself works fine.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  // NOTE: the `leagues` param is deprecated and ignored — search now covers
  // all sports via OddsPortal's site-wide search page.

  const browser = await launchBrowser({ timezoneId: "UTC", locale: "en-GB" });
  try {
    const results = await searchAllSports(browser, q);
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
  const m = url.match(/^https:\/\/(www\.)?oddsportal\.com(\/[a-z][a-z0-9-]*\/h2h\/[^\s?]+)/);
  if (!m) return badRequest(res, 'url must be an oddsportal.com <sport>/h2h/… match URL (any sport: football, tennis, basketball, …)');

  const browser = await launchBrowser({ timezoneId: "UTC", locale: "en-GB" });
  try {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 1600, height: 1200 });
      const data = await scrapeMatch(page, m[2], 'search', format);
      const books = (data.mlFullTime || [])
        .filter((b) => b.bookmaker)
        .map((b) => [b.bookmaker, b.home, b.draw, b.away,
          b.openHome ?? null, b.openDraw ?? null, b.openAway ?? null,
          b.openHomeTime ?? null, b.openDrawTime ?? null, b.openAwayTime ?? null,
          b.changeHomeTime ?? null, b.changeDrawTime ?? null, b.changeAwayTime ?? null]);
      const sport = (m[2].match(/^\/([a-z][a-z0-9-]*)\//) || [])[1] || '';
      res.json({
        ok: true,
        snapshot: {
          sport,
          home: data.homeTeam,
          away: data.awayTeam,
          day: data.day,
          date: data.date,
          time: data.time,
          live: !!data.live,
          live_score: data.liveScore || null,
          books,
          match_url: data.matchUrl,
          scraped_at: data.scrapedAt,
          note: '1X2 odds (1/2 only for sports without draws, e.g. tennis/basketball) as seen from this server (Singapore for -sg); third-party, reference-only, may be delayed/incomplete; not trading advice. books entries are [name, o1, ox, o2, open1, openX, open2, openTime1, openTimeX, openTime2, changeTime1, changeTimeX, changeTime2] where open* = opening odds (kickoff odds on live pages) with timestamps as shown on OddsPortal.' + (data.live ? ' LIVE in-play odds: snapshot only, prices move during the match.' : ''),
        },
      });
    } finally {
      if (!page.isClosed()) await page.close();
    }
  } finally {
    try { await browser.close(); } catch (e) { logger.warn(`browser close failed: ${e}`); }
  }
}));

/**
 * China-accessible proxy endpoints.
 * The site's browser code calls these instead of the blocked upstreams directly.
 *   GET /proxy/pm-data/*  -> https://data-api.polymarket.com/*
 *   GET /proxy/pm-gamma/* -> https://gamma-api.polymarket.com/*
 *   GET /proxy/od/*       -> https://oddspedia.com/api/v1/* (auto-adds language=en)
 */
async function proxyFetch(res, upstreamUrl) {
  try {
    const r = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cn-proxy/1.0)', 'Accept': 'application/json' },
    });
    const body = await r.text();
    res.status(r.status);
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'proxy upstream failed', message: String(e.message || e) });
  }
}

app.get('/proxy/pm-data/*', (req, res) => {
  const path = req.params[0] || '';
  const qs = new URLSearchParams(req.query).toString();
  proxyFetch(res, `https://data-api.polymarket.com/${path}${qs ? '?' + qs : ''}`);
});

app.get('/proxy/pm-gamma/*', (req, res) => {
  const path = req.params[0] || '';
  const qs = new URLSearchParams(req.query).toString();
  proxyFetch(res, `https://gamma-api.polymarket.com/${path}${qs ? '?' + qs : ''}`);
});

app.get('/proxy/od/*', (req, res) => {
  const path = req.params[0] || '';
  const qs = new URLSearchParams(req.query);
  if (!qs.has('language')) qs.set('language', 'en');
  const qstr = qs.toString();
  proxyFetch(res, `https://oddspedia.com/api/v1/${path}${qstr ? '?' + qstr : ''}`);
});

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
      'GET /proxy/pm-data/*  (China proxy for data-api.polymarket.com)',
      'GET /proxy/pm-gamma/* (China proxy for gamma-api.polymarket.com)',
      'GET /proxy/od/*      (China proxy for oddspedia.com/api/v1)',
    ],
  });
});


app.listen(PORT, '0.0.0.0', () => {
  logger.info(`odds-portal-scraper API listening on port ${PORT}`);
});
