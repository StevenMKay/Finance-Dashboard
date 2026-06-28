/* Investment Planner / Risk Sizing — Phase K
 * --------------------------------------------------------------------
 * Pure (no DOM) analytics for position sizing. Takes the BTEngine trade
 * rows you've already produced and answers:
 *   "Given my account size, desired monthly income, and risk tolerance,
 *    how much should I invest per trade — and what month-by-month
 *    outcomes can I realistically expect?"
 *
 * Important convention:
 *   The BTEngine stores percentages as percents (e.g. 1.25 means
 *   +1.25%). Internally this module divides by 100 so every formula
 *   below operates on decimal returns (0.0125). The output `stats`
 *   block reports decimals too (so 0.0125 in `expectancyPct`). The
 *   rendering helpers in backtester.js multiply by 100 for display.
 *
 * Public:
 *   BTInvestmentPlanner.analyze(trades, options) -> { inputs, stats, warnings, monteCarlo }
 *   BTInvestmentPlanner.runMonteCarloMonthly({...})
 *   BTInvestmentPlanner.formatCurrency(n)
 *   BTInvestmentPlanner.formatPercent(decimal, digits?)
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  function analyze(trades, options) {
    options = options || {};
    var accountSize                 = Number(options.accountSize                  || 100000);
    var desiredMonthlyIncome        = Number(options.desiredMonthlyIncome         || 8000);
    var maxRiskPerTradePct          = Number(options.maxRiskPerTradePct           || 1)  / 100;
    var maxCapitalPerTradePct       = Number(options.maxCapitalPerTradePct        || 50) / 100;
    var expectedTradingDaysPerMonth = Number(options.expectedTradingDaysPerMonth  || 21);
    var monteCarloRuns              = Number(options.monteCarloRuns               || 10000);

    // ---- Convert BTEngine trade rows to a uniform shape. ----
    // A trade is "taken" when tradeType is 'up' or 'down' AND profitPct is finite.
    var completedTrades = (trades || []).filter(function (t) {
      return t && t.tradeType && t.tradeType !== 'none' &&
             typeof t.profitPct === 'number' && !Number.isNaN(t.profitPct);
    });

    // Count unique trading days observed (testedTradingDays) using every
    // trade row, including no-trade days, so the rate is honest.
    var testedTradingDays = new Set((trades || []).map(function (t) { return t && t.date; }).filter(Boolean)).size || 1;

    var tradesTaken = completedTrades.length;
    var wins   = completedTrades.filter(function (t) { return t.profitPct > 0; });
    var losses = completedTrades.filter(function (t) { return t.profitPct < 0; });

    var winRate  = tradesTaken ? wins.length / tradesTaken : 0;
    var lossRate = 1 - winRate;

    function avg(arr) {
      if (!arr.length) return 0;
      return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
    }

    var avgWinPct    = avg(wins.map(function (t) { return t.profitPct / 100; }));
    var avgLossPct   = Math.abs(avg(losses.map(function (t) { return t.profitPct / 100; })));
    var worstLossPct = losses.length
      ? Math.abs(Math.min.apply(null, losses.map(function (t) { return t.profitPct / 100; })))
      : avgLossPct;

    var grossWins   = wins.reduce(function (s, t) { return s + (t.profitPct / 100); }, 0);
    var grossLosses = Math.abs(losses.reduce(function (s, t) { return s + (t.profitPct / 100); }, 0));

    var expectancyPct = (winRate * avgWinPct) - (lossRate * avgLossPct);
    var profitFactor  = grossLosses > 0 ? grossWins / grossLosses : null;

    var riskDollars  = accountSize * maxRiskPerTradePct;
    var lossSizingPct = worstLossPct || avgLossPct || 0;
    var positionByRisk = lossSizingPct > 0
      ? riskDollars / lossSizingPct
      : accountSize * maxCapitalPerTradePct;
    var positionByCap = accountSize * maxCapitalPerTradePct;
    var suggestedPosition = Math.min(positionByRisk, positionByCap);

    var expectedProfitPerTrade = suggestedPosition * expectancyPct;
    var expectedTradesPerMonth =
      (tradesTaken / testedTradingDays) * expectedTradingDaysPerMonth;
    var expectedMonthlyProfit = expectedProfitPerTrade * expectedTradesPerMonth;

    var capitalNeededForIncome =
      expectancyPct > 0 && expectedTradesPerMonth > 0
        ? desiredMonthlyIncome / (expectancyPct * expectedTradesPerMonth)
        : null;

    var warnings = [];
    if (expectancyPct <= 0) {
      warnings.push('This strategy has negative expectancy. Do not size up.');
    }
    if (suggestedPosition > accountSize * 0.5) {
      warnings.push('Suggested position is more than 50% of the account. Concentration risk is high.');
    }
    if (expectedMonthlyProfit < desiredMonthlyIncome) {
      warnings.push('Expected monthly profit is below your desired monthly income target.');
    }
    if (tradesTaken < 30) {
      warnings.push('Sample size is below 30 trades. Results may not be reliable.');
    }
    if (!losses.length) {
      warnings.push('No losing trades found. Position sizing used fallback assumptions (avgLossPct = 0).');
    }

    var monteCarlo = runMonteCarloMonthly({
      completedTrades: completedTrades,
      suggestedPosition: suggestedPosition,
      expectedTradesPerMonth: expectedTradesPerMonth,
      desiredMonthlyIncome: desiredMonthlyIncome,
      runs: monteCarloRuns
    });

    return {
      inputs: {
        accountSize: accountSize,
        desiredMonthlyIncome: desiredMonthlyIncome,
        maxRiskPerTradePct: maxRiskPerTradePct,
        maxCapitalPerTradePct: maxCapitalPerTradePct,
        expectedTradingDaysPerMonth: expectedTradingDaysPerMonth
      },
      stats: {
        testedTradingDays: testedTradingDays,
        tradesTaken: tradesTaken,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate: winRate,
        lossRate: lossRate,
        avgWinPct: avgWinPct,
        avgLossPct: avgLossPct,
        worstLossPct: worstLossPct,
        expectancyPct: expectancyPct,
        profitFactor: profitFactor,
        riskDollars: riskDollars,
        positionByRisk: positionByRisk,
        positionByCap: positionByCap,
        suggestedPosition: suggestedPosition,
        expectedProfitPerTrade: expectedProfitPerTrade,
        expectedTradesPerMonth: expectedTradesPerMonth,
        expectedMonthlyProfit: expectedMonthlyProfit,
        capitalNeededForIncome: capitalNeededForIncome
      },
      warnings: warnings,
      monteCarlo: monteCarlo
    };
  }

  function runMonteCarloMonthly(args) {
    var completedTrades        = args.completedTrades || [];
    var suggestedPosition      = Number(args.suggestedPosition) || 0;
    var expectedTradesPerMonth = Number(args.expectedTradesPerMonth) || 0;
    var desiredMonthlyIncome   = Number(args.desiredMonthlyIncome) || 0;
    var runs                   = Number(args.runs) || 10000;

    var pnlValues = completedTrades
      .map(function (t) { return t.profitPct / 100; })
      .filter(function (v) { return typeof v === 'number' && !Number.isNaN(v); });

    if (!pnlValues.length || suggestedPosition <= 0) {
      return {
        runs: 0,
        tradesPerMonth: 0,
        monthlyResults: [],
        probabilityPositiveMonth: 0,
        probabilityReachIncomeTarget: 0,
        p5: 0, median: 0, p95: 0, worst: 0, best: 0
      };
    }

    var tradesPerMonth = Math.max(1, Math.round(expectedTradesPerMonth || 1));
    var monthlyResults = new Array(runs);
    for (var i = 0; i < runs; i++) {
      var monthlyProfit = 0;
      for (var j = 0; j < tradesPerMonth; j++) {
        var sample = pnlValues[Math.floor(Math.random() * pnlValues.length)];
        monthlyProfit += suggestedPosition * sample;
      }
      monthlyResults[i] = monthlyProfit;
    }

    // Build sorted copy for percentiles but keep originals for charting.
    var sorted = monthlyResults.slice().sort(function (a, b) { return a - b; });
    function percentile(p) {
      var idx = Math.floor((p / 100) * (sorted.length - 1));
      return sorted[idx];
    }

    var positiveCount = 0, targetCount = 0;
    for (var k = 0; k < monthlyResults.length; k++) {
      if (monthlyResults[k] > 0) positiveCount++;
      if (monthlyResults[k] >= desiredMonthlyIncome) targetCount++;
    }

    return {
      runs: runs,
      tradesPerMonth: tradesPerMonth,
      monthlyResults: monthlyResults,
      probabilityPositiveMonth: positiveCount / runs,
      probabilityReachIncomeTarget: targetCount / runs,
      p5: percentile(5),
      median: percentile(50),
      p95: percentile(95),
      worst: sorted[0],
      best: sorted[sorted.length - 1]
    };
  }

  function formatCurrency(value) {
    if (value === null || value === undefined || Number.isNaN(value) || !isFinite(value)) return 'N/A';
    try {
      return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    } catch (e) {
      return '$' + Math.round(value).toLocaleString();
    }
  }
  function formatPercent(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value) || !isFinite(value)) return 'N/A';
    if (digits == null) digits = 2;
    return (value * 100).toFixed(digits) + '%';
  }

  // ---- Built-in self-test (run via window.BTInvestmentPlanner.selfTest()) ----
  function selfTest() {
    // Build synthetic trades: 6 wins of +1%, 4 losses of -0.5%, all on
    // distinct dates so testedTradingDays = 10.
    var trades = [];
    for (var i = 0; i < 6; i++) trades.push({ date: '2026-01-' + (i + 1), tradeType: 'up',   profitPct: 1.0 });
    for (var j = 0; j < 4; j++) trades.push({ date: '2026-01-' + (10 + j), tradeType: 'down', profitPct: -0.5 });
    var r = analyze(trades, {
      accountSize: 100000, desiredMonthlyIncome: 1000,
      maxRiskPerTradePct: 1, maxCapitalPerTradePct: 50,
      expectedTradingDaysPerMonth: 21, monteCarloRuns: 200
    });
    var results = [];
    function ok(name, cond, detail) { results.push({ name: name, ok: !!cond, detail: cond ? '' : (detail || '') }); }
    // winRate = 6/10 = 0.6
    ok('winRate=0.6', Math.abs(r.stats.winRate - 0.6) < 1e-9, 'got ' + r.stats.winRate);
    // expectancyPct = 0.6*0.01 - 0.4*0.005 = 0.006 - 0.002 = 0.004
    ok('expectancyPct=0.004', Math.abs(r.stats.expectancyPct - 0.004) < 1e-9, 'got ' + r.stats.expectancyPct);
    // riskDollars = 1000
    ok('riskDollars=1000', Math.abs(r.stats.riskDollars - 1000) < 1e-9, 'got ' + r.stats.riskDollars);
    // worstLossPct = 0.005 → positionByRisk = 1000/0.005 = 200,000 → capped by positionByCap = 50,000
    ok('suggestedPosition=50000', Math.abs(r.stats.suggestedPosition - 50000) < 1e-9, 'got ' + r.stats.suggestedPosition);
    // expectedProfitPerTrade = 50000 * 0.004 = 200
    ok('expectedProfitPerTrade=200', Math.abs(r.stats.expectedProfitPerTrade - 200) < 1e-9, 'got ' + r.stats.expectedProfitPerTrade);
    // expectedTradesPerMonth = 10/10 * 21 = 21
    ok('expectedTradesPerMonth=21', Math.abs(r.stats.expectedTradesPerMonth - 21) < 1e-9, 'got ' + r.stats.expectedTradesPerMonth);
    // expectedMonthlyProfit = 200 * 21 = 4200
    ok('expectedMonthlyProfit=4200', Math.abs(r.stats.expectedMonthlyProfit - 4200) < 1e-9, 'got ' + r.stats.expectedMonthlyProfit);
    // capitalNeededForIncome = 1000 / (0.004 * 21) ≈ 11904.76
    ok('capitalNeededForIncome≈11904.76', Math.abs(r.stats.capitalNeededForIncome - (1000 / (0.004 * 21))) < 1e-6, 'got ' + r.stats.capitalNeededForIncome);
    // Concentration warning expected (50% trigger is strictly >, so 50000 is at the boundary — not greater than — so we don't expect that warning).
    ok('no negative-expectancy warning', r.warnings.indexOf('This strategy has negative expectancy. Do not size up.') === -1);
    // Negative expectancy test
    var neg = analyze([
      { date: '2026-02-01', tradeType: 'up', profitPct: 0.5 },
      { date: '2026-02-02', tradeType: 'down', profitPct: -2 },
      { date: '2026-02-03', tradeType: 'down', profitPct: -2 }
    ], { accountSize: 100000, monteCarloRuns: 50 });
    ok('negative expectancy flagged', neg.warnings.indexOf('This strategy has negative expectancy. Do not size up.') !== -1);
    // Percent math sanity: 0.35% gain on $100,000 = $350
    var pmTrades = [];
    for (var p = 0; p < 100; p++) pmTrades.push({ date: '2026-03-' + (p + 1), tradeType: 'up', profitPct: 0.35 });
    var pm = analyze(pmTrades, { accountSize: 100000, maxRiskPerTradePct: 1, maxCapitalPerTradePct: 100, monteCarloRuns: 50 });
    // suggestedPosition limited by capital cap = 100000 (since no losses, lossSizingPct = 0 → fallback to capital cap)
    // expectedProfitPerTrade = 100000 * 0.0035 = 350
    ok('0.35% on $100k = $350', Math.abs(pm.stats.expectedProfitPerTrade - 350) < 1e-9, 'got ' + pm.stats.expectedProfitPerTrade);

    var failed = results.filter(function (r) { return !r.ok; }).length;
    return { passed: results.length - failed, failed: failed, results: results };
  }

  var api = {
    analyze: analyze,
    runMonteCarloMonthly: runMonteCarloMonthly,
    formatCurrency: formatCurrency,
    formatPercent: formatPercent,
    selfTest: selfTest
  };
  if (typeof window !== 'undefined') window.BTInvestmentPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
