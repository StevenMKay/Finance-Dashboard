/* ============================================================
 * Backtester Engine — DOM-free strategy + math kernel.
 *
 * Safe to load BOTH:
 *   <script src="/js/backtester-engine.js"></script>   (main thread)
 *   importScripts('/js/backtester-engine.js');          (Web Worker)
 *
 * No globals leak besides `BTEngine`. No DOM access. No fetch. No timers.
 *
 * --- Public API (attached to globalThis.BTEngine) -----------
 *   BTEngine.runSeries(candles, opts) -> { trades:[...], summary:{...} }
 *   BTEngine.runDay(dayBars, opts)    -> tradeRow
 *   BTEngine.summarize(trades, opts?) -> summary
 *   BTEngine.groupByDay(candles)      -> { 'YYYY-MM-DD': bars[] }
 *   BTEngine.selfTest()               -> { passed, failed, results:[...] }
 *
 * --- Bar shape ----------------------------------------------
 *   { t, o, h, l, c, v?, minuteOfDay?, dateKey? }
 *   The data layer stamps `minuteOfDay` (e.g. 9:30 ET = 570) and
 *   `dateKey` (YYYY-MM-DD ET) so the engine never has to think about
 *   timezones. If those are missing, runSeries() derives them from `t`
 *   using UTC (mock data path).
 *
 * --- opts (all defaults except targetPct) -------------------
 *   {
 *     ticker         : 'AMD',
 *     trendWindowMin : 60,          // first-hour window in minutes
 *     dipPct         : 3,           // % drop below open to trigger down-trend buy
 *     targetPct      : 0.5,         // REQUIRED — profit target %
 *     stopPct        : null,        // number or null
 *     slippageBps    : 0,           // basis points (1 bp = 0.01%)
 *     intervalMin    : 5            // candle interval in minutes
 *   }
 *
 * --- tradeRow (one per simulated day) -----------------------
 *   {
 *     // identity
 *     date, ticker, targetPct, stopPct, slippageBps, intervalMin,
 *     // day OHLC (full session, RTH only)
 *     open, high, low, close,
 *     firstHourClose,
 *     trend,                      // 'up' | 'down' | 'flat'
 *     tradeType,                  // 'up' | 'down' | 'none'
 *     // trigger prices (pre-slippage, what the order rules saw)
 *     rawBuyPrice, rawSellPrice,
 *     // effective fills (post-slippage)
 *     buyPrice, sellPrice,
 *     profitPct,                  // (sellPrice - buyPrice) / buyPrice * 100
 *     // timing
 *     entryTime, exitTime,        // unix ms, or null on no-trade
 *     holdingBars, holdingMinutes,
 *     // outcomes
 *     targetHit, stopHit,
 *     exitReason,                 // 'target' | 'stop' | 'eod' | 'none'
 *     // mark-to-market while in position (% from rawBuyPrice)
 *     maxUnrealizedGainPct,       // MFE
 *     maxUnrealizedLossPct        // MAE (signed, <= 0)
 *   }
 * ============================================================ */

(function (root) {
  'use strict';

  var MARKET_OPEN_MIN  = 9 * 60 + 30; // 9:30 -> 570
  var MARKET_CLOSE_MIN = 16 * 60;     // 16:00 -> 960

  // ----------------------------------------------------------
  // Public: runSeries — multiple days, one (ticker × strategy)
  // ----------------------------------------------------------
  function runSeries(candles, opts) {
    opts = normalizeOpts(opts);
    if (!Array.isArray(candles) || candles.length === 0) {
      return { trades: [], summary: emptySummary(opts) };
    }

    // Stamp minuteOfDay/dateKey if the data layer didn't.
    var stamped = stampBars(candles);
    var byDay = groupByDay(stamped);

    var dayKeys = Object.keys(byDay).sort();
    var trades = [];
    for (var i = 0; i < dayKeys.length; i++) {
      var dayBars = byDay[dayKeys[i]];
      var row = runDay(dayBars, opts);
      if (row) trades.push(row);
    }

    return { trades: trades, summary: summarize(trades, opts) };
  }

  // ----------------------------------------------------------
  // Public: runDay — one day's bars -> one tradeRow
  // ----------------------------------------------------------
  function runDay(dayBars, opts) {
    opts = normalizeOpts(opts);
    if (!Array.isArray(dayBars) || dayBars.length === 0) return null;

    // Defensive sort by minuteOfDay (some upstreams arrive out of order)
    dayBars = dayBars.slice().sort(function (a, b) {
      return (a.minuteOfDay || 0) - (b.minuteOfDay || 0);
    });

    var firstHourEnd = MARKET_OPEN_MIN + opts.trendWindowMin;
    var firstHourBars = [];
    var laterBars = [];
    for (var i = 0; i < dayBars.length; i++) {
      var b = dayBars[i];
      if (b.minuteOfDay < firstHourEnd) firstHourBars.push(b);
      else                              laterBars.push(b);
    }

    // Need both a first-hour window AND later bars to run any strategy.
    if (firstHourBars.length === 0 || laterBars.length === 0) return null;

    var openPrice      = firstHourBars[0].o;
    var firstHourClose = firstHourBars[firstHourBars.length - 1].c;
    var dayClose       = laterBars[laterBars.length - 1].c;

    // Whole-day OHLC across every bar in the session.
    var dayHigh = -Infinity, dayLow = Infinity;
    for (var k = 0; k < dayBars.length; k++) {
      if (dayBars[k].h > dayHigh) dayHigh = dayBars[k].h;
      if (dayBars[k].l < dayLow)  dayLow  = dayBars[k].l;
    }

    var trend = firstHourClose > openPrice ? 'up'
              : firstHourClose < openPrice ? 'down'
              : 'flat';

    var row = baseRow(dayBars, opts, openPrice, dayHigh, dayLow, dayClose, firstHourClose, trend);

    // --- Trend up --------------------------------------------------
    if (trend === 'up') {
      row.tradeType = 'up';
      row.rawBuyPrice = firstHourClose;
      row.entryTime   = firstHourBars[firstHourBars.length - 1].t;
      simulateExit(row, laterBars, /*entryBarIdx=*/0, opts);

    // --- Trend down ------------------------------------------------
    } else if (trend === 'down') {
      var dipPrice = openPrice * (1 - opts.dipPct / 100);
      var entryIdx = -1;
      for (var j = 0; j < laterBars.length; j++) {
        if (laterBars[j].l <= dipPrice) { entryIdx = j; break; }
      }
      if (entryIdx === -1) {
        // Dip never reached -> no trade taken on this day.
        row.tradeType   = 'none';
        row.exitReason  = 'none';
      } else {
        row.tradeType   = 'down';
        row.rawBuyPrice = dipPrice;
        row.entryTime   = laterBars[entryIdx].t;
        simulateExit(row, laterBars, entryIdx, opts);
      }

    // --- Exactly flat ---------------------------------------------
    } else {
      row.tradeType  = 'none';
      row.exitReason = 'none';
    }

    return row;
  }

  // ----------------------------------------------------------
  // Internal: walk laterBars from entryBarIdx forward, fill exit.
  // Handles target / stop / EOD + MFE/MAE + slippage.
  // ----------------------------------------------------------
  function simulateExit(row, laterBars, entryBarIdx, opts) {
    var raw    = row.rawBuyPrice;
    var target = raw * (1 + opts.targetPct / 100);
    var stop   = (opts.stopPct != null) ? raw * (1 - opts.stopPct / 100) : null;

    var hitTarget = false, hitStop = false;
    var exitIdx = -1;
    var rawSell = null;

    // For trend-down, the entry bar's own low triggered the buy — we
    // should NOT also exit on that same bar from its low. The entry
    // bar's high IS allowed to immediately hit the target though.
    var entryWasFromBelow = (row.tradeType === 'down');

    var mfe = 0;   // % above raw (max favorable excursion), >= 0
    var mae = 0;   // % below raw (max adverse excursion),   <= 0

    for (var i = entryBarIdx; i < laterBars.length; i++) {
      var b = laterBars[i];
      var isEntryBar = (i === entryBarIdx);

      // ----- mark-to-market for MFE / MAE -------------------------
      var barHighPct = (b.h - raw) / raw * 100;
      var barLowPct  = (b.l - raw) / raw * 100;
      if (barHighPct > mfe) mfe = barHighPct;
      // On the entry bar of a trend-down trade, b.l == raw (or below),
      // and that doesn't represent open-position adversity — clamp it
      // so we don't pretend we lost money before the order even filled.
      if (!(isEntryBar && entryWasFromBelow) && barLowPct < mae) mae = barLowPct;

      // ----- exit detection --------------------------------------
      // Conservative tie-break: if a single bar hits both stop and
      // target, the stop fills first.
      var canStop   = (stop != null) && !(isEntryBar && entryWasFromBelow);
      var stopThisBar   = canStop && (b.l <= stop);
      var targetThisBar = (b.h >= target);

      if (stopThisBar) {
        hitStop = true; rawSell = stop;       exitIdx = i; break;
      }
      if (targetThisBar) {
        hitTarget = true; rawSell = target;   exitIdx = i; break;
      }
    }

    if (exitIdx === -1) {
      // Held to close.
      var lastBar = laterBars[laterBars.length - 1];
      rawSell    = lastBar.c;
      exitIdx    = laterBars.length - 1;
      row.exitReason = 'eod';
    } else {
      row.exitReason = hitStop ? 'stop' : 'target';
    }

    // Apply slippage at the fill (not at trigger detection).
    var bps = opts.slippageBps / 10000;
    var effBuy  = raw * (1 + bps);
    var effSell = rawSell * (1 - bps);

    row.rawSellPrice = round4(rawSell);
    row.buyPrice     = round4(effBuy);
    row.sellPrice    = round4(effSell);
    row.profitPct    = (effSell - effBuy) / effBuy * 100;
    row.targetHit    = hitTarget;
    row.stopHit      = hitStop;
    row.exitTime     = laterBars[exitIdx].t;
    row.holdingBars  = (exitIdx - entryBarIdx) + 1;
    row.holdingMinutes      = row.holdingBars * opts.intervalMin;
    row.maxUnrealizedGainPct = round4(mfe);
    row.maxUnrealizedLossPct = round4(mae);

    // rawBuyPrice rounded too, after we used full precision above.
    row.rawBuyPrice = round4(raw);
  }

  // ----------------------------------------------------------
  // Internal: scaffold a fresh tradeRow with day-level facts
  // ----------------------------------------------------------
  function baseRow(dayBars, opts, open, high, low, close, fhc, trend) {
    return {
      date:        dayBars[0].dateKey,
      ticker:      opts.ticker,
      targetPct:   opts.targetPct,
      stopPct:     opts.stopPct,
      slippageBps: opts.slippageBps,
      intervalMin: opts.intervalMin,

      open:           round4(open),
      high:           round4(high),
      low:            round4(low),
      close:          round4(close),
      firstHourClose: round4(fhc),
      trend:          trend,
      tradeType:      'none',

      rawBuyPrice:  null, rawSellPrice: null,
      buyPrice:     null, sellPrice:    null,
      profitPct:    null,
      entryTime:    null, exitTime:     null,
      holdingBars:  0,    holdingMinutes: 0,
      targetHit:    false, stopHit:     false,
      exitReason:   'none',
      maxUnrealizedGainPct: 0,
      maxUnrealizedLossPct: 0
    };
  }

  // ----------------------------------------------------------
  // Public: summarize(trades, opts) — aggregate stats
  // ----------------------------------------------------------
  function summarize(trades, opts) {
    opts = opts || {};
    var taken   = trades.filter(function (t) { return t.tradeType !== 'none' && t.profitPct != null; });
    var noTrade = trades.filter(function (t) { return t.tradeType === 'none'; });
    var wins    = taken.filter(function (t) { return t.profitPct > 0; });
    var losses  = taken.filter(function (t) { return t.profitPct <= 0; });

    var sumPL    = sum(taken.map(function (t) { return t.profitPct; }));
    var sumWins  = sum(wins.map(function (t) { return t.profitPct; }));
    var sumLoss  = sum(losses.map(function (t) { return Math.abs(t.profitPct); }));
    var avgPL    = taken.length ? sumPL / taken.length : 0;
    var avgWin   = wins.length   ? sumWins / wins.length : 0;
    var avgLoss  = losses.length ? sumLoss / losses.length : 0;
    var winRate  = taken.length ? wins.length / taken.length : 0;
    var profitFactor = sumLoss > 0 ? sumWins / sumLoss : (sumWins > 0 ? Infinity : 0);

    var best  = taken.reduce(function (m, t) { return (m == null || t.profitPct > m.profitPct) ? t : m; }, null);
    var worst = taken.reduce(function (m, t) { return (m == null || t.profitPct < m.profitPct) ? t : m; }, null);

    // Equity curve + max drawdown on cumulative % return.
    var cum = 0, peak = 0, maxDD = 0;
    var equity = [];
    for (var i = 0; i < taken.length; i++) {
      cum += taken[i].profitPct;
      equity.push({ date: taken[i].date, equity: cum });
      if (cum > peak) peak = cum;
      var dd = cum - peak; // <= 0
      if (dd < maxDD) maxDD = dd;
    }

    // Sharpe-ish: mean / std of trade-day returns (no annualization yet).
    var mean = avgPL;
    var variance = 0;
    for (var j = 0; j < taken.length; j++) {
      variance += Math.pow(taken[j].profitPct - mean, 2);
    }
    variance = taken.length > 1 ? variance / (taken.length - 1) : 0;
    var std = Math.sqrt(variance);
    var sharpe = std > 0 ? mean / std : 0;

    // Expectancy = winRate*avgWin - lossRate*avgLoss
    var lossRate = 1 - winRate;
    var expectancy = winRate * avgWin - lossRate * avgLoss;

    var avgHoldingMin = taken.length ? sum(taken.map(function (t) { return t.holdingMinutes; })) / taken.length : 0;
    var avgMFE        = taken.length ? sum(taken.map(function (t) { return t.maxUnrealizedGainPct; })) / taken.length : 0;
    var avgMAE        = taken.length ? sum(taken.map(function (t) { return t.maxUnrealizedLossPct; })) / taken.length : 0;

    return {
      ticker:       opts.ticker || (taken[0] ? taken[0].ticker : ''),
      targetPct:    opts.targetPct != null ? opts.targetPct : (taken[0] ? taken[0].targetPct : null),
      stopPct:      opts.stopPct != null ? opts.stopPct : (taken[0] ? taken[0].stopPct : null),
      slippageBps:  opts.slippageBps != null ? opts.slippageBps : (taken[0] ? taken[0].slippageBps : 0),
      totalDays:    trades.length,
      tradesTaken:  taken.length,
      noTradeDays:  noTrade.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      winRate * 100,
      avgPL:        avgPL,
      totalPL:      sumPL,
      sumWins:      sumWins,
      sumLosses:    sumLoss,
      profitFactor: profitFactor,
      avgWin:       avgWin,
      avgLoss:      avgLoss,
      expectancy:   expectancy,
      sharpe:       sharpe,
      maxDrawdown:  maxDD,
      bestDay:      best  ? { date: best.date,  plPct: best.profitPct }  : null,
      worstDay:     worst ? { date: worst.date, plPct: worst.profitPct } : null,
      avgHoldingMin: avgHoldingMin,
      avgMFE:       avgMFE,
      avgMAE:       avgMAE,
      equityCurve:  equity
    };
  }

  function emptySummary(opts) {
    return {
      ticker: opts.ticker || '', targetPct: opts.targetPct, stopPct: opts.stopPct,
      slippageBps: opts.slippageBps,
      totalDays: 0, tradesTaken: 0, noTradeDays: 0,
      wins: 0, losses: 0, winRate: 0,
      avgPL: 0, totalPL: 0, sumWins: 0, sumLosses: 0, profitFactor: 0,
      avgWin: 0, avgLoss: 0, expectancy: 0, sharpe: 0, maxDrawdown: 0,
      bestDay: null, worstDay: null,
      avgHoldingMin: 0, avgMFE: 0, avgMAE: 0,
      equityCurve: []
    };
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------
  function normalizeOpts(o) {
    o = o || {};
    return {
      ticker:         o.ticker || '',
      trendWindowMin: numOr(o.trendWindowMin, 60),
      dipPct:         numOr(o.dipPct, 3),
      targetPct:      numOr(o.targetPct, 0.5),
      stopPct:        (o.stopPct === null || o.stopPct === undefined || o.stopPct === '') ? null : Number(o.stopPct),
      slippageBps:    numOr(o.slippageBps, 0),
      intervalMin:    numOr(o.intervalMin, 5)
    };
  }
  function numOr(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += (+arr[i] || 0); return s; }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  function stampBars(candles) {
    var out = new Array(candles.length);
    for (var i = 0; i < candles.length; i++) {
      var b = candles[i];
      if (b.minuteOfDay != null && b.dateKey) { out[i] = b; continue; }
      var d = new Date(b.t);
      var mod = (b.minuteOfDay != null) ? b.minuteOfDay : (d.getUTCHours() * 60 + d.getUTCMinutes());
      var dk  = b.dateKey || (
        d.getUTCFullYear() + '-' +
        pad2(d.getUTCMonth() + 1) + '-' +
        pad2(d.getUTCDate())
      );
      out[i] = {
        t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        minuteOfDay: mod, dateKey: dk
      };
    }
    return out;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function groupByDay(candles) {
    var by = {};
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var k = c.dateKey;
      if (!by[k]) by[k] = [];
      by[k].push(c);
    }
    // Filter out bars that escaped the RTH window — defensive only.
    Object.keys(by).forEach(function (k) {
      by[k] = by[k].filter(function (b) {
        return b.minuteOfDay >= MARKET_OPEN_MIN && b.minuteOfDay < MARKET_CLOSE_MIN;
      });
      by[k].sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });
    });
    return by;
  }

  // ============================================================
  // Self-test — fixed scenarios with hand-crafted bars.
  // Returns { passed, failed, results:[{name, ok, detail}] }.
  // ============================================================
  function selfTest() {
    var results = [];
    function check(name, fn) {
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || 'ok' });
      } catch (e) {
        results.push({ name: name, ok: false, detail: e.message || String(e) });
      }
    }
    function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 0.0001); }
    function assert(cond, msg) { if (!cond) throw new Error(msg); }

    // ----- Synthetic-day builder ------------------------------
    // Build 5m bars 9:30 .. 16:00 for one day. Caller supplies a
    // function (minuteOfDay) -> { o, h, l, c } so each test can
    // shape its own scenario.
    function buildDay(date, shape) {
      var bars = [];
      for (var m = MARKET_OPEN_MIN; m < MARKET_CLOSE_MIN; m += 5) {
        var ohlc = shape(m);
        bars.push({
          t: Date.parse(date + 'T00:00:00Z') + m * 60000,
          o: ohlc.o, h: ohlc.h, l: ohlc.l, c: ohlc.c,
          minuteOfDay: m, dateKey: date
        });
      }
      return bars;
    }

    // 1. Trend-up, target hit at midday.
    check('up-trend target hit', function () {
      var bars = buildDay('2026-01-05', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          // ramp from 100 -> 101 over the first hour
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 + t * 1;
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        // Sit at 101 until 12:00, then spike to 102 once.
        if (m === 12 * 60) return { o: 101, h: 102.1, l: 100.9, c: 101.5 };
        return { o: 101, h: 101.05, l: 100.95, c: 101 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, intervalMin: 5 });
      assert(row.trend === 'up', 'trend should be up');
      assert(row.tradeType === 'up', 'tradeType should be up');
      assert(row.exitReason === 'target', 'should hit target');
      assert(approx(row.rawSellPrice, row.rawBuyPrice * 1.005), 'sell ~ buy*(1+0.5%)');
      assert(approx(row.profitPct, 0.5), 'profitPct ~= 0.5');
      assert(row.maxUnrealizedGainPct >= row.profitPct - 1e-6, 'MFE >= realized');
      return 'profit=' + row.profitPct.toFixed(4);
    });

    // 2. Trend-up, target never hit -> EOD close.
    check('up-trend EOD exit', function () {
      var bars = buildDay('2026-01-06', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          return { o: 100 + t*0.5, h: 100 + t*0.5 + 0.05, l: 100 + t*0.5 - 0.05, c: 100 + t*0.5 };
        }
        return { o: 100.5, h: 100.6, l: 100.4, c: 100.5 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, intervalMin: 5 });
      assert(row.tradeType === 'up', 'should be up trade');
      assert(row.exitReason === 'eod', 'should exit at EOD, got ' + row.exitReason);
      return 'sell=' + row.rawSellPrice;
    });

    // 3. Trend-up + stop hit before target.
    check('up-trend stop hit', function () {
      var bars = buildDay('2026-01-07', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 + t * 1;
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        if (m === 11 * 60) return { o: 101, h: 101.05, l: 99.8, c: 100 };
        return { o: 100, h: 100.1, l: 99.9, c: 100 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, stopPct: 1, intervalMin: 5 });
      assert(row.exitReason === 'stop', 'should stop, got ' + row.exitReason);
      assert(approx(row.rawSellPrice, row.rawBuyPrice * 0.99), 'stop sell ~ buy*(1-1%)');
      return 'profit=' + row.profitPct.toFixed(4);
    });

    // 4. Up-trend, single bar hits BOTH stop and target -> stop (conservative).
    check('up-trend stop+target same bar reports stop', function () {
      var bars = buildDay('2026-01-08', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 + t * 1;
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        if (m === 11 * 60) return { o: 101, h: 102, l: 99.8, c: 101 };
        return { o: 101, h: 101.05, l: 100.95, c: 101 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, stopPct: 1, intervalMin: 5 });
      assert(row.exitReason === 'stop', 'tie-break must favor stop, got ' + row.exitReason);
      return 'ok';
    });

    // 5. Trend-down, dip never reached -> no trade.
    check('down-trend dip never hit -> no trade', function () {
      var bars = buildDay('2026-01-09', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 - t * 0.5; // gentle down
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        // Drift sideways at 99.6 — never reaches 97 (3% dip).
        return { o: 99.6, h: 99.7, l: 99.5, c: 99.6 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, dipPct: 3, targetPct: 0.5, intervalMin: 5 });
      assert(row.trend === 'down', 'first-hour should be down');
      assert(row.tradeType === 'none', 'should be no trade');
      assert(row.exitReason === 'none', 'exitReason none');
      return 'ok';
    });

    // 6. Trend-down, dip hit + target hit.
    check('down-trend dip hit + target hit', function () {
      var bars = buildDay('2026-01-12', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 - t * 0.5;
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        // 11:00 dives to 96.9 (below 97 = open*0.97). Then rebounds.
        if (m === 11 * 60) return { o: 99.5, h: 99.5, l: 96.9, c: 97.5 };
        if (m === 13 * 60) return { o: 97.5, h: 97.8, l: 97.4, c: 97.6 };
        return { o: 97.5, h: 97.55, l: 97.45, c: 97.5 };
      });
      var row = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, dipPct: 3, targetPct: 0.5, intervalMin: 5 });
      assert(row.tradeType === 'down', 'tradeType down, got ' + row.tradeType);
      assert(row.exitReason === 'target', 'should hit target, got ' + row.exitReason);
      assert(approx(row.rawBuyPrice, 97.0), 'dip buy = open*0.97 = 97');
      assert(approx(row.rawSellPrice, 97.0 * 1.005), 'sell ~ buy*(1+0.5%)');
      return 'profit=' + row.profitPct.toFixed(4);
    });

    // 7. Slippage applied.
    check('slippageBps applied (10 bps)', function () {
      var bars = buildDay('2026-01-13', function (m) {
        if (m < MARKET_OPEN_MIN + 60) {
          var t = (m - MARKET_OPEN_MIN) / 60;
          var p = 100 + t * 1;
          return { o: p, h: p + 0.05, l: p - 0.05, c: p };
        }
        if (m === 12 * 60) return { o: 101, h: 102.1, l: 100.9, c: 101.5 };
        return { o: 101, h: 101.05, l: 100.95, c: 101 };
      });
      var clean = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, intervalMin: 5, slippageBps: 0 });
      var slip  = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, intervalMin: 5, slippageBps: 10 });
      assert(approx(slip.buyPrice,  clean.rawBuyPrice  * 1.001, 0.001), 'buy fill +10bps');
      assert(approx(slip.sellPrice, clean.rawSellPrice * 0.999, 0.001), 'sell fill -10bps');
      assert(slip.profitPct < clean.profitPct, 'slip profit < clean profit');
      return 'clean=' + clean.profitPct.toFixed(4) + ' slip=' + slip.profitPct.toFixed(4);
    });

    // 8. MFE >= profitPct >= MAE invariant for many random days.
    check('MFE >= profit >= MAE invariant', function () {
      // Reuse scenarios above.
      var dates = ['2026-01-05','2026-01-06','2026-01-07','2026-01-12','2026-01-13'];
      var checked = 0;
      for (var i = 0; i < dates.length; i++) {
        var bars = buildDay(dates[i], function (m) {
          // simple noisy walk
          var seed = (m * 9301 + 49297) % 233280;
          var rnd = seed / 233280;
          var p = 100 + (rnd - 0.5) * 4;
          return { o: p, h: p + 0.3, l: p - 0.3, c: p + (rnd - 0.5) * 0.2 };
        });
        var r = runDay(bars, { ticker: 'TEST', trendWindowMin: 60, targetPct: 0.5, dipPct: 3, intervalMin: 5 });
        if (r && r.tradeType !== 'none' && r.profitPct != null) {
          assert(r.maxUnrealizedGainPct + 1e-6 >= r.profitPct, 'MFE >= profit (' + r.maxUnrealizedGainPct + ' vs ' + r.profitPct + ')');
          assert(r.profitPct + 1e-6 >= r.maxUnrealizedLossPct, 'profit >= MAE (' + r.profitPct + ' vs ' + r.maxUnrealizedLossPct + ')');
          checked++;
        }
      }
      return 'checked ' + checked + ' trade days';
    });

    var passed = results.filter(function (r) { return r.ok; }).length;
    var failed = results.length - passed;
    return { passed: passed, failed: failed, results: results };
  }

  // ----------------------------------------------------------
  // Expose
  // ----------------------------------------------------------
  root.BTEngine = {
    runSeries:  runSeries,
    runDay:     runDay,
    summarize:  summarize,
    groupByDay: groupByDay,
    selfTest:   selfTest,
    // constants useful for tests / UI
    MARKET_OPEN_MIN:  MARKET_OPEN_MIN,
    MARKET_CLOSE_MIN: MARKET_CLOSE_MIN
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
