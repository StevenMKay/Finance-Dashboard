/* Timeframe Accuracy Report — Experiments Tab
 * --------------------------------------------------------------------
 * For every ticker loaded by the Engine tab AND every first-window size
 * the user wants to test (15, 30, 45, 60, 90, 120 minutes by default),
 * computes how well the window's direction predicts the rest of the day
 * AND how strong the corresponding strategy is by expectancy.
 *
 * Why this is needed:
 *   The Signal Quality tab answers "how good is the first 60 minutes?".
 *   But maybe the first 30 minutes is a sharper signal — or the first
 *   120 minutes is more reliable. This report sweeps every window so
 *   you can see which timeframe is actually best per ticker.
 *
 * Public:
 *   BTTimeframeAccuracy.analyze(candlesByTicker, opts) ->
 *     {
 *       rows:        [...row per (ticker, timeframe)...],
 *       bestByTicker:{ ticker -> bestRow },  // ranked by expectancy
 *       settings
 *     }
 *   BTTimeframeAccuracy.selfTest() -> { passed, failed, results }
 *
 * Row shape:
 *   {
 *     ticker, timeframe,
 *     totalDays, greenDays, redDays, flatDays,
 *     eodAccuracy,                    // green→up + red→down / signals
 *     signalsTaken,                   // green days + red-dip days
 *     hits035, hits05, hits1,         // hit-rates (0..1) for unified +X% strategy
 *     avgReturn, medianReturn,        // post-window return (window close -> EOD)
 *     totalReturn,                    // sum of post-window returns (always-in proxy)
 *     falseSignalRate,                // signals that failed smallest target
 *     bestTarget, bestExpectancy      // best target by signed avg P/L sweep
 *   }
 *
 * NOTE: this module is intentionally self-contained — it doesn't import
 *       BTSignalQuality so the two can evolve independently and the
 *       experiments tab keeps working even if Signal Quality is changed.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var MARKET_OPEN_MIN  = 9 * 60 + 30;
  var MARKET_CLOSE_MIN = 16 * 60;

  var DEFAULT_TIMEFRAMES = [15, 30, 45, 60, 90, 120];
  var DEFAULT_TARGET_SWEEP = [0.35, 0.5, 0.75, 1, 1.5, 2, 3];
  var DEFAULT_DIP_PCT = 3;
  var DEFAULT_HIT_TARGETS = [0.35, 0.5, 1];

  function analyze(candlesByTicker, opts) {
    opts = opts || {};
    var settings = {
      timeframes:   (opts.timeframes && opts.timeframes.length) ? opts.timeframes.slice() : DEFAULT_TIMEFRAMES.slice(),
      dipPct:       isFinite(opts.dipPct) && opts.dipPct > 0 ? Number(opts.dipPct) : DEFAULT_DIP_PCT,
      hitTargets:   (opts.hitTargets && opts.hitTargets.length) ? opts.hitTargets.slice() : DEFAULT_HIT_TARGETS.slice(),
      targetSweep:  (opts.targetSweep && opts.targetSweep.length) ? opts.targetSweep.slice() : DEFAULT_TARGET_SWEEP.slice()
    };

    var rows = [];
    var bestByTicker = {};

    Object.keys(candlesByTicker || {}).forEach(function (tk) {
      var candles = candlesByTicker[tk] || [];
      if (!candles.length) return;
      var dayGroups = groupByDay(candles);

      // Pre-sort each day's bars once so every timeframe iteration is fast.
      var dayKeys = Object.keys(dayGroups).sort();
      var preparedDays = dayKeys.map(function (k) {
        return prepareDay(dayGroups[k]);
      }).filter(function (d) { return d && d.length > 0; });

      var bestRowForTicker = null;
      settings.timeframes.forEach(function (tf) {
        var row = scoreTimeframe(tk, tf, preparedDays, settings);
        if (!row) return;
        rows.push(row);
        if (!bestRowForTicker ||
            row.bestExpectancy > bestRowForTicker.bestExpectancy ||
            (row.bestExpectancy === bestRowForTicker.bestExpectancy && row.totalReturn > bestRowForTicker.totalReturn)) {
          bestRowForTicker = row;
        }
      });
      if (bestRowForTicker) bestByTicker[tk] = bestRowForTicker;
    });

    return { rows: rows, bestByTicker: bestByTicker, settings: settings };
  }

  // -------------------------------------------------------------------
  // Day prep — sort bars + filter to RTH once
  // -------------------------------------------------------------------
  function prepareDay(rawBars) {
    if (!rawBars || !rawBars.length) return null;
    var bars = [];
    for (var i = 0; i < rawBars.length; i++) {
      var b = rawBars[i];
      if (!b || typeof b.minuteOfDay !== 'number') continue;
      if (b.minuteOfDay < MARKET_OPEN_MIN || b.minuteOfDay >= MARKET_CLOSE_MIN) continue;
      bars.push(b);
    }
    bars.sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });
    return bars;
  }

  // -------------------------------------------------------------------
  // Per-day record at a given window size
  // -------------------------------------------------------------------
  function analyzeDay(dayBars, timeframe, dipPct) {
    if (!dayBars || dayBars.length === 0) return null;
    var windowEnd = MARKET_OPEN_MIN + timeframe;
    var windowBars = [], laterBars = [];
    for (var i = 0; i < dayBars.length; i++) {
      if (dayBars[i].minuteOfDay < windowEnd) windowBars.push(dayBars[i]);
      else                                    laterBars.push(dayBars[i]);
    }
    if (!windowBars.length || !laterBars.length) return null;

    var openPrice   = windowBars[0].o;
    var windowClose = windowBars[windowBars.length - 1].c;
    var dayClose    = laterBars[laterBars.length - 1].c;

    var trend = windowClose > openPrice ? 'green'
              : windowClose < openPrice ? 'red'
              : 'flat';

    // Post-window stats — max upside relative to windowClose (green strategy)
    // and dip detection / recovery for the red branch.
    var postMaxHigh = -Infinity, postMinLow = Infinity;
    for (var k = 0; k < laterBars.length; k++) {
      if (laterBars[k].h > postMaxHigh) postMaxHigh = laterBars[k].h;
      if (laterBars[k].l < postMinLow)  postMinLow  = laterBars[k].l;
    }
    var greenMaxReturn   = ((postMaxHigh - windowClose) / windowClose) * 100;
    var postWindowReturn = ((dayClose    - windowClose) / windowClose) * 100;

    var dipTrigger = openPrice * (1 - dipPct / 100);
    var dipHit = false, dipIdx = -1, dipPrice = null;
    if (trend === 'red') {
      for (var d = 0; d < laterBars.length; d++) {
        if (laterBars[d].l <= dipTrigger) {
          dipHit = true;
          dipIdx = d;
          dipPrice = dipTrigger; // conservative fill
          break;
        }
      }
    }
    var recoveryMaxReturn = null;
    if (dipHit) {
      var maxPostDipHigh = -Infinity;
      for (var r = dipIdx; r < laterBars.length; r++) {
        if (laterBars[r].h > maxPostDipHigh) maxPostDipHigh = laterBars[r].h;
      }
      recoveryMaxReturn = ((maxPostDipHigh - dipPrice) / dipPrice) * 100;
    }

    return {
      trend: trend,
      openPrice: openPrice,
      windowClose: windowClose,
      dayClose: dayClose,
      postWindowReturn: postWindowReturn,
      greenMaxReturn: greenMaxReturn,
      dipHit: dipHit,
      dipPrice: dipPrice,
      recoveryMaxReturn: recoveryMaxReturn
    };
  }

  // -------------------------------------------------------------------
  // Score one (ticker, timeframe) combination
  // -------------------------------------------------------------------
  function scoreTimeframe(ticker, timeframe, preparedDays, settings) {
    var perDay = [];
    for (var i = 0; i < preparedDays.length; i++) {
      var rec = analyzeDay(preparedDays[i], timeframe, settings.dipPct);
      if (rec) perDay.push(rec);
    }
    if (!perDay.length) return null;

    var greenDays = 0, redDays = 0, flatDays = 0;
    var greenCorrect = 0, redCorrect = 0;
    var signalsTaken = 0;
    var falseSignals = 0;
    var smallestTarget = Math.min.apply(null, settings.hitTargets);
    var postReturns = [];

    // Hit counters for unified per-target columns (green strategy hits +X
    // measured from windowClose; red dip-recovery hits +X measured from
    // dipPrice). Both are "signal succeeded" tallies.
    var hitCounts = {};
    settings.hitTargets.forEach(function (t) { hitCounts[String(t)] = 0; });

    perDay.forEach(function (r) {
      if (r.trend === 'green') {
        greenDays++;
        signalsTaken++;
        if (r.dayClose > r.windowClose) greenCorrect++;
        settings.hitTargets.forEach(function (t) {
          if (r.greenMaxReturn >= t) hitCounts[String(t)]++;
        });
        if (r.greenMaxReturn < smallestTarget) falseSignals++;
      } else if (r.trend === 'red') {
        redDays++;
        if (r.dayClose < r.windowClose) redCorrect++;
        if (r.dipHit) {
          signalsTaken++;
          settings.hitTargets.forEach(function (t) {
            if (r.recoveryMaxReturn >= t) hitCounts[String(t)]++;
          });
          if (r.recoveryMaxReturn < smallestTarget) falseSignals++;
        }
      } else {
        flatDays++;
      }
      if (isFinite(r.postWindowReturn)) postReturns.push(r.postWindowReturn);
    });

    var avgReturn    = postReturns.length ? avg(postReturns) : 0;
    var medianReturn = postReturns.length ? median(postReturns) : 0;
    var totalReturn  = postReturns.reduce(function (s, x) { return s + x; }, 0);
    var falseSignalRate = signalsTaken ? falseSignals / signalsTaken : 0;
    // EOD accuracy: correct direction calls / actionable directional days.
    var directionalDays = greenDays + redDays;
    var eodAccuracy = directionalDays ? (greenCorrect + redCorrect) / directionalDays : 0;

    // Target sweep — pick the target that maximizes expectancy across
    // every actionable signal at this timeframe.
    var sweepResult = sweepBestTarget(perDay, settings.targetSweep);

    var hits035 = settings.hitTargets.indexOf(0.35) >= 0 ? (signalsTaken ? hitCounts['0.35'] / signalsTaken : 0) : null;
    var hits05  = settings.hitTargets.indexOf(0.5)  >= 0 ? (signalsTaken ? hitCounts['0.5']  / signalsTaken : 0) : null;
    var hits1   = settings.hitTargets.indexOf(1)    >= 0 ? (signalsTaken ? hitCounts['1']    / signalsTaken : 0) : null;

    return {
      ticker: ticker,
      timeframe: timeframe,
      totalDays: perDay.length,
      greenDays: greenDays,
      redDays: redDays,
      flatDays: flatDays,
      signalsTaken: signalsTaken,
      greenCorrect: greenCorrect,
      redCorrect: redCorrect,
      eodAccuracy: eodAccuracy,
      hits035: hits035,
      hits05: hits05,
      hits1: hits1,
      hitCounts: hitCounts,
      avgReturn: avgReturn,
      medianReturn: medianReturn,
      totalReturn: totalReturn,
      falseSignals: falseSignals,
      falseSignalRate: falseSignalRate,
      bestTarget: sweepResult ? sweepResult.targetPct : null,
      bestExpectancy: sweepResult ? sweepResult.expectancy : 0,
      bestWinRate: sweepResult ? sweepResult.winRate : 0,
      bestTradesTaken: sweepResult ? sweepResult.tradesTaken : 0
    };
  }

  // -------------------------------------------------------------------
  // Target sweep — return the target maximizing expectancy
  // -------------------------------------------------------------------
  function sweepBestTarget(perDay, targetSweep) {
    var best = null;
    targetSweep.forEach(function (T) {
      var pls = [];
      perDay.forEach(function (r) {
        if (r.trend === 'green') {
          // Hit target -> +T. Else exit at EOD post-window return.
          if (r.greenMaxReturn >= T) pls.push(T);
          else                       pls.push(r.postWindowReturn);
        } else if (r.trend === 'red' && r.dipHit) {
          // For the red branch the trade is entered at dipPrice.
          if (r.recoveryMaxReturn >= T) pls.push(T);
          else {
            var closeVsDip = ((r.dayClose - r.dipPrice) / r.dipPrice) * 100;
            pls.push(closeVsDip);
          }
        }
      });
      if (!pls.length) return;
      var wins   = pls.filter(function (x) { return x > 0; });
      var losses = pls.filter(function (x) { return x < 0; });
      var n = pls.length;
      var winRate = wins.length / n;
      var avgWin  = wins.length   ? avg(wins)   : 0;
      var avgLoss = losses.length ? Math.abs(avg(losses)) : 0;
      var expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
      var row = {
        targetPct: T,
        expectancy: expectancy,
        winRate: winRate * 100,
        tradesTaken: n
      };
      if (!best || row.expectancy > best.expectancy) best = row;
    });
    return best;
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  function groupByDay(candles) {
    if (typeof BTEngine !== 'undefined' && BTEngine.groupByDay) return BTEngine.groupByDay(candles);
    var out = {};
    candles.forEach(function (b) {
      var key = b.dateKey || (new Date(b.t).toISOString().slice(0, 10));
      (out[key] = out[key] || []).push(b);
    });
    return out;
  }
  function avg(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // -------------------------------------------------------------------
  // Self-test
  // -------------------------------------------------------------------
  function selfTest() {
    var results = [];
    function ok(name, cond, detail) { results.push({ name: name, ok: !!cond, detail: cond ? '' : (detail || '') }); }

    function bar(dateKey, minuteOfDay, o, h, l, c) {
      return { dateKey: dateKey, minuteOfDay: minuteOfDay, o: o, h: h, l: l, c: c };
    }
    // Build a 4-day synthetic session that should reward shorter windows:
    // Each day opens, sets a clear direction in the first 30 minutes, then
    // either follows through (rewarding the call) or reverses (penalizing
    // longer windows that "wait too long").
    var candles = [];
    // Day 1: green-30 -> follow-through up to +1%
    candles.push(bar('2026-04-01', 570, 100, 100.5, 99.9, 100.3));
    candles.push(bar('2026-04-01', 585, 100.3, 100.7, 100.2, 100.6));  // 30-min mark green
    candles.push(bar('2026-04-01', 615, 100.6, 100.7, 100.4, 100.5));  // 45-min mark still green
    candles.push(bar('2026-04-01', 630, 100.5, 101.2, 100.5, 101.0));  // later: +0.4% from windowClose@30
    candles.push(bar('2026-04-01', 660, 101.0, 101.8, 100.9, 101.7));  // +1.1% from 100.6
    candles.push(bar('2026-04-01', 955, 101.7, 101.8, 101.4, 101.5));
    // Day 2: green-30 -> follow-through, target also met
    candles.push(bar('2026-04-02', 570, 50, 50.2, 49.9, 50.1));
    candles.push(bar('2026-04-02', 585, 50.1, 50.4, 50.0, 50.3));
    candles.push(bar('2026-04-02', 615, 50.3, 50.4, 50.2, 50.35));
    candles.push(bar('2026-04-02', 630, 50.35, 50.7, 50.3, 50.65));     // +~0.7% from 50.3
    candles.push(bar('2026-04-02', 955, 50.65, 50.8, 50.5, 50.7));
    // Day 3: red-30 -> follow-through DOWN past dip threshold, recovers +0.5%
    candles.push(bar('2026-04-03', 570, 100, 100, 99.5, 99.6));
    candles.push(bar('2026-04-03', 585, 99.6, 99.6, 99.0, 99.1));       // 30-min mark RED
    candles.push(bar('2026-04-03', 615, 99.1, 99.1, 98.5, 98.7));
    // Dip threshold 3% of 100 = 97. Day must touch 97 later.
    candles.push(bar('2026-04-03', 630, 98.7, 98.7, 96.5, 97.0));       // dip hit
    candles.push(bar('2026-04-03', 660, 97.0, 98.0, 97.0, 97.8));       // recovery from 97 -> 98 = +1.03%
    candles.push(bar('2026-04-03', 955, 97.8, 97.8, 97.3, 97.4));
    // Day 4: green-30 but reversed AFTER 30 — no follow-through
    candles.push(bar('2026-04-04', 570, 200, 200.3, 199.8, 200.2));
    candles.push(bar('2026-04-04', 585, 200.2, 200.5, 200.0, 200.4));   // 30-min RED-reversal absent: green
    candles.push(bar('2026-04-04', 630, 200.4, 200.4, 199.5, 199.7));   // immediately fades
    candles.push(bar('2026-04-04', 955, 199.7, 199.7, 199.3, 199.4));

    var r = analyze({ TEST: candles }, { timeframes: [30, 60], dipPct: 3, hitTargets: [0.35, 0.5, 1] });
    ok('rows = 2', r.rows.length === 2, 'got ' + r.rows.length);

    var row30 = r.rows.find(function (x) { return x.timeframe === 30; });
    var row60 = r.rows.find(function (x) { return x.timeframe === 60; });
    ok('row30 exists', !!row30);
    ok('row60 exists', !!row60);

    ok('row30.totalDays = 4', row30.totalDays === 4, 'got ' + row30.totalDays);
    ok('row30.greenDays = 3', row30.greenDays === 3, 'got ' + row30.greenDays);
    ok('row30.redDays  = 1',  row30.redDays  === 1, 'got ' + row30.redDays);
    ok('row30.signalsTaken = 4 (3 green + 1 red-dip)', row30.signalsTaken === 4, 'got ' + row30.signalsTaken);
    ok('row30.hits1 > 0 (day 1 follows through past +1%)', row30.hits1 > 0, 'got ' + row30.hits1);
    ok('row30.bestExpectancy is finite', isFinite(row30.bestExpectancy));
    ok('bestByTicker.TEST exists', !!r.bestByTicker.TEST);
    ok('bestByTicker chooses the higher-expectancy timeframe',
       r.bestByTicker.TEST.bestExpectancy >= row60.bestExpectancy &&
       r.bestByTicker.TEST.bestExpectancy >= row30.bestExpectancy);

    // Sanity: avgReturn finite, falseSignalRate in [0,1]
    ok('row30 avgReturn finite', isFinite(row30.avgReturn));
    ok('row30 falseSignalRate in [0,1]', row30.falseSignalRate >= 0 && row30.falseSignalRate <= 1);

    var failed = results.filter(function (x) { return !x.ok; }).length;
    return { passed: results.length - failed, failed: failed, results: results };
  }

  var api = { analyze: analyze, selfTest: selfTest };
  if (typeof window !== 'undefined') window.BTTimeframeAccuracy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
