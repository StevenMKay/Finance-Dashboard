/* Vercel serverless function: GET /api/quote?symbols=AAPL,MSFT
 *
 *  Proxies Finnhub /quote so the API key stays server-side.
 *  Light in-memory cache (per warm instance) softens bursty refreshes.
 *
 *  Env vars:
 *    FINNHUB_API_KEY     — required
 *    ALLOWED_ORIGINS     — optional, comma-separated allow-list for CORS
 */

const CACHE = new Map(); // sym -> { at, data }
const TTL_MS = 15 * 1000;
const MAX_SYMBOLS = 25;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  let allowed = '';
  if (!allow.length) {
    // Default: allow same-origin (no Origin header) and localhost during dev.
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

async function fetchOne(symbol, apiKey) {
  const hit = CACHE.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(symbol) +
              '&token=' + encodeURIComponent(apiKey);
  const r = await fetch(url);
  if (!r.ok) {
    return { error: 'upstream ' + r.status };
  }
  const j = await r.json();
  // Finnhub returns 0s for unknown symbols
  const data = {
    c:  Number(j.c)  || 0,
    d:  Number(j.d)  || 0,
    dp: Number(j.dp) || 0,
    h:  Number(j.h)  || 0,
    l:  Number(j.l)  || 0,
    o:  Number(j.o)  || 0,
    pc: Number(j.pc) || 0,
    t:  Number(j.t)  || 0
  };
  CACHE.set(symbol, { at: Date.now(), data });
  return data;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  const raw = String((req.query && req.query.symbols) || '').trim();
  if (!raw) return res.status(400).json({ error: 'missing ?symbols=' });

  const symbols = Array.from(new Set(
    raw.split(',')
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, ''))
      .filter(Boolean)
  )).slice(0, MAX_SYMBOLS);

  if (!symbols.length) return res.status(400).json({ error: 'no valid symbols' });

  const results = await Promise.all(symbols.map(s => fetchOne(s, apiKey).catch(e => ({ error: String(e && e.message || e) }))));

  const out = {};
  symbols.forEach((s, i) => { out[s] = results[i]; });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
