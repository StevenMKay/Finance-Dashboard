/* ============================================================
 * Backtester Experiments — DOM-free library of adjustable
 * intraday strategy patterns. Designed as a *framework*: every
 * pattern is described by metadata + an entry-detection function;
 * all share the same exit simulator (target / stop / EOD) and the
 * same summary stats.
 *
 *  globalThis.BTExperiments = {
 *    LIBRARY:  ExperimentDef[],
 *    byId(id), defaults(id),
 *    run(id, candlesByTicker, settings, opts?) -> { rows, settings },
 *    rankRows(rows), exportCsv(rows, kind),
 *    selfTest() -> { passed, failed, results }
 *  }
 *
 *  ExperimentDef = {
 *    id:        string,
 *    name:      string,
 *    summary:   string,
 *    controls:  Control[],
 *    enter(day, ctx, params) -> { entryBarIdx, entryPrice } | null
 *  }
 *
 *  Control = {
 *    id:     string,
 *    label:  string,
 *    type:   'choice' | 'multiChoice' | 'number' | 'bool',
 *    options?: any[],   // for choice / multiChoice (values, not labels)
 *    suffix?: string,   // 'min', '%' etc — pure cosmetic, the UI reads it
 *    min?, max?, step?, // for number
 *    default: any
 *  }
 *
 *  Candle shape (from /api/bars.js):
 *    { t, o, h, l, c, v, minuteOfDay, dateKey }
 *
 *  Settings (per run, set by the UI):
 *    {
 *      tickers:     string[],     // labels for reporting
 *      slippageBps: number,
 *      params:      { [controlId]: value } // experiment-specific values
 *    }
 *
 *  opts (optional) for run():
 *    { intervalMin: number }      // bar spacing; default 5
 * ============================================================ */

(function (root) {
  'use strict';

  var MARKET_OPEN_MIN  = 9 * 60 + 30; // 9:30 -> 570
  var MARKET_CLOSE_MIN = 16 * 60;     // 16:00 -> 960

  // ----------------------------------------------------------
  // EXPERIMENT LIBRARY
  // ----------------------------------------------------------
  // Common control fragments — reused across experiments to keep
  // the metadata declarative.
  function targetControl(def, opts) {
    return {
      id: 'targetPct', label: 'Profit target', type: 'choice', suffix: '%',
      options: opts || [0.35, 0.5, 0.75, 1, 1.5], default: def == null ? 0.5 : def
    };
  }
  function stopControl(def, opts) {
    return {
      id: 'stopPct', label: 'Stop loss', type: 'choice', suffix: '%',
      // `null` is a valid value here — UI must render it as "none".
      options: opts || [null, 0.5, 1, 1.5, 2],
      default: def === undefined ? 1 : def
    };
  }

  // VWAP across one day. Returns parallel array of VWAP at each bar's close.
  function dayVwap(dayBars) {
    var out = new Array(dayBars.length);
    var tpvSum = 0, volSum = 0;
    for (var i = 0; i < dayBars.length; i++) {
      var b = dayBars[i];
      var typical = (b.h + b.l + b.c) / 3;
      var vol = b.v || 1;       // never divide by zero
      tpvSum += typical * vol;
      volSum += vol;
      out[i] = volSum > 0 ? tpvSum / volSum : typical;
    }
    return out;
  }

  function firstBarAtOrAfter(bars, minuteOfDay) {
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].minuteOfDay >= minuteOfDay) return i;
    }
    return -1;
  }

  var LIBRARY = [
    // 1 — First-window EOD direction test ----------------------
    {
      id: 'firstWindowDirection',
      name: 'First-window EOD direction',
      summary: 'Buy at first-window close if the window closed above its open. Exit at target, stop, or EOD.',
      controls: [
        { id: 'windowMin', label: 'Window minutes', type: 'choice',
          options: [15, 30, 45, 60, 90, 120], suffix: 'min', default: 60 },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [null, 0.5, 1, 1.5, 2])
      ],
      enter: function (day, ctx, p) {
        var windowEnd = MARKET_OPEN_MIN + numOr(p.windowMin, 60);
        var fhBars = [], laterIdx = -1;
        for (var i = 0; i < day.bars.length; i++) {
          if (day.bars[i].minuteOfDay < windowEnd) fhBars.push(day.bars[i]);
          else { laterIdx = i; break; }
        }
        if (fhBars.length === 0 || laterIdx === -1) return null;
        var open = fhBars[0].o;
        var fhc  = fhBars[fhBars.length - 1].c;
        if (!(fhc > open)) return null; // skip flat or down windows
        return { entryBarIdx: laterIdx, entryPrice: fhc };
      }
    },

    // 2 — Opening range breakout -------------------------------
    {
      id: 'openingRangeBreakout',
      name: 'Opening range breakout',
      summary: 'Buy when price breaks above the opening-range high plus a buffer.',
      controls: [
        { id: 'rangeMin', label: 'Opening range', type: 'choice',
          options: [15, 30, 45, 60], suffix: 'min', default: 30 },
        { id: 'bufferPct', label: 'Breakout buffer', type: 'choice', suffix: '%',
          options: [0, 0.1, 0.25, 0.5], default: 0.1 },
        targetControl(0.5, [0.35, 0.5, 0.75, 1, 1.5]),
        stopControl(1, [null, 0.5, 1, 1.5, 2])
      ],
      enter: function (day, ctx, p) {
        var rangeEnd = MARKET_OPEN_MIN + numOr(p.rangeMin, 30);
        var rangeHigh = -Infinity;
        for (var i = 0; i < day.bars.length; i++) {
          if (day.bars[i].minuteOfDay >= rangeEnd) break;
          if (day.bars[i].h > rangeHigh) rangeHigh = day.bars[i].h;
        }
        if (!isFinite(rangeHigh)) return null;
        var trigger = rangeHigh * (1 + numOr(p.bufferPct, 0) / 100);
        for (var j = 0; j < day.bars.length; j++) {
          var b = day.bars[j];
          if (b.minuteOfDay < rangeEnd) continue;
          if (b.h >= trigger) return { entryBarIdx: j, entryPrice: trigger };
        }
        return null;
      }
    },

    // 3 — Gap-down recovery ------------------------------------
    {
      id: 'gapDownRecovery',
      name: 'Gap-down recovery',
      summary: 'Buy when a gap-down day reclaims a chosen reference price.',
      controls: [
        { id: 'gapPct', label: 'Min gap-down', type: 'choice', suffix: '%',
          options: [1, 2, 3, 4, 5], default: 2 },
        { id: 'confirm', label: 'Reclaim', type: 'choice',
          options: ['open', 'vwap', 'firstWindowClose'], default: 'open' },
        { id: 'firstWindowMin', label: 'First-window minutes', type: 'choice',
          options: [15, 30, 45, 60], suffix: 'min', default: 30 },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        if (!ctx.prev) return null;
        var gap = (ctx.prev.close - day.open) / ctx.prev.close * 100;
        if (gap < numOr(p.gapPct, 2)) return null; // not enough gap-down
        var ref;
        if (p.confirm === 'open') ref = function () { return day.open; };
        else if (p.confirm === 'vwap') {
          var vw = dayVwap(day.bars);
          ref = function (i) { return vw[i]; };
        } else {
          // firstWindowClose
          var winEnd = MARKET_OPEN_MIN + numOr(p.firstWindowMin, 30);
          var fhClose = null;
          for (var i = 0; i < day.bars.length; i++) {
            if (day.bars[i].minuteOfDay >= winEnd) break;
            fhClose = day.bars[i].c;
          }
          if (fhClose == null) return null;
          ref = function () { return fhClose; };
        }
        for (var j = 0; j < day.bars.length; j++) {
          var b = day.bars[j];
          var r = ref(j);
          if (r != null && b.h >= r) return { entryBarIdx: j, entryPrice: r };
        }
        return null;
      }
    },

    // 4 — Gap-up continuation ----------------------------------
    {
      id: 'gapUpContinuation',
      name: 'Gap-up continuation',
      summary: 'After a gap-up open, buy if price is still above the open at the end of a confirmation window.',
      controls: [
        { id: 'gapPct', label: 'Min gap-up', type: 'choice', suffix: '%',
          options: [1, 2, 3, 4, 5], default: 2 },
        { id: 'confirmMin', label: 'Confirmation window', type: 'choice',
          options: [15, 30, 60], suffix: 'min', default: 30 },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        if (!ctx.prev) return null;
        var gap = (day.open - ctx.prev.close) / ctx.prev.close * 100;
        if (gap < numOr(p.gapPct, 2)) return null;
        var confirmEnd = MARKET_OPEN_MIN + numOr(p.confirmMin, 30);
        var i = firstBarAtOrAfter(day.bars, confirmEnd);
        if (i === -1) return null;
        var prior = day.bars[i - 1] || day.bars[i];
        if (prior.c < day.open) return null; // not still above open
        return { entryBarIdx: i, entryPrice: day.bars[i].o };
      }
    },

    // 5 — VWAP reclaim -----------------------------------------
    {
      id: 'vwapReclaim',
      name: 'VWAP reclaim',
      summary: 'After price spends time below VWAP by a minimum distance, buy when it crosses back above.',
      controls: [
        { id: 'minBelowPct', label: 'Min distance below VWAP', type: 'choice', suffix: '%',
          options: [0.25, 0.5, 1], default: 0.5 },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        var vw = dayVwap(day.bars);
        var minBelow = numOr(p.minBelowPct, 0.5);
        var wasBelow = false, maxDistBelow = 0;
        for (var i = 0; i < day.bars.length; i++) {
          var b = day.bars[i];
          var v = vw[i];
          if (!isFinite(v) || v <= 0) continue;
          var pctBelow = (v - b.c) / v * 100;
          if (pctBelow > maxDistBelow) maxDistBelow = pctBelow;
          if (pctBelow >= minBelow) wasBelow = true;
          // Reclaim = was below by >= threshold, now the bar's high crosses back above VWAP.
          if (wasBelow && b.h >= v) {
            return { entryBarIdx: i, entryPrice: v };
          }
        }
        return null;
      }
    },

    // 6 — Red-to-green move ------------------------------------
    {
      id: 'redToGreen',
      name: 'Red-to-green move',
      summary: 'Day opens below previous close by a minimum amount; buy when price crosses back above the day open.',
      controls: [
        { id: 'minRedPct', label: 'Min open-red vs prev close', type: 'choice', suffix: '%',
          options: [0, 0.5, 1, 2], default: 0 },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        if (!ctx.prev) return null;
        var redPct = (ctx.prev.close - day.open) / ctx.prev.close * 100;
        if (redPct < numOr(p.minRedPct, 0)) return null;
        for (var i = 0; i < day.bars.length; i++) {
          var b = day.bars[i];
          if (b.l <= day.open && b.h >= day.open) {
            // First bar that crosses the open from below.
            if (b.c >= day.open || b.o < day.open) {
              return { entryBarIdx: i, entryPrice: day.open };
            }
          }
        }
        return null;
      }
    },

    // 7 — Previous day high breakout ---------------------------
    {
      id: 'prevDayHighBreakout',
      name: 'Previous day high breakout',
      summary: 'Buy when today breaks above the previous trading day high plus a buffer.',
      controls: [
        { id: 'bufferPct', label: 'Breakout buffer', type: 'choice', suffix: '%',
          options: [0, 0.1, 0.25, 0.5], default: 0.1 },
        targetControl(0.5, [0.35, 0.5, 1, 1.5]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        if (!ctx.prev) return null;
        var trigger = ctx.prev.high * (1 + numOr(p.bufferPct, 0) / 100);
        for (var i = 0; i < day.bars.length; i++) {
          if (day.bars[i].h >= trigger) {
            return { entryBarIdx: i, entryPrice: trigger };
          }
        }
        return null;
      }
    },

    // 8 — Previous day low bounce ------------------------------
    {
      id: 'prevDayLowBounce',
      name: 'Previous day low bounce',
      summary: 'Price breaks below previous-day low, then bounces back through a reclaim reference.',
      controls: [
        { id: 'breakPct', label: 'Break below prev low', type: 'choice', suffix: '%',
          options: [0, 0.25, 0.5, 1], default: 0 },
        { id: 'reclaim', label: 'Reclaim', type: 'choice',
          options: ['prevLow', 'open', 'vwap'], default: 'prevLow' },
        targetControl(0.5, [0.35, 0.5, 1]),
        stopControl(1, [0.5, 1, 2])
      ],
      enter: function (day, ctx, p) {
        if (!ctx.prev) return null;
        var breakLevel = ctx.prev.low * (1 - numOr(p.breakPct, 0) / 100);
        var saw = false;
        var vw = (p.reclaim === 'vwap') ? dayVwap(day.bars) : null;
        for (var i = 0; i < day.bars.length; i++) {
          var b = day.bars[i];
          if (!saw && b.l <= breakLevel) saw = true;
          if (!saw) continue;
          var ref;
          if (p.reclaim === 'open') ref = day.open;
          else if (p.reclaim === 'vwap') ref = vw[i];
          else ref = ctx.prev.low;
          if (ref != null && b.h >= ref) {
            return { entryBarIdx: i, entryPrice: ref };
          }
        }
        return null;
      }
    },

    // 9 — Extreme intraday drop bounce -------------------------
    {
      id: 'extremeDropBounce',
      name: 'Extreme intraday drop bounce',
      summary: 'Buy after price drops a chosen amount from the day open; exit at target, stop, or EOD.',
      controls: [
        { id: 'dropPct', label: 'Drop from open', type: 'choice', suffix: '%',
          options: [2, 2.5, 3, 3.5, 4, 5], default: 3 },
        targetControl(0.5, [0.35, 0.5, 0.75, 1]),
        stopControl(1, [null, 0.5, 1, 1.5, 2])
      ],
      enter: function (day, ctx, p) {
        var trigger = day.open * (1 - numOr(p.dropPct, 3) / 100);
        for (var i = 0; i < day.bars.length; i++) {
          if (day.bars[i].l <= trigger) {
            return { entryBarIdx: i, entryPrice: trigger };
          }
        }
        return null;
      }
    },

    // 10 — End-of-day momentum ---------------------------------
    {
      id: 'eodMomentum',
      name: 'End-of-day momentum',
      summary: 'Late-session buy when price is above VWAP and close to the day high.',
      controls: [
        { id: 'startTime', label: 'Earliest entry time', type: 'choice',
          options: ['14:00', '14:30', '15:00'], default: '14:30' },
        { id: 'requireAboveVwap', label: 'Require above VWAP', type: 'bool', default: true },
        { id: 'nearHighPct', label: 'Max distance from day high', type: 'choice', suffix: '%',
          options: [0.25, 0.5, 1], default: 0.5 },
        targetControl(0.35, [0.25, 0.35, 0.5]),
        stopControl(0.5, [0.25, 0.5, 1])
      ],
      enter: function (day, ctx, p) {
        var parts = String(p.startTime || '14:30').split(':');
        var startMin = (Number(parts[0]) || 14) * 60 + (Number(parts[1]) || 0);
        var iStart = firstBarAtOrAfter(day.bars, startMin);
        if (iStart === -1) return null;

        // Build running day-high up to each bar so "near day high" is causal.
        var vw = dayVwap(day.bars);
        var runningHigh = -Infinity;
        var nearPct = numOr(p.nearHighPct, 0.5);
        for (var i = 0; i < day.bars.length; i++) {
          if (day.bars[i].h > runningHigh) runningHigh = day.bars[i].h;
          if (i < iStart) continue;
          var b = day.bars[i];
          if (p.requireAboveVwap && !(b.c > vw[i])) continue;
          var dist = (runningHigh - b.c) / runningHigh * 100;
          if (dist <= nearPct) {
            return { entryBarIdx: i, entryPrice: b.c };
          }
        }
        return null;
      }
    }
  ];

  function byId(id) {
    for (var i = 0; i < LIBRARY.length; i++) if (LIBRARY[i].id === id) return LIBRARY[i];
    return null;
  }
  function defaults(id) {
    var e = byId(id); if (!e) return null;
    var out = {};
    for (var i = 0; i < e.controls.length; i++) out[e.controls[i].id] = e.controls[i].default;
    return out;
  }

  // ----------------------------------------------------------
  // RUNNER
  // ----------------------------------------------------------
  // Runs ONE experiment for every ticker. Returns one row per
  // (experiment, ticker) so the leaderboard can rank across runs.
  function run(experimentId, candlesByTicker, settings, opts) {
    var expt = byId(experimentId);
    if (!expt) return { rows: [], settings: settings || {}, error: 'unknown experiment: ' + experimentId };

    settings = settings || {};
    opts = opts || {};
    var intervalMin = numOr(opts.intervalMin, 5);
    var slippageBps = numOr(settings.slippageBps, 0);
    var params = settings.params || defaults(experimentId);
    var targetPct = numOr(params.targetPct, 0.5);
    var stopPct   = (params.stopPct == null || params.stopPct === '') ? null : Number(params.stopPct);

    var tickers = settings.tickers && settings.tickers.length
      ? settings.tickers
      : Object.keys(candlesByTicker || {});

    var rows = [];
    tickers.forEach(function (tk) {
      var candles = candlesByTicker[tk];
      if (!Array.isArray(candles) || candles.length === 0) {
        rows.push(emptyRow(expt, tk, params, slippageBps, 'no candles'));
        return;
      }
      var byDay = groupByDay(candles);
      var dayKeys = Object.keys(byDay).sort();
      var trades = [];
      var noTradeDays = 0;
      var prev = null;

      for (var d = 0; d < dayKeys.length; d++) {
        var bars = byDay[dayKeys[d]];
        if (!bars.length) continue;
        var dayObj = {
          dateKey: dayKeys[d],
          bars: bars,
          open: bars[0].o,
          high: maxBy(bars, 'h'),
          low: minBy(bars, 'l'),
          close: bars[bars.length - 1].c
        };
        var ctx = { prev: prev, dayIndex: d };

        var entry = expt.enter(dayObj, ctx, params);
        if (!entry) {
          noTradeDays++;
        } else {
          var trade = simulateExit(dayObj, entry, targetPct, stopPct, slippageBps, intervalMin, tk);
          trades.push(trade);
        }
        prev = { open: dayObj.open, high: dayObj.high, low: dayObj.low, close: dayObj.close };
      }

      rows.push(summarize(expt, tk, params, slippageBps, dayKeys.length, noTradeDays, trades));
    });

    return { rows: rows, settings: settings, experimentId: experimentId };
  }

  // ----------------------------------------------------------
  // EXIT SIMULATOR
  // ----------------------------------------------------------
  function simulateExit(day, entry, targetPct, stopPct, slippageBps, intervalMin, ticker) {
    var laterBars = day.bars.slice(entry.entryBarIdx);
    var raw    = entry.entryPrice;
    var target = raw * (1 + targetPct / 100);
    var stop   = (stopPct != null) ? raw * (1 - stopPct / 100) : null;

    var exitIdx = -1, hitTarget = false, hitStop = false;
    var rawSell = null;
    var mfe = 0, mae = 0;

    for (var i = 0; i < laterBars.length; i++) {
      var b = laterBars[i];
      // mark-to-market
      var hi = (b.h - raw) / raw * 100;
      var lo = (b.l - raw) / raw * 100;
      if (hi > mfe) mfe = hi;
      // Don't penalize MAE on the entry bar if the entry price came
      // from this bar's low (downside-triggered patterns).
      if (!(i === 0 && b.l <= raw && b.o >= raw) && lo < mae) mae = lo;

      // Tie-break: stop wins when a single bar straddles both levels.
      var stopThisBar   = (stop != null) && (b.l <= stop) && !(i === 0 && b.l <= raw && b.o >= raw);
      var targetThisBar = (b.h >= target);

      if (stopThisBar)   { hitStop = true;   rawSell = stop;   exitIdx = i; break; }
      if (targetThisBar) { hitTarget = true; rawSell = target; exitIdx = i; break; }
    }

    var exitReason;
    if (exitIdx === -1) {
      rawSell = laterBars[laterBars.length - 1].c;
      exitIdx = laterBars.length - 1;
      exitReason = 'eod';
    } else {
      exitReason = hitStop ? 'stop' : 'target';
    }

    var bps = slippageBps / 10000;
    var effBuy  = raw     * (1 + bps);
    var effSell = rawSell * (1 - bps);

    return {
      ticker: ticker,
      date: day.dateKey,
      entryBar: entry.entryBarIdx,
      entryTime: day.bars[entry.entryBarIdx].t,
      exitTime: laterBars[exitIdx].t,
      rawBuyPrice: round4(raw),
      rawSellPrice: round4(rawSell),
      buyPrice: round4(effBuy),
      sellPrice: round4(effSell),
      profitPct: (effSell - effBuy) / effBuy * 100,
      targetHit: hitTarget,
      stopHit: hitStop,
      exitReason: exitReason,
      holdingBars: exitIdx + 1,
      holdingMinutes: (exitIdx + 1) * intervalMin,
      mfePct: round4(mfe),
      maePct: round4(mae)
    };
  }

  // ----------------------------------------------------------
  // SUMMARY  (one row per ticker per experiment)
  // ----------------------------------------------------------
  function summarize(expt, ticker, params, slippageBps, totalDays, noTradeDays, trades) {
    var wins   = trades.filter(function (t) { return t.profitPct > 0; });
    var losses = trades.filter(function (t) { return t.profitPct <= 0; });

    var sumWins  = sum(wins.map(function (t) { return t.profitPct; }));
    var sumLoss  = sum(losses.map(function (t) { return Math.abs(t.profitPct); }));
    var totalPL  = sum(trades.map(function (t) { return t.profitPct; }));
    var avgWin   = wins.length   ? sumWins / wins.length : 0;
    var avgLoss  = losses.length ? sumLoss / losses.length : 0;
    var winRate  = trades.length ? wins.length / trades.length : 0;
    var profitFactor = sumLoss > 0 ? sumWins / sumLoss : (sumWins > 0 ? Infinity : 0);
    var lossRate = 1 - winRate;
    var expectancy = winRate * avgWin - lossRate * avgLoss;

    var worstLoss = trades.reduce(function (m, t) {
      return (m == null || t.profitPct < m) ? t.profitPct : m;
    }, null);

    // Drawdown on cumulative trade-return path.
    var cum = 0, peak = 0, maxDD = 0;
    for (var i = 0; i < trades.length; i++) {
      cum += trades[i].profitPct;
      if (cum > peak) peak = cum;
      var dd = cum - peak;
      if (dd < maxDD) maxDD = dd;
    }

    var avgHold = trades.length ? sum(trades.map(function (t) { return t.holdingMinutes; })) / trades.length : 0;

    return {
      experimentId:  expt.id,
      experimentName: expt.name,
      ticker:        ticker,
      params:        cloneParams(params),
      slippageBps:   slippageBps,
      totalDays:     totalDays,
      tradesTaken:   trades.length,
      noTradeDays:   noTradeDays,
      wins:          wins.length,
      losses:        losses.length,
      winRate:       winRate * 100,
      avgWin:        avgWin,
      avgLoss:       avgLoss,
      worstLoss:     worstLoss == null ? 0 : worstLoss,
      expectancy:    expectancy,
      profitFactor:  profitFactor,
      totalPL:       totalPL,
      maxDrawdown:   maxDD,
      avgHoldingMin: avgHold,
      smallSample:   trades.length < 30,
      trades:        trades
    };
  }

  function emptyRow(expt, ticker, params, slippageBps, note) {
    return {
      experimentId: expt.id, experimentName: expt.name, ticker: ticker,
      params: cloneParams(params), slippageBps: slippageBps,
      totalDays: 0, tradesTaken: 0, noTradeDays: 0,
      wins: 0, losses: 0, winRate: 0,
      avgWin: 0, avgLoss: 0, worstLoss: 0,
      expectancy: 0, profitFactor: 0, totalPL: 0,
      maxDrawdown: 0, avgHoldingMin: 0,
      smallSample: true, trades: [], note: note || null
    };
  }

  // ----------------------------------------------------------
  // RANKING — expectancy first, then totalPL, then (less DD).
  // ----------------------------------------------------------
  function rankRows(rows) {
    return rows.slice().sort(function (a, b) {
      if (b.expectancy !== a.expectancy) return b.expectancy - a.expectancy;
      if (b.totalPL    !== a.totalPL)    return b.totalPL - a.totalPL;
      return b.maxDrawdown - a.maxDrawdown; // both negative; less negative wins
    });
  }

  // ----------------------------------------------------------
  // CSV EXPORTS
  // ----------------------------------------------------------
  function csvEscape(v) {
    if (v == null) return '';
    var s = String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  function exportCsv(rows, kind) {
    if (kind === 'trades') {
      var header = ['experiment','ticker','date','entryTime','exitTime',
        'rawBuyPrice','rawSellPrice','buyPrice','sellPrice','profitPct',
        'exitReason','holdingMinutes','mfePct','maePct'];
      var lines = [header.join(',')];
      rows.forEach(function (r) {
        (r.trades || []).forEach(function (t) {
          lines.push([
            r.experimentName, r.ticker, t.date,
            new Date(t.entryTime).toISOString(),
            new Date(t.exitTime).toISOString(),
            t.rawBuyPrice, t.rawSellPrice, t.buyPrice, t.sellPrice,
            t.profitPct.toFixed(4),
            t.exitReason, t.holdingMinutes, t.mfePct, t.maePct
          ].map(csvEscape).join(','));
        });
      });
      return lines.join('\n');
    }
    // leaderboard
    var head = ['rank','experiment','ticker','settings','trades','winRate%',
      'expectancy%','totalPL%','maxDD%','profitFactor','avgHoldMin','sampleWarning'];
    var lines = [head.join(',')];
    rankRows(rows).forEach(function (r, i) {
      lines.push([
        i + 1, r.experimentName, r.ticker,
        formatParams(r.params), r.tradesTaken,
        r.winRate.toFixed(2), r.expectancy.toFixed(4),
        r.totalPL.toFixed(2), r.maxDrawdown.toFixed(2),
        isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf',
        r.avgHoldingMin.toFixed(1),
        r.smallSample ? 'YES (<30)' : ''
      ].map(csvEscape).join(','));
    });
    return lines.join('\n');
  }
  function formatParams(p) {
    if (!p) return '';
    return Object.keys(p).map(function (k) {
      return k + '=' + (p[k] == null ? 'none' : p[k]);
    }).join(' ');
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------
  function numOr(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += (+a[i] || 0); return s; }
  function round4(n) { return Math.round(n * 10000) / 10000; }
  function maxBy(bars, key) {
    var m = -Infinity; for (var i = 0; i < bars.length; i++) if (bars[i][key] > m) m = bars[i][key];
    return m;
  }
  function minBy(bars, key) {
    var m =  Infinity; for (var i = 0; i < bars.length; i++) if (bars[i][key] < m) m = bars[i][key];
    return m;
  }
  function cloneParams(p) { return p ? JSON.parse(JSON.stringify(p)) : {}; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function groupByDay(candles) {
    var stamped = stampBars(candles);
    var by = {};
    for (var i = 0; i < stamped.length; i++) {
      var c = stamped[i];
      if (!by[c.dateKey]) by[c.dateKey] = [];
      by[c.dateKey].push(c);
    }
    Object.keys(by).forEach(function (k) {
      by[k] = by[k].filter(function (b) {
        return b.minuteOfDay >= MARKET_OPEN_MIN && b.minuteOfDay < MARKET_CLOSE_MIN;
      });
      by[k].sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });
    });
    return by;
  }
  function stampBars(candles) {
    var out = new Array(candles.length);
    for (var i = 0; i < candles.length; i++) {
      var b = candles[i];
      if (b.minuteOfDay != null && b.dateKey) { out[i] = b; continue; }
      var d = new Date(b.t);
      var mod = (b.minuteOfDay != null) ? b.minuteOfDay : (d.getUTCHours() * 60 + d.getUTCMinutes());
      var dk  = b.dateKey || (
        d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
      );
      out[i] = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, minuteOfDay: mod, dateKey: dk };
    }
    return out;
  }

  // ----------------------------------------------------------
  // SELF-TEST
  // ----------------------------------------------------------
  function selfTest() {
    var results = [];
    function check(name, fn) {
      try { var d = fn(); results.push({ name: name, ok: true, detail: d || 'ok' }); }
      catch (e) { results.push({ name: name, ok: false, detail: e.message || String(e) }); }
    }
    function assert(c, m) { if (!c) throw new Error(m); }

    function buildDay(date, shape) {
      var bars = [];
      for (var m = MARKET_OPEN_MIN; m < MARKET_CLOSE_MIN; m += 5) {
        var o = shape(m);
        bars.push({
          t: Date.parse(date + 'T00:00:00Z') + m * 60000,
          o: o.o, h: o.h, l: o.l, c: o.c, v: o.v || 100,
          minuteOfDay: m, dateKey: date
        });
      }
      return bars;
    }

    // 1. Empty candles -> empty row with note.
    check('empty candles -> empty row', function () {
      var r = run('firstWindowDirection', { TEST: [] }, { tickers: ['TEST'] });
      assert(r.rows.length === 1, 'one row');
      assert(r.rows[0].tradesTaken === 0, 'zero trades');
      assert(r.rows[0].note === 'no candles', 'note set');
    });

    // 2. Unknown experiment -> error result.
    check('unknown experiment id -> error', function () {
      var r = run('nope', { TEST: buildDay('2026-01-05', function () { return { o: 100, h: 100, l: 100, c: 100 }; }) }, {});
      assert(!!r.error, 'error reported');
    });

    // 3. ORB triggers + hits target.
    check('opening-range breakout fires and hits target', function () {
      var bars = buildDay('2026-01-06', function (m) {
        if (m < MARKET_OPEN_MIN + 30) return { o: 100, h: 100.5, l: 99.8, c: 100 };
        if (m === 11 * 60)            return { o: 100, h: 101.2, l: 100, c: 100.6 };
        return { o: 100, h: 100.1, l: 99.9, c: 100 };
      });
      var r = run('openingRangeBreakout', { T: bars }, {
        tickers: ['T'], params: { rangeMin: 30, bufferPct: 0, targetPct: 0.5, stopPct: 1 }
      });
      var row = r.rows[0];
      assert(row.tradesTaken === 1, 'one trade');
      assert(row.trades[0].exitReason === 'target', 'exited at target, got ' + row.trades[0].exitReason);
    });

    // 4. Stop+target same bar -> stop wins (conservative).
    check('stop+target collision: stop wins', function () {
      var bars = buildDay('2026-01-07', function (m) {
        if (m < MARKET_OPEN_MIN + 30) return { o: 100, h: 100.5, l: 99.8, c: 100 };
        if (m === 11 * 60)            return { o: 100, h: 102, l: 98, c: 100 };
        return { o: 100, h: 100.1, l: 99.9, c: 100 };
      });
      var r = run('openingRangeBreakout', { T: bars }, {
        tickers: ['T'], params: { rangeMin: 30, bufferPct: 0, targetPct: 0.5, stopPct: 1 }
      });
      assert(r.rows[0].trades[0].exitReason === 'stop', 'stop should win tie');
    });

    // 5. Prev-day experiments skip day 0 (no prev context).
    check('prevDayHighBreakout skips first day', function () {
      var d1 = buildDay('2026-01-08', function () { return { o: 100, h: 101, l: 99, c: 100.5, v: 100 }; });
      var d2 = buildDay('2026-01-09', function (m) {
        if (m === 11 * 60) return { o: 100, h: 102, l: 100, c: 101.5 };
        return { o: 100, h: 100.1, l: 99.9, c: 100 };
      });
      var r = run('prevDayHighBreakout', { T: d1.concat(d2) }, {
        tickers: ['T'], params: { bufferPct: 0, targetPct: 0.5, stopPct: 1 }
      });
      assert(r.rows[0].tradesTaken === 1, 'one trade on day 2 only, got ' + r.rows[0].tradesTaken);
    });

    // 6. VWAP doesn't crash with zero volume.
    check('VWAP handles zero volume safely', function () {
      var bars = buildDay('2026-01-10', function () { return { o: 100, h: 100.1, l: 99.9, c: 100, v: 0 }; });
      var vw = dayVwap(bars);
      assert(vw.every(function (v) { return isFinite(v) && v > 0; }), 'all VWAP values finite');
    });

    // 7. Ranking sorts by expectancy then totalPL.
    check('rankRows: expectancy first, totalPL tiebreak', function () {
      var ranked = rankRows([
        { expectancy: 0.1, totalPL: 5, maxDrawdown: -2 },
        { expectancy: 0.3, totalPL: 1, maxDrawdown: -1 },
        { expectancy: 0.3, totalPL: 4, maxDrawdown: -3 }
      ]);
      assert(ranked[0].expectancy === 0.3 && ranked[0].totalPL === 4, 'top row');
      assert(ranked[2].expectancy === 0.1, 'last row');
    });

    // 8. Small-sample flag set when trades < 30.
    check('smallSample warning when trades < 30', function () {
      var bars = buildDay('2026-01-11', function () { return { o: 100, h: 100.6, l: 99.9, c: 100.5 }; });
      var r = run('firstWindowDirection', { T: bars }, {
        tickers: ['T'], params: { windowMin: 60, targetPct: 0.5, stopPct: 1 }
      });
      assert(r.rows[0].smallSample === true, 'smallSample flag');
    });

    // 9. CSV exports include header + at least one data row.
    check('CSV leaderboard export has header + row', function () {
      var rows = [{
        experimentId: 'x', experimentName: 'X', ticker: 'T',
        params: { a: 1 }, tradesTaken: 5, winRate: 50,
        expectancy: 0.2, totalPL: 1, maxDrawdown: -0.5,
        profitFactor: 2, avgHoldingMin: 30, smallSample: true
      }];
      var csv = exportCsv(rows, 'leaderboard');
      var lines = csv.split('\n');
      assert(lines.length >= 2 && lines[0].indexOf('rank') === 0, 'header present');
    });

    var passed = results.filter(function (r) { return r.ok; }).length;
    var failed = results.length - passed;
    return { passed: passed, failed: failed, results: results };
  }

  root.BTExperiments = {
    LIBRARY: LIBRARY,
    byId: byId,
    defaults: defaults,
    run: run,
    rankRows: rankRows,
    exportCsv: exportCsv,
    selfTest: selfTest,
    // expose for tests
    _dayVwap: dayVwap
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
