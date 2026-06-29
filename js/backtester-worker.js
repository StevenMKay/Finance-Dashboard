/* Backtester optimizer worker — Phase D
 * --------------------------------------------------------------------
 * Pulls the pure engine in via importScripts so worker code and main
 * thread share the exact same strategy math. No DOM, no fetch.
 *
 * Messages received:
 *   { cmd: 'run', candlesByTicker: {AMD:[...], ...}, grid: {...},
 *     options: { slippageBps, intervalMin }, jobId }
 *
 * Messages sent:
 *   { type: 'progress', jobId, done, total, ticker, params }
 *   { type: 'done',     jobId, rows: [...] }
 *   { type: 'error',    jobId, message }
 *
 * Cancellation is handled by terminating the worker from the main thread.
 * ------------------------------------------------------------------ */

importScripts('backtester-engine.js');

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.cmd !== 'run') return;

  try {
    runGrid(msg);
  } catch (err) {
    self.postMessage({ type: 'error', jobId: msg.jobId, message: err.message || String(err) });
  }
};

function runGrid(msg) {
  var candlesByTicker = msg.candlesByTicker || {};
  var grid = msg.grid || {};
  var opts = msg.options || {};
  var jobId = msg.jobId;

  var tickers = Object.keys(candlesByTicker);
  var firstHours = grid.firstHour || [60];
  var dips       = grid.dip       || [3];
  var targets    = grid.target    || [0.5];
  var stops      = grid.stop      || [null]; // 'none' must already be mapped to null by the caller

  var total = tickers.length * firstHours.length * dips.length * targets.length * stops.length;
  var done = 0;
  var rows = [];

  // Progress is throttled so we don't flood the main thread with messages.
  var PROGRESS_EVERY = Math.max(1, Math.floor(total / 200));
  var since = 0;

  for (var t = 0; t < tickers.length; t++) {
    var ticker = tickers[t];
    var candles = candlesByTicker[ticker];
    for (var fh = 0; fh < firstHours.length; fh++) {
      for (var d = 0; d < dips.length; d++) {
        for (var g = 0; g < targets.length; g++) {
          for (var s = 0; s < stops.length; s++) {
            var stopPct = stops[s];
            var result = self.BTEngine.runSeries(candles, {
              ticker:         ticker,
              trendWindowMin: firstHours[fh],
              dipPct:         dips[d],
              targetPct:      targets[g],
              stopPct:        stopPct,
              slippageBps:    opts.slippageBps || 0,
              intervalMin:    opts.intervalMin || 5
            });
            var summary = result.summary;
            rows.push({
              ticker:        ticker,
              firstHourMin:  firstHours[fh],
              dipPct:        dips[d],
              targetPct:     targets[g],
              stopPct:       stopPct,
              tradesTaken:   summary.tradesTaken,
              winRate:       summary.winRate,
              totalPL:       summary.totalPL,
              avgPL:         summary.avgPL,
              profitFactor:  summary.profitFactor,
              expectancy:    summary.expectancy,
              maxDrawdown:   summary.maxDrawdown,
              sharpe:        summary.sharpe,
              avgHoldingMin: summary.avgHoldingMin
            });
            done++;
            since++;
            if (since >= PROGRESS_EVERY) {
              since = 0;
              self.postMessage({
                type: 'progress', jobId: jobId,
                done: done, total: total,
                ticker: ticker,
                params: { firstHourMin: firstHours[fh], dipPct: dips[d], targetPct: targets[g], stopPct: stopPct }
              });
            }
          }
        }
      }
    }
  }

  // Final progress tick.
  self.postMessage({ type: 'progress', jobId: jobId, done: total, total: total });
  self.postMessage({ type: 'done', jobId: jobId, rows: rows });
}
