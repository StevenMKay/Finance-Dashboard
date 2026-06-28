/* Vercel serverless: POST /api/ai-recommend
 * --------------------------------------------------------------------
 * Summarizes the user's optimizer results and asks OpenAI for a
 * recommendation (which ticker × params look most reliable, which to
 * avoid, what risks to watch). Returns strict JSON.
 *
 * Body
 *   {
 *     tickers: string[],
 *     slippageBps: number,
 *     topStrategies: { [ticker]: row },
 *     sampleRows?: row[]                  // up to 50 optimizer rows
 *   }
 *
 * Env
 *   OPENAI_API_KEY  — required. If missing -> 503 { error:'ai-disabled' }
 *   FIREBASE_*      — required for ID-token verification.
 *
 * Response
 *   { headline: string, bullets: string[] }
 *
 * Rate limit: 20 requests / hour / UID.
 * ------------------------------------------------------------------ */

const lib = require('./_lib/auth.js');

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 600;
const MAX_BULLETS = 8;

module.exports = async function handler(req, res) {
  if (lib.setCors(req, res)) return;
  if (req.method !== 'POST') return lib.sendJson(res, 405, { error: 'method not allowed' });

  if (!process.env.OPENAI_API_KEY) {
    return lib.sendJson(res, 503, { error: 'ai-disabled', reason: 'OPENAI_API_KEY not configured' });
  }

  let user;
  try { user = await lib.verifyIdToken(req); }
  catch (e) { return lib.sendJson(res, 401, { error: 'not authenticated' }); }

  const rl = lib.rateLimit(user.uid, 'ai-recommend', 20, 60 * 60 * 1000);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return lib.sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter });
  }

  let body;
  try { body = await lib.readJson(req); }
  catch (e) { return lib.sendJson(res, 400, { error: e.message || 'bad body' }); }

  const tickers       = Array.isArray(body.tickers) ? body.tickers.slice(0, 20).map(String) : [];
  const slippageBps   = Number(body.slippageBps) || 0;
  const topStrategies = body.topStrategies && typeof body.topStrategies === 'object' ? body.topStrategies : {};
  const sampleRows    = Array.isArray(body.sampleRows) ? body.sampleRows.slice(0, 50) : [];

  const prompt = buildPrompt({ tickers, slippageBps, topStrategies, sampleRows });

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
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt }
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

  let parsed;
  try {
    const data = await openaiResp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    parsed = JSON.parse(content);
  } catch (e) {
    return lib.sendJson(res, 502, { error: 'invalid AI response' });
  }

  const headline = String(parsed.headline || '').slice(0, 200);
  const bullets  = Array.isArray(parsed.bullets)
    ? parsed.bullets.slice(0, MAX_BULLETS).map(function (b) { return String(b).slice(0, 280); })
    : [];

  lib.sendJson(res, 200, { headline: headline, bullets: bullets });
};

const SYSTEM_PROMPT =
  'You are a careful trading research assistant. You analyze pre-computed backtest results — ' +
  'you do NOT generate predictions or financial advice. Be specific about which parameter ' +
  'combinations look most reliable based on the supplied stats (win rate, total P/L, profit ' +
  'factor, max drawdown, sample size). Call out small-sample warnings when trade counts are low. ' +
  'Respond ONLY in JSON with keys: "headline" (one sentence) and "bullets" (array of 4-8 short ' +
  'strings, each one observation or caution). Never invent numbers.';

function buildPrompt(p) {
  const lines = [];
  lines.push('Slippage modeled: ' + p.slippageBps + ' bps each side.');
  lines.push('Tickers analyzed: ' + p.tickers.join(', '));
  lines.push('');
  lines.push('Best parameters per ticker (by total P/L):');
  Object.keys(p.topStrategies).forEach(function (tk) {
    const r = p.topStrategies[tk];
    lines.push('  - ' + tk + ': firstHour=' + r.firstHourMin + 'm  dip=' + r.dipPct +
      '%  target=' + r.targetPct + '%  stop=' + (r.stopPct == null ? 'none' : r.stopPct + '%') +
      '  trades=' + r.tradesTaken + '  winRate=' + (r.winRate || 0).toFixed(1) +
      '%  totalPL=' + (r.totalPL || 0).toFixed(2) + '%  PF=' +
      (isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf') +
      '  maxDD=' + (r.maxDrawdown || 0).toFixed(2) + '%');
  });
  if (p.sampleRows.length) {
    lines.push('');
    lines.push('Additional sample of optimizer rows:');
    p.sampleRows.slice(0, 30).forEach(function (r) {
      lines.push('  ' + r.ticker + ' 1h=' + r.firstHourMin + ' dip=' + r.dipPct + ' tgt=' + r.targetPct +
        ' stop=' + (r.stopPct == null ? 'none' : r.stopPct) + ' n=' + r.tradesTaken +
        ' WR=' + (r.winRate || 0).toFixed(1) + '% tPL=' + (r.totalPL || 0).toFixed(2) +
        '% PF=' + (isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf') +
        ' DD=' + (r.maxDrawdown || 0).toFixed(2) + '%');
    });
  }
  return lines.join('\n');
}
