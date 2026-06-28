/* Vercel serverless: POST /api/ai-strategy
 * --------------------------------------------------------------------
 * Turns a freeform strategy description into structured parameters
 * compatible with BTEngine. Validates against the same grid the
 * optimizer uses so the AI cannot return values the engine does not
 * understand.
 *
 * Body
 *   { description: string }
 *
 * Env
 *   OPENAI_API_KEY  — required. If missing -> 503 { error:'ai-disabled' }
 *   FIREBASE_*      — required for ID-token verification.
 *
 * Response
 *   {
 *     strategy: {
 *       firstHourMin: 15 | 30 | 45 | 60,
 *       trend: 'up' | 'down' | 'either',
 *       dipPct: number | null,
 *       buyOn: 'firstHourClose' | 'dipTrigger',
 *       targetPct: number,
 *       stopPct: number | null,
 *       slippageBps: number,
 *       holdUntil: 'target' | 'eod'
 *     }
 *   }
 *
 * Rate limit: 10 requests / hour / UID.
 * ------------------------------------------------------------------ */

const lib = require('./_lib/auth.js');

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 400;

const ALLOWED = {
  firstHourMin: [15, 30, 45, 60],
  trend:        ['up', 'down', 'either'],
  dipPct:       [null, 1, 1.5, 2, 2.5, 3, 3.5, 4],
  buyOn:        ['firstHourClose', 'dipTrigger'],
  targetPct:    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3],
  stopPct:      [null, 0.5, 1, 1.5, 2, 3, 4],
  slippageBps:  [0, 1, 2, 5, 10],
  holdUntil:    ['target', 'eod']
};

module.exports = async function handler(req, res) {
  if (lib.setCors(req, res)) return;
  if (req.method !== 'POST') return lib.sendJson(res, 405, { error: 'method not allowed' });

  if (!process.env.OPENAI_API_KEY) {
    return lib.sendJson(res, 503, { error: 'ai-disabled', reason: 'OPENAI_API_KEY not configured' });
  }

  let user;
  try { user = await lib.verifyIdToken(req); }
  catch (e) { return lib.sendJson(res, 401, { error: 'not authenticated' }); }

  const rl = lib.rateLimit(user.uid, 'ai-strategy', 10, 60 * 60 * 1000);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return lib.sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter });
  }

  let body;
  try { body = await lib.readJson(req); }
  catch (e) { return lib.sendJson(res, 400, { error: e.message || 'bad body' }); }

  const description = String(body.description || '').slice(0, 1000).trim();
  if (!description) return lib.sendJson(res, 400, { error: 'description required' });

  let openaiResp;
  try {
    openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: description }
        ]
      })
    });
  } catch (e) {
    return lib.sendJson(res, 502, { error: 'upstream fetch failed: ' + (e.message || e) });
  }

  if (!openaiResp.ok) {
    const text = await openaiResp.text();
    return lib.sendJson(res, 502, { error: 'openai error', status: openaiResp.status, detail: text.slice(0, 500) });
  }

  let raw;
  try {
    const data = await openaiResp.json();
    raw = JSON.parse(data.choices[0].message.content);
  } catch (e) {
    return lib.sendJson(res, 502, { error: 'invalid AI response' });
  }

  const strategy = sanitize(raw);
  lib.sendJson(res, 200, { strategy: strategy });
};

const SYSTEM_PROMPT =
  'You translate a freeform stock day-trading strategy description into a STRICT JSON object ' +
  'compatible with the user\'s backtest engine. The engine works as follows: ' +
  '(1) The first N minutes after market open (firstHourMin) define the trend by comparing ' +
  'open vs first-hour close. (2) On up-trend days, the strategy buys at first-hour close. ' +
  '(3) On down-trend days, the strategy waits for price to dip dipPct% below the open and ' +
  'buys at the dip price. (4) Hold until target%, stop% (optional), or EOD. ' +
  'Respond ONLY in JSON with these keys: firstHourMin (15|30|45|60), trend ("up"|"down"|"either"), ' +
  'dipPct (number 1..4 or null), buyOn ("firstHourClose"|"dipTrigger"), targetPct (number 0.25..3), ' +
  'stopPct (number 0.5..4 or null), slippageBps (integer 0..10), holdUntil ("target"|"eod"). ' +
  'Choose the closest reasonable values; do not invent fields. When in doubt prefer ' +
  'firstHourMin=60, trend="either", buyOn="firstHourClose", stopPct=null, slippageBps=2.';

function sanitize(raw) {
  function pick(key, fallback) {
    const allowed = ALLOWED[key];
    const v = raw && raw[key];
    if (v === null && allowed.indexOf(null) !== -1) return null;
    if (typeof v === 'string') {
      if (allowed.indexOf(v) !== -1) return v;
      return fallback;
    }
    if (typeof v === 'number' && allowed.indexOf(v) !== -1) return v;
    // Snap numbers to the closest allowed value.
    if (typeof v === 'number') {
      const numerics = allowed.filter(function (x) { return typeof x === 'number'; });
      if (numerics.length) {
        let best = numerics[0], bestD = Math.abs(v - best);
        numerics.forEach(function (n) { const d = Math.abs(v - n); if (d < bestD) { best = n; bestD = d; } });
        return best;
      }
    }
    return fallback;
  }
  return {
    firstHourMin: pick('firstHourMin', 60),
    trend:        pick('trend', 'either'),
    dipPct:       pick('dipPct', null),
    buyOn:        pick('buyOn', 'firstHourClose'),
    targetPct:    pick('targetPct', 1),
    stopPct:      pick('stopPct', null),
    slippageBps:  pick('slippageBps', 2),
    holdUntil:    pick('holdUntil', 'target')
  };
}
