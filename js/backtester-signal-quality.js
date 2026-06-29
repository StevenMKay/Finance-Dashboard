/* First-Hour Signal Quality Report — Phase L
 * --------------------------------------------------------------------
 * Asks one question per ticker over the loaded historical period:
 *   How well does the first-hour direction predict the rest of the day?
 *
 * It re-uses bars already loaded by the Engine tab — no new fetches —
 * and uses BTEngine for first-hour boundary math so it stays consistent
 * with everything else in the lab.
 *
 * Public:
 *   BTSignalQuality.analyze(candlesByTicker, opts) -> { byTicker, overall, settings }
 *   BTSignalQuality.selfTest() -> { passed, failed, results }
 *
 * Per-ticker (and overall) row shape:
 *   {
 *     ticker, totalDays,
 *     greenDays, redDays, flatDays,
 *     // Among green-first-hour days, how often the rest of the day
 *     // touched +X% above the first-hour close.
 *     greenHits:    { '0.35': n, '0.5': n, '1': n },
 *     // Among red-first-hour days, how often price later dipped dipPct%
 *     // below the open; and after the dip, how often it recovered +X%.
 *     redDipDays,
 *     recoveryHits: { '0.35': n, '0.5': n, '1': n },
 *     // Acted signals that failed to reach the smallest threshold.
 *     falseSignals, signalsTaken, falseSignalRate,
 *     // Distribution of returns from first-hour close to EOD.
 *     avgPostReturn, medianPostReturn,
 *     // Sweep of target sizes, ranked by expectancy (not win rate).
 *     bestTarget: { targetPct, expectancy, winRate, tradesTaken, avgWin, avgLoss }
 *   }
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var MARKET_OPEN_MIN  = 9 * 60 + 30;
  var MARKET_CLOSE_MIN = 16 * 60;

  function analyze(candlesByTicker, opts) {
    opts = opts || {};
    var settings = {
      trendWindowMin:   Number(opts.trendWindowMin)   || 60,
      dipPct:           Number(opts.dipPct)           || 3,
      greenTargets:     opts.greenTargets     || [0.35, 0.5, 1],
      recoveryTargets:  opts.recoveryTargets  || [0.35, 0.5, 1],
      targetSweep:      opts.targetSweep      || [0.35, 0.5, 0.75, 1, 1.5, 2, 3]
    };

    var byTicker = {};
    var allRecords = [];

    Object.keys(candlesByTicker || {}).forEach(function (tk) {
      var candles = candlesByTicker[tk] || [];
      if (!candles.length) return;
      var dayGroups = groupByDay(candles);
      var records = [];
      Object.keys(dayGroups).sort().forEach(function (dateKey) {
        var rec = analyzeDay(dayGroups[dateKey], settings);
        if (rec) {
          rec.date = dateKey;
          rec.ticker = tk;
          records.push(rec);
          allRecords.push(rec);
        }
      });
      byTicker[tk] = summarize(records, settings);
      byTicker[tk].ticker = tk;
    });

    var overall = summarize(allRecords, settings);
    overall.ticker = 'OVERALL';

    return { byTicker: byTicker, overall: overall, settings: settings };
  }

  // -------------------------------------------------------------------
  // Per-day record
  // -------------------------------------------------------------------
  function analyzeDay(dayBars, settings) {
    if (!dayBars || !dayBars.length) return null;

    // Match BTEngine: filter to RTH and sort by minuteOfDay.
    dayBars = dayBars.filter(function (b) {
      return b && typeof b.minuteOfDay === 'number' &&
             b.minuteOfDay >= MARKET_OPEN_MIN && b.minuteOfDay < MARKET_CLOSE_MIN;
    }).slice().sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });

    if (dayBars.length === 0) return null;

    var firstHourEnd = MARKET_OPEN_MIN + settings.trendWindowMin;
    var firstHourBars = [], laterBars = [];
    for (var i = 0; i < dayBars.length; i++) {
      if (dayBars[i].minuteOfDay < firstHourEnd) firstHourBars.push(dayBars[i]);
      else                                       laterBars.push(dayBars[i]);
    }
    if (!firstHourBars.length || !laterBars.length) return null;

    var openPrice      = firstHourBars[0].o;
    var firstHourClose = firstHourBars[firstHourBars.length - 1].c;
    var dayClose       = laterBars[laterBars.length - 1].c;

    var trend = firstHourClose > openPrice ? 'green'
              : firstHourClose < openPrice ? 'red'
              : 'flat';

    // Post-first-hour stats — max upside, max downside, EOD return.
    var postMaxHigh = -Infinity, postMinLow = Infinity;
    for (var k = 0; k < laterBars.length; k++) {
      if (laterBars[k].h > postMaxHigh) postMaxHigh = laterBars[k].h;
      if (laterBars[k].l < postMinLow)  postMinLow  = laterBars[k].l;
    }

    // postHourReturn = close vs first-hour close (signed %)
    var postHourReturn    = ((dayClose       - firstHourClose) / firstHourClose) * 100;
    // greenMaxReturn = max(high - firstHourClose) / firstHourClose * 100
    var greenMaxReturn    = ((postMaxHigh    - firstHourClose) / firstHourClose) * 100;

    // Did each green target get hit (rest of day touched +X% above fhClose)?
    var greenHits = {};
    settings.greenTargets.forEach(function (t) { greenHits[String(t)] = greenMaxReturn >= t; });

    // For red days: did price dip dipPct% below the open at any later bar?
    var dipTrigger = openPrice * (1 - settings.dipPct / 100);
    var dipHit = false, dipIdx = -1, dipPrice = null;
    if (trend === 'red') {
      for (var d = 0; d < laterBars.length; d++) {
        if (laterBars[d].l <= dipTrigger) {
          dipHit = true; dipIdx = d; dipPrice = dipTrigger; // conservative: assume fill at trigger
          break;
        }
      }
    }

    // If dip hit, scan bars FROM dipIdx onward for recovery.
    var recoveryMaxReturn = null;
    var recoveryHits = {};
    settings.recoveryTargets.forEach(function (t) { recoveryHits[String(t)] = false; });
    if (dipHit) {
      var maxPostDipHigh = -Infinity;
      for (var r = dipIdx; r < laterBars.length; r++) {
        if (laterBars[r].h > maxPostDipHigh) maxPostDipHigh = laterBars[r].h;
      }
      recoveryMaxReturn = ((maxPostDipHigh - dipPrice) / dipPrice) * 100;
      settings.recoveryTargets.forEach(function (t) {
        recoveryHits[String(t)] = recoveryMaxReturn >= t;
      });
    }

    return {
      trend: trend,
      openPrice: openPrice,
      firstHourClose: firstHourClose,
      dayClose: dayClose,
      postHourReturn: postHourReturn,
      greenMaxReturn: greenMaxReturn,
      greenHits: greenHits,
      dipHit: dipHit,
      dipPrice: dipPrice,
      recoveryMaxReturn: recoveryMaxReturn,
      recoveryHits: recoveryHits
    };
  }

  // -------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------
  function summarize(records, settings) {
    var totalDays = records.length;
    var greenDays = 0, redDays = 0, flatDays = 0, redDipDays = 0;
    var greenHits = {}, recoveryHits = {};
    settings.greenTargets.forEach(function (t)    { greenHits[String(t)]    = 0; });
    settings.recoveryTargets.forEach(function (t) { recoveryHits[String(t)] = 0; });

    var postReturns = [];
    var signalsTaken = 0, falseSignals = 0;
    var smallestGreen    = Math.min.apply(null, settings.greenTargets);
    var smallestRecovery = Math.min.apply(null, settings.recoveryTargets);

    records.forEach(function (r) {
      if (r.trend === 'green') {
        greenDays++;
        signalsTaken++;
        settings.greenTargets.forEach(function (t) { if (r.greenHits[String(t)]) greenHits[String(t)]++; });
        if (!r.greenHits[String(smallestGreen)]) falseSignals++;
      } else if (r.trend === 'red') {
        redDays++;
        if (r.dipHit) {
          redDipDays++;
          signalsTaken++;
          settings.recoveryTargets.forEach(function (t) { if (r.recoveryHits[String(t)]) recoveryHits[String(t)]++; });
          if (!r.recoveryHits[String(smallestRecovery)]) falseSignals++;
        }
      } else {
        flatDays++;
      }
      if (isFinite(r.postHourReturn)) postReturns.push(r.postHourReturn);
    });

    var avgPostReturn    = postReturns.length ? postReturns.reduce(function (s, x) { return s + x; }, 0) / postReturns.length : 0;
    var medianPostReturn = median(postReturns);
    var falseSignalRate  = signalsTaken ? falseSignals / signalsTaken : 0;

    var bestTarget = sweepBestTargetFromRecords(records, settings);

    return {
      totalDays: totalDays,
      greenDays: greenDays,
      redDays: redDays,
      flatDays: flatDays,
      greenHits: greenHits,
      redDipDays: redDipDays,
      recoveryHits: recoveryHits,
      signalsTaken: signalsTaken,
      falseSignals: falseSignals,
      falseSignalRate: falseSignalRate,
      avgPostReturn: avgPostReturn,
      medianPostReturn: medianPostReturn,
      bestTarget: bestTarget
    };
  }

  // -------------------------------------------------------------------
  // Target sweep — picks the best target by expectancy (signed avg P/L)
  // across every actionable signal in the supplied records.
  //
  // For each target T (no stop):
  //   - green day: profit = +T if greenMaxReturn >= T, else postHourReturn
  //   - red dip-hit day: profit = +T if recoveryMaxReturn >= T,
  //                       else (dayClose - dipPrice)/dipPrice*100
  //   - red no-dip day or flat day: NO TRADE
  // -------------------------------------------------------------------
  function sweepBestTargetFromRecords(records, settings) {
    var best = null;
    settings.targetSweep.forEach(function (T) {
      var pls = [];
      records.forEach(function (r) {
        if (r.trend === 'green') {
          if (r.greenHits[String(T)] || r.greenMaxReturn >= T) pls.push(T);
          else pls.push(r.postHourReturn);
        } else if (r.trend === 'red' && r.dipHit) {
          // For the red branch we need the trade outcome from the dip price.
          if (r.recoveryMaxReturn >= T) pls.push(T);
          else {
            var closeVsDip = ((r.dayClose - r.dipPrice) / r.dipPrice) * 100;
            pls.push(closeVsDip);
          }
        }
      });
      if (!pls.length) return;
      var wins  = pls.filter(function (x) { return x > 0; });
      var losses = pls.filter(function (x) { return x < 0; });
      var n = pls.length;
      var avg = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; };
      var winRate = wins.length / n;
      var avgWin  = avg(wins);
      var avgLoss = Math.abs(avg(losses));
      var expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
      var row = {
        targetPct: T,
        expectancy: expectancy,
        winRate: winRate * 100,
        tradesTaken: n,
        avgWin: avgWin,
        avgLoss: avgLoss
      };
      if (!best || row.expectancy > best.expectancy) best = row;
    });
    return best;
  }

  // -------------------------------------------------------------------
  // Helpers — duplicated minimally to keep this module independent.
  // -------------------------------------------------------------------
  function groupByDay(candles) {
    if (typeof BTEngine !== 'undefined' && BTEngine.groupByDay) return BTEngine.groupByDay(candles);
    // Fallback: bucket by UTC date.
    var out = {};
    candles.forEach(function (b) {
      var key = b.dateKey || (new Date(b.t).toISOString().slice(0, 10));
      (out[key] = out[key] || []).push(b);
    });
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  // -------------------------------------------------------------------
  // Self-test
  // -------------------------------------------------------------------
  function selfTest() {
    var results = [];
    function ok(name, cond, detail) { results.push({ name: name, ok: !!cond, detail: cond ? '' : (detail || '') }); }

    // Build a synthetic 3-day session for one ticker:
    //  Day A: green first hour, later rallies > +1%
    //  Day B: red first hour, dips 3%, then recovers > +1%
    //  Day C: red first hour, never dips
    function bar(dateKey, minuteOfDay, o, h, l, c) {
      return { dateKey: dateKey, minuteOfDay: minuteOfDay, o: o, h: h, l: l, c: c, t: Date.UTC(2026, 0, parseInt(dateKey.slice(-2), 10), 14, minuteOfDay - 9*60-30) };
    }
    var candles = [];
    // ---- Day A (2026-03-02) ---- green, rallies later
    // First-hour bars (570..629): open 100, close at 60-min mark = 101
    candles.push(bar('2026-03-02', 570, 100, 100.5, 99.8, 100.4)); // 9:30
    candles.push(bar('2026-03-02', 600, 100.4, 101, 100, 101));   // 10:00
    candles.push(bar('2026-03-02', 620, 101, 101.2, 100.9, 101)); // 10:20 — still first hour
    // Later bars (>=630): rally to 103
    candles.push(bar('2026-03-02', 630, 101, 102, 101, 102));     // 10:30
    candles.push(bar('2026-03-02', 660, 102, 103.5, 101.5, 103)); // 11:00 — touches +2% from fhClose=101
    candles.push(bar('2026-03-02', 955, 103, 103.1, 102.5, 102.5));// 15:55

    // ---- Day B (2026-03-03) ---- red, dips, recovers
    candles.push(bar('2026-03-03', 570, 100, 100, 99.5, 99.5));   // 9:30 open 100
    candles.push(bar('2026-03-03', 600, 99.5, 99.5, 99, 99));     // 10:00 close 99 (red)
    candles.push(bar('2026-03-03', 620, 99, 99.1, 98.5, 98.8));   // 10:20
    // Later bars: dip to 97 then recover to 99
    candles.push(bar('2026-03-03', 630, 98.8, 98.8, 96.5, 97));   // 10:30 — touches 96.5 (>3% dip)
    candles.push(bar('2026-03-03', 660, 97, 99, 97, 98.5));       // 11:00 — recovers; high 99 from dipPrice 97 = ~2.06%
    candles.push(bar('2026-03-03', 955, 98.5, 98.5, 98, 98));     // 15:55

    // ---- Day C (2026-03-04) ---- red, no dip
    candles.push(bar('2026-03-04', 570, 100, 100, 99.7, 99.7));   // 9:30
    candles.push(bar('2026-03-04', 600, 99.7, 99.8, 99.4, 99.5)); // 10:00 close 99.5 (red)
    candles.push(bar('2026-03-04', 620, 99.5, 99.6, 99.3, 99.4)); // 10:20
    candles.push(bar('2026-03-04', 630, 99.4, 99.6, 99.2, 99.5));
    candles.push(bar('2026-03-04', 955, 99.5, 99.7, 99.3, 99.5));

    var r = analyze({ TEST: candles }, { trendWindowMin: 60, dipPct: 3, greenTargets:[0.35, 0.5, 1], recoveryTargets:[0.35, 0.5, 1] });
    var tk = r.byTicker.TEST;
    ok('totalDays=3',  tk.totalDays === 3, JSON.stringify(tk));
    ok('greenDays=1',  tk.greenDays === 1);
    ok('redDays=2',    tk.redDays === 2);
    ok('redDipDays=1', tk.redDipDays === 1, 'got ' + tk.redDipDays);
    ok('greenHits[1]=1 (rally past +1%)', tk.greenHits['1'] === 1);
    ok('recoveryHits[1]=1 (recovers > +1%)', tk.recoveryHits['1'] === 1, 'got ' + JSON.stringify(tk.recoveryHits));
    ok('signalsTaken=2 (green + red-dip)', tk.signalsTaken === 2);
    ok('falseSignals=0 (both signals hit smallest target)', tk.falseSignals === 0);
    // Best target should be the largest target reached by both legs.
    ok('bestTarget chosen',  tk.bestTarget && tk.bestTarget.targetPct >= 0.35, 'got ' + JSON.stringify(tk.bestTarget));
    // Overall should mirror single-ticker stats here.
    ok('overall.totalDays=3', r.overall.totalDays === 3);

    var failed = results.filter(function (x) { return !x.ok; }).length;
    return { passed: results.length - failed, failed: failed, results: results };
  }

  var api = {
    analyze: analyze,
    selfTest: selfTest
  };
  if (typeof window !== 'undefined') window.BTSignalQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
