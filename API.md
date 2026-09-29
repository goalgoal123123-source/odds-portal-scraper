# odds-portal-scraper — Web Service

Forked from [Mg30/odds-portal-scraper](https://github.com/Mg30/odds-portal-scraper)
(Node.js CLI for scraping oddsportal.com with Playwright).

This fork adds an HTTP wrapper (`server.js`) so the scraper runs as a web
service. Original CLI (`index.js`) is untouched.

## Running

```
npm install
node server.js        # listens on $PORT (default 8080)
```

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | liveness probe: `{ ok, activeJobs, maxJobs, ts }` |
| GET | `/api/leagues` | list of scrapeable league names |
| GET | `/api/odds-formats` | list of supported odds formats |
| GET | `/api/next-matches?league=<l>&format=<f>&limit=<n>` | upcoming matches + odds for a league |
| GET | `/api/historic?league=<l>&start=<yyyy>&end=<yyyy>&format=<f>` | historical odds for a season range |

- `format` defaults to `eu`; `limit` defaults to 20 (max 200).
- Only one scrape job runs at a time by default (`MAX_CONCURRENT_JOBS=1`);
  extra requests get HTTP 429.

## Examples

```
GET /api/leagues
GET /api/next-matches?league=premier-league&format=eu&limit=10
GET /api/historic?league=serie-a&start=2023&end=2024&format=us
```

## Deploy (Docker)

`Dockerfile` uses the Playwright official image
(`mcr.microsoft.com/playwright:v1.55.0-jammy`) so Chromium is preinstalled.
`package.json` pins `playwright@1.55.0` to match the image's browser build.

Env vars: `PORT` (set by the host), `ODDS_FORMAT` (default `eu`),
`MAX_CONCURRENT_JOBS` (default `1`), `DEFAULT_LIMIT` (default `20`),
`ODDS_PORTAL_PROXY_URL` (optional, passed through to the scraper).
