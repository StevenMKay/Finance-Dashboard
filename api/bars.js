/* Vercel serverless function: GET /api/bars
 *
 *   GET /api/bars?ticker=AMD&period=60d&interval=5m
 *
 * Proxies Polygon.io aggregates so the API key stays server-side, then
 * filters to US equities regular trading hours (9:30-16:00 ET) and
 * stamps each bar with `minuteOfDay` + `dateKey` (ET) so the strategy
 * engine never has to think about timezones.
 *
 * Env vars
 *   POLYGON_API_KEY    — required. If missing the endpoint returns 503
 *                        with { mock: true } so the client can fall back
 *                        to the in-browser mock candle generator.
 *   ALLOWED_ORIGINS    — optional, comma-separated CORS allow-list.
 *
 * Response shape
 *   {
 *     ticker, period, interval, intervalMin, count,
 *     candles: [{ t, o, h, l, c, v, minuteOfDay, dateKey }, ...],
 *     source: 'polygon'
 *   }
 */

const CACHE = new Map(); // key -> { at, data }
const TTL_MS = 5 * 60 * 1000;
const MAX_BARS = 50000;

const VALID_PERIODS   = { '30d': 30, '60d': 60, '90d': 90 };
const VALID_INTERVALS = { '1m': 1, '5m': 5, '15m': 15, '30m': 30 };

const MARKET_OPEN_MIN  = 9 * 60 + 30; // 9:30 ET
const MARKET_CLOSE_MIN = 16 * 60;     // 16:00 ET

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  let allowed = '';
  if (!allow.length) {
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      allowed = origin || '*';
    }
  } else if (allow.includes(origin)) {
    allowed = origin;
  }
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

// Convert a unix-ms timestamp into ET calendar+clock parts via Intl.
// This handles DST correctly without us shipping a tz database.
const ET_DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function etParts(ms) {
  const parts = ET_DTF.formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  // Intl can emit '24' for midnight in some Node builds — normalize to 0.
  const hour = o.hour === '24' ? 0 : Number(o.hour);
  const minute = Number(o.minute);
  return {
    minuteOfDay: hour * 60 + minute,
    dateKey: `${o.year}-${o.month}-${o.day}`
  };
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    // Signal mock-mode to the client. NOT a 500 — this is an expected
    // state during local dev and the page handles it gracefully.
    return res.status(503).json({
      error: 'POLYGON_API_KEY not configured',
      mock: true
    });
  }

  const q = req.query || {};
  const ticker   = String(q.ticker   || '').toUpperCase().trim();
  const period   = String(q.period   || '60d').toLowerCase();
  const interval = String(q.interval || '5m').toLowerCase();

  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return res.status(400).json({ error: 'invalid ticker' });
  }
  if (!VALID_PERIODS[period]) {
    return res.status(400).json({ error: 'invalid period (allowed: 30d, 60d, 90d)' });
  }
  if (!VALID_INTERVALS[interval]) {
    return res.status(400).json({ error: 'invalid interval (allowed: 1m, 5m, 15m, 30m)' });
  }

  const cacheKey = ticker + '|' + period + '|' + interval;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json(hit.data);
  }

  const days       = VALID_PERIODS[period];
  const multiplier = VALID_INTERVALS[interval];

  // Polygon wants YYYY-MM-DD in ET. Use calendar days; Polygon returns
  // only actual trading bars within that window.
  const now = Date.now();
  const toP   = etParts(now);
  const fromP = etParts(now - days * 24 * 60 * 60 * 1000);
  const toDate   = toP.dateKey;
  const fromDate = fromP.dateKey;

  const url =
    'https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(ticker) +
    '/range/' + multiplier + '/minute/' +
    encodeURIComponent(fromDate) + '/' + encodeURIComponent(toDate) +
    '?adjusted=true&sort=asc&limit=' + MAX_BARS +
    '&apiKey=' + encodeURIComponent(apiKey);

  let upstream;
  try {
    upstream = await fetch(url);
  } catch (e) {
    return res.status(502).json({ error: 'upstream network error' });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return res.status(502).json({ error: 'upstream auth failed' });
  }
  if (upstream.status === 429) {
    return res.status(429).json({ error: 'rate limited by Polygon', retryAfter: 60 });
  }
  if (!upstream.ok) {
    return res.status(502).json({ error: 'upstream ' + upstream.status });
  }

  let json;
  try {
    json = await upstream.json();
  } catch (e) {
    return res.status(502).json({ error: 'bad upstream JSON' });
  }

  const raw = Array.isArray(json.results) ? json.results : [];
  const candles = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (typeof b.t !== 'number') continue;
    const p = etParts(b.t);
    if (p.minuteOfDay < MARKET_OPEN_MIN || p.minuteOfDay >= MARKET_CLOSE_MIN) continue;
    candles.push({
      t: b.t,
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
      minuteOfDay: p.minuteOfDay,
      dateKey: p.dateKey
    });
  }

  const data = {
    ticker: ticker,
    period: period,
    interval: interval,
    intervalMin: multiplier,
    count: candles.length,
    candles: candles,
    source: 'polygon'
  };
  CACHE.set(cacheKey, { at: Date.now(), data: data });
  return res.status(200).json(data);
};
