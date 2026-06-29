/* Strategy Lab — page controller
 * --------------------------------------------------------------------
 * Beginner notes:
 *   - Each tab has its own boot function (bootEngine, bootOptimizer,
 *     bootHeatmap, …). They share state via the `state` object below.
 *   - Strategy math is ALWAYS BTEngine (main thread) or worker
 *     (which also importScripts the engine). Never compute strategy
 *     logic in this file.
 *   - To swap mock data for live data, set POLYGON_API_KEY on the server.
 *     No code changes needed.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var $  = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ---------- Shared state ----------
  var state = {
    engineResult: null,      // { summaries, trades, settings, candlesByTicker }
    optimizerResult: null,   // { rows, settings, candlesByTicker }
    compareResult: null,     // { byTicker:{AMD:{best, trades}}, settings, candlesByTicker }
    engineHealthy: false,
    worker: null,            // active optimizer worker
    workerSupported: (typeof Worker !== 'undefined'),
    user: null
  };

  // Exposed for charts & replay to call back into the page (e.g. heatmap clicks).
  window.BTLab = {
    onHeatmapClick: applyHeatmapClick,
    onReplayTick:   function (pos, total) {
      $('#bt-rp-pos').textContent = pos + ' / ' + total;
      $('#bt-rp-scrub').value = pos;
      updateNarrative(pos);
    }
  };

  // ===================================================================
  // BOOT
  // ===================================================================
  FinanceAuth.requireAuth(function (user) {
    state.user = user;
    // Header chrome (sidebar, account dropdown w/ Google photo, footer year,
    // how-to + legal modals). Lives in js/bt-header.js so the same wiring
    // can be lifted into other pages later (dashboard.html, future workspace).
    if (window.BTHeader && BTHeader.init) BTHeader.init(user);

    // 1) Engine self-test
    var test = BTEngine.selfTest();
    if (test.failed === 0) {
      state.engineHealthy = true;
      console.log('[BTEngine] selfTest passed (' + test.passed + ' checks).');
    } else {
      console.error('[BTEngine] selfTest FAILED:', test.results);
      showError('Engine self-test failed — disabling Run buttons. ' +
        test.results.filter(function (r) { return !r.ok; })
                    .map(function (r) { return r.name + ': ' + r.detail; }).join(' | '));
      $$('#bt-run, #bt-opt-run, #bt-cmp-run, #bt-mc-run, #bt-ai-rec-run, #bt-ai-sb-run, #bt-ip-run, #bt-sq-run, #bt-tf-run')
        .forEach(function (b) { b.disabled = true; });
      return;
    }

    // 2) Wire tabs + every tab's boot
    bootTabs();
    bootChips();
    bootEngine();
    bootOptimizer();
    bootHeatmap();
    bootCharts();
    bootReplay();
    bootCompare();
    bootMonteCarlo();
    bootInvestmentPlanner();
    bootSignalQuality();
    bootExperiments();
    bootAI();
    if (!state.workerSupported) {
      $('#bt-opt-fallback').style.display = '';
    }

    // Console hooks
    window.BTEngine = BTEngine;
    window.BTLabState = state;
  });

  // ===================================================================
  // TABS
  // ===================================================================
  function bootTabs() {
    $$('.tabbar button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        $$('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
        if (name === 'heatmap')     refreshHeatmap();
        if (name === 'charts')      refreshChartsTab();
        if (name === 'replay')      refreshReplayTab();
        if (name === 'planner')     refreshInvestmentPlannerTab();
        if (name === 'signal')      refreshSignalQualityTab();
        if (name === 'experiments') refreshExperimentsTab();
        if (name === 'montecarlo')  /* render on demand */;
      });
    });
  }

  // ===================================================================
  // CHIP MULTI-SELECT (used by Engine targets/stops, Optimizer axes, Compare tickers)
  // ===================================================================
  function bootChips() {
    // Engine targets
    initChips('#bt-targets', '0.5,1', 'pct');
    initChips('#bt-stops',   '',      'pct-or-none');
    $('#bt-target-add').addEventListener('click', function () { addChipFromInput('#bt-targets', '#bt-target-input'); });
    $('#bt-stop-add').addEventListener('click',   function () { addChipFromInput('#bt-stops',   '#bt-stop-input'); });

    // Optimizer axes
    ['#bt-opt-firsthour', '#bt-opt-dip', '#bt-opt-target', '#bt-opt-stop'].forEach(function (sel) {
      var host = $(sel);
      var values = host.getAttribute('data-values').split(',');
      var defaults = host.getAttribute('data-default').split(',');
      values.forEach(function (v) {
        var on = defaults.indexOf(v) !== -1;
        host.appendChild(makeChip(v, on, function () { updateComboCount(); }));
      });
    });

    // Compare tickers
    var cmpHost = $('#bt-cmp-tickers');
    cmpHost.getAttribute('data-default').split(',').forEach(function (t) {
      cmpHost.appendChild(makeChip(t.toUpperCase(), true));
    });
    $('#bt-cmp-add').addEventListener('click', function () {
      var raw = ($('#bt-cmp-input').value || '').toUpperCase().trim();
      if (!raw || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(raw)) return;
      if ($$('#bt-cmp-tickers .bt-chip').some(function (c) { return c.dataset.val === raw; })) return;
      cmpHost.appendChild(makeChip(raw, true));
      $('#bt-cmp-input').value = '';
    });

    updateComboCount();
  }

  function initChips(sel, defaults, mode) {
    var host = $(sel);
    var attr = host.getAttribute('data-default') || defaults;
    if (attr) {
      attr.split(',').filter(Boolean).forEach(function (v) {
        host.appendChild(makeChip(v, true));
      });
    }
  }
  function addChipFromInput(hostSel, inputSel) {
    var raw = ($(inputSel).value || '').trim();
    if (!raw) return;
    var n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) return;
    var host = $(hostSel);
    var val = n.toString();
    if ($$(hostSel + ' .bt-chip').some(function (c) { return c.dataset.val === val; })) return;
    host.appendChild(makeChip(val, true));
    $(inputSel).value = '';
  }
  function makeChip(value, on, onChange) {
    var chip = document.createElement('span');
    chip.className = 'bt-chip' + (on ? ' on' : '');
    chip.dataset.val = value;
    chip.innerHTML = '<span>' + escapeHtml(String(value)) + '</span><i class="fa-solid fa-times bt-chip-remove" title="Remove"></i>';
    chip.addEventListener('click', function (e) {
      if (e.target.classList.contains('bt-chip-remove')) {
        chip.remove();
      } else {
        chip.classList.toggle('on');
      }
      if (onChange) onChange();
    });
    return chip;
  }
  function chipsOn(sel) {
    return $$(sel + ' .bt-chip.on').map(function (c) { return c.dataset.val; });
  }

  // ===================================================================
  // DATA LAYER (shared by every tab that needs candles)
  // ===================================================================
  var candleCache = {}; // key 'AMD|60d|5m' -> candles

  function fetchCandles(ticker, period, interval) {
    var key = ticker + '|' + period + '|' + interval;
    if (candleCache[key]) return Promise.resolve(candleCache[key]);

    var url = '/api/bars?ticker=' + encodeURIComponent(ticker) +
              '&period='   + encodeURIComponent(period) +
              '&interval=' + encodeURIComponent(interval);

    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 503) {
          return r.json().then(function (j) {
            setMockBanner(true, j && j.error);
            return { mock: true };
          });
        }
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error((j && j.error) || ('HTTP ' + r.status));
          });
        }
        return r.json();
      })
      .then(function (json) {
        if (json && json.mock) return generateMockCandles(ticker, period, interval);
        if (!json || !Array.isArray(json.candles)) throw new Error('bad bars response');
        setMockBanner(false);
        return json.candles;
      })
      .catch(function (err) {
        console.warn('[bars] fetch failed for ' + ticker + ', using mock:', err && err.message);
        setMockBanner(true, err && err.message);
        return generateMockCandles(ticker, period, interval);
      })
      .then(function (candles) {
        candleCache[key] = candles;
        return candles;
      });
  }
  function setMockBanner(on, reason) {
    var el = document.getElementById('bt-mock-banner');
    if (!el) return;
    el.style.display = on ? '' : 'none';
    var hint = el.querySelector('[data-reason]');
    if (hint) hint.textContent = (on && reason) ? ' (' + reason + ')' : '';
  }

  // ===================================================================
  // HERO CARD — premium overview at top of Strategy Lab
  // -------------------------------------------------------------------
  // Hero responsibilities:
  //   1. Surface current research context (tickers, strategy, preset, range)
  //      as chips so users always know what's being tested before they run.
  //   2. Provide a primary Run CTA that mirrors the Engine "Run" button.
  //   3. Show quick stats after a backtest finishes.
  //
  // LONG-TERM NOTE: Hero element IDs live in backtester.html. If you add
  // a new chip, edit updateHeroChips() below + add the markup once.
  // If a chip's underlying value is missing, the chip hides itself \u2014
  // the layout uses flex-wrap so empty positions don't leave gaps.
  // ===================================================================
  function bootHero() {
    var cta = document.getElementById('bt-hero-run');
    if (cta) cta.addEventListener('click', runEngine);

    // Refresh hero chips whenever the user changes a relevant Engine field.
    // We listen on 'input' + 'change' so number/text/select all behave.
    var watch = ['#bt-tickers', '#bt-trend', '#bt-dip', '#bt-targets',
                 '#bt-stops', '#bt-slippage', '#bt-interval', '#bt-period'];
    watch.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (!el) return;
      el.addEventListener('input',  updateHeroChips);
      el.addEventListener('change', updateHeroChips);
    });
    updateHeroChips();
  }

  function updateHeroChips() {
    // Tickers chip \u2014 condense to first 3 + count if long.
    var tickEl  = document.getElementById('bt-tickers');
    var tickers = tickEl ? tickEl.value.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean) : [];
    setChip('bt-hero-tickers', tickers.length
      ? (tickers.length > 4
          ? tickers.slice(0, 3).join(', ') + ' +' + (tickers.length - 3) + ' more'
          : tickers.join(', '))
      : '');

    // Strategy name \u2014 hardcoded for now; preset/experiment systems will set
    // this in Phase 3+. Keeping a label so the chip never reads as blank.
    setChip('bt-hero-strategy', 'First-hour trend');

    // Preset chip \u2014 placeholder until Phase 3 (strategy presets) lands.
    setChip('bt-hero-preset', 'Default');

    // Date range chip \u2014 mirrors the Engine "Lookback" select.
    var periodEl = document.getElementById('bt-period');
    var periodLabel = periodEl && periodEl.options[periodEl.selectedIndex]
      ? periodEl.options[periodEl.selectedIndex].text : '';
    setChip('bt-hero-range', periodLabel || '');
  }

  // Helper: set a chip's value and hide the entire chip if value is empty.
  function setChip(valId, val) {
    var el = document.getElementById(valId);
    if (!el) return;
    el.textContent = val || '\u2014';
    var chip = el.closest('.hero-chip');
    if (chip) chip.style.display = val ? '' : 'none';
  }

  // Render the quick-stats row after a backtest run.
  function renderHeroStats() {
    var box = document.getElementById('bt-hero-stats');
    if (!box || !state.engineResult) return;
    var trades = state.engineResult.trades || [];
    var realized = trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; });
    if (!realized.length) { box.style.display = 'none'; return; }

    var wins = realized.filter(function (t) { return t.profitPct > 0; }).length;
    var winRate = (wins / realized.length) * 100;
    var totalPL = realized.reduce(function (a, t) { return a + (t.profitPct || 0); }, 0);

    // Quick max-drawdown on the equity curve of cumulative %.
    var equity = 0, peak = 0, dd = 0;
    realized.forEach(function (t) {
      equity += t.profitPct;
      if (equity > peak) peak = equity;
      var cur = peak - equity;
      if (cur > dd) dd = cur;
    });

    document.getElementById('bt-hero-stat-trades').textContent = realized.length.toLocaleString();
    document.getElementById('bt-hero-stat-win').textContent    = winRate.toFixed(1) + '%';
    document.getElementById('bt-hero-stat-pl').textContent     = (totalPL >= 0 ? '+' : '') + totalPL.toFixed(2) + '%';
    document.getElementById('bt-hero-stat-dd').textContent     = '-' + dd.toFixed(2) + '%';
    box.style.display = '';
  }

  // ===================================================================
  // ENGINE TAB — Phase A/C
  // ===================================================================
  function bootEngine() {
    $('#bt-run').addEventListener('click', runEngine);
    // Hero card: keep chips in sync when the user changes any Engine
    // form field, and run the backtest when the hero CTA is clicked.
    // The hero is the single source of truth users glance at, so we
    // refresh it on every relevant input change.
    bootHero();
    ['#bt-filter-ticker', '#bt-filter-target', '#bt-filter-stop', '#bt-filter-type'].forEach(function (s) {
      $(s).addEventListener('change', renderTrades);
    });
    $('#bt-export-csv').addEventListener('click', exportTradesCSV);
  }

  function readEngineSettings() {
    var raw = $('#bt-tickers').value || '';
    var tickers = raw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    var trendWindowMin = Math.max(5, parseInt($('#bt-trend-window').value, 10) || 60);
    var dipPct         = Math.max(0.1, parseFloat($('#bt-dip').value)         || 3);
    var targets = chipsOn('#bt-targets').map(parseFloat).filter(function (n) { return isFinite(n) && n > 0; });
    var stops   = chipsOn('#bt-stops').map(function (v) { return v === 'none' ? null : parseFloat(v); })
                                      .filter(function (n) { return n === null || (isFinite(n) && n > 0); });
    if (!stops.length) stops = [null]; // 'no stop loss' run by default
    var slippageBps = Math.max(0, parseFloat($('#bt-slippage').value) || 0);
    var interval = $('#bt-interval').value || '5m';
    var period   = $('#bt-period').value   || '60d';
    var intervalMin = parseInt(interval, 10) || 5;

    if (!tickers.length) throw new Error('Please enter at least one ticker.');
    if (!targets.length) throw new Error('Please add at least one profit target.');
    return { tickers: tickers, trendWindowMin: trendWindowMin, dipPct: dipPct,
             targets: targets, stops: stops, slippageBps: slippageBps,
             interval: interval, intervalMin: intervalMin, period: period };
  }

  function runEngine() {
    if (!state.engineHealthy) return;
    showError('');
    var settings;
    try { settings = readEngineSettings(); }
    catch (e) { showError(e.message); return; }

    setLoading(true);
    $('#bt-run').disabled = true;

    Promise.all(settings.tickers.map(function (t) {
      return fetchCandles(t, settings.period, settings.interval)
        .then(function (c) { return { ticker: t, candles: c }; });
    })).then(function (datasets) {
      var summaries = [], trades = [], candlesByTicker = {};
      datasets.forEach(function (ds) {
        candlesByTicker[ds.ticker] = ds.candles;
        settings.targets.forEach(function (targetPct) {
          settings.stops.forEach(function (stopPct) {
            var r = BTEngine.runSeries(ds.candles, {
              ticker: ds.ticker, trendWindowMin: settings.trendWindowMin,
              dipPct: settings.dipPct, targetPct: targetPct, stopPct: stopPct,
              slippageBps: settings.slippageBps, intervalMin: settings.intervalMin
            });
            summaries.push(r.summary);
            trades.push.apply(trades, r.trades);
          });
        });
      });
      state.engineResult = { summaries: summaries, trades: trades, settings: settings, candlesByTicker: candlesByTicker };
      populateEngineFilters();
      renderSummary();
      renderTrades();
      renderHeroStats();
      $('#bt-export-csv').disabled = trades.length === 0;
      // Keep Investment Planner selectors in sync so the user can size up immediately.
      refreshInvestmentPlannerTab();
    }).catch(function (err) {
      console.error('Engine run failed:', err);
      showError('Engine run failed: ' + (err.message || err));
    }).then(function () {
      setLoading(false);
      $('#bt-run').disabled = false;
    });
  }

  function populateEngineFilters() {
    var s = state.engineResult.summaries;
    fillSelect('#bt-filter-ticker', uniq(s.map(function (r) { return r.ticker; })), 'All');
    fillSelect('#bt-filter-target', uniq(s.map(function (r) { return String(r.targetPct); })), 'All');
    fillSelect('#bt-filter-stop',   uniq(s.map(function (r) { return r.stopPct == null ? 'none' : String(r.stopPct); })), 'All');
  }

  function renderSummary() {
    var body = $('#bt-summary-body'), empty = $('#bt-summary-empty');
    body.innerHTML = '';
    if (!state.engineResult || !state.engineResult.summaries.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    state.engineResult.summaries.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        td(s.ticker, 'sym') +
        tdNum(fmtPct(s.targetPct)) +
        tdNum(s.stopPct == null ? '—' : fmtPct(s.stopPct)) +
        tdNum(s.totalDays) + tdNum(s.tradesTaken) + tdNum(s.noTradeDays) +
        tdNum(s.wins) + tdNum(s.losses) + tdNum(fmtPct(s.winRate)) +
        tdNum(plCell(s.avgPL)) + tdNum(plCell(s.totalPL)) +
        tdNum(isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞') +
        tdNum(s.bestDay  ? s.bestDay.date  + ' ' + plCell(s.bestDay.plPct)  : '—') +
        tdNum(s.worstDay ? s.worstDay.date + ' ' + plCell(s.worstDay.plPct) : '—') +
        tdNum(fmtMinutes(s.avgHoldingMin)) +
        tdNum(plCell(s.avgMFE)) + tdNum(plCell(s.avgMAE)) +
        tdNum(plCell(s.maxDrawdown));
      body.appendChild(tr);
    });
  }

  function renderTrades() {
    var body = $('#bt-trades-body'), empty = $('#bt-trades-empty');
    body.innerHTML = '';
    if (!state.engineResult || !state.engineResult.trades.length) { empty.style.display = ''; return; }

    var ft = $('#bt-filter-ticker').value, fg = $('#bt-filter-target').value;
    var fs = $('#bt-filter-stop').value,   fy = $('#bt-filter-type').value;
    var rows = state.engineResult.trades.filter(function (t) {
      if (ft && t.ticker !== ft) return false;
      if (fg && String(t.targetPct) !== fg) return false;
      if (fs && (t.stopPct == null ? 'none' : String(t.stopPct)) !== fs) return false;
      if (fy && t.tradeType !== fy) return false;
      return true;
    });
    if (!rows.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    rows.forEach(function (t) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        td(t.date) + td(t.ticker, 'sym') +
        tdNum(fmtPct(t.targetPct)) +
        tdNum(t.stopPct == null ? '—' : fmtPct(t.stopPct)) +
        td(typePill(t.tradeType)) +
        tdNum(money(t.open))  + tdNum(money(t.high)) + tdNum(money(t.low)) + tdNum(money(t.close)) +
        tdNum(money(t.firstHourClose)) +
        tdNum(t.buyPrice  != null ? money(t.buyPrice)  : '—') +
        tdNum(t.sellPrice != null ? money(t.sellPrice) : '—') +
        tdNum(t.profitPct != null ? plCell(t.profitPct) : '—') +
        tdNum(fmtMinutes(t.holdingMinutes)) +
        tdNum(t.tradeType !== 'none' ? plCell(t.maxUnrealizedGainPct) : '—') +
        tdNum(t.tradeType !== 'none' ? plCell(t.maxUnrealizedLossPct) : '—') +
        td(exitPill(t.exitReason)) +
        td(t.tradeType === 'none' ? '<span class="bt-pill bt-pill-none">N/A</span>'
                                  : (t.targetHit ? '<span class="bt-pill bt-pill-up">true</span>'
                                                 : '<span class="bt-pill bt-pill-down">false</span>'));
      body.appendChild(tr);
    });
  }

  function exportTradesCSV() {
    if (!state.engineResult || !state.engineResult.trades.length) return;
    var headers = ['date','ticker','targetPct','stopPct','slippageBps','intervalMin',
                   'open','high','low','close','firstHourClose','trend','tradeType',
                   'rawBuyPrice','buyPrice','rawSellPrice','sellPrice','profitPct',
                   'holdingBars','holdingMinutes','entryTime','exitTime',
                   'targetHit','stopHit','exitReason',
                   'maxUnrealizedGainPct','maxUnrealizedLossPct'];
    // PHASE 1: every CSV export starts with a disclaimer comment row so
    // the file stays clearly labelled even after it leaves the app.
    // Keep this header in sync with the footer + tab asides + legal modals.
    var rows = csvDisclaimerHeader('Strategy Lab — trade detail');
    rows.push(headers.join(','));
    state.engineResult.trades.forEach(function (t) {
      rows.push(headers.map(function (h) {
        var v = t[h];
        if (v == null) return '';
        if (typeof v === 'string') return '"' + v.replace(/"/g, '""') + '"';
        return v;
      }).join(','));
    });
    var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'strategy-lab-trades.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  // -------------------------------------------------------------------
  // CSV disclaimer header — shared by every export in this app.
  // Returns an array of comment-prefixed lines you concat onto `rows`.
  // Reason: a single source of truth keeps the disclaimer text in sync
  // with the footer / tab asides / legal modals. To change wording,
  // edit DISCLAIMER below. Do NOT re-implement this inline.
  // -------------------------------------------------------------------
  var CSV_DISCLAIMER =
    'Research and simulation only. Backtested results do not guarantee ' +
    'future performance. This is not financial advice. ' +
    'Generated by Career Solutions for Today — Strategy Lab.';
  function csvDisclaimerHeader(kind) {
    var when = new Date().toISOString();
    return [
      '# ' + CSV_DISCLAIMER,
      '# Export: ' + (kind || 'Strategy Lab data') + '. Generated: ' + when
    ];
  }
  // Make available to other modules (backtester-experiments.js exportCsv).
  window.BTCsvHeader = csvDisclaimerHeader;

  // ===================================================================
  // OPTIMIZER TAB — Phase D
  // ===================================================================
  function bootOptimizer() {
    $('#bt-opt-run').addEventListener('click', runOptimizer);
    $('#bt-opt-cancel').addEventListener('click', cancelOptimizer);

    // Re-count combinations as the user toggles chips.
    $$('#bt-opt-firsthour, #bt-opt-dip, #bt-opt-target, #bt-opt-stop').forEach(function (host) {
      host.addEventListener('click', function () { setTimeout(updateComboCount, 0); });
    });

    // Header sorting on the optimizer results table.
    $$('#bt-opt-table thead th[data-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        if (!state.optimizerResult) return;
        var key = th.dataset.sort;
        var dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        th.dataset.dir = dir;
        state.optimizerResult.rows.sort(function (a, b) {
          var va = a[key], vb = b[key];
          if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          va = va == null ? -Infinity : va; vb = vb == null ? -Infinity : vb;
          return dir === 'asc' ? va - vb : vb - va;
        });
        renderOptimizerResults();
      });
    });
  }

  function readOptimizerGrid() {
    var firstHour = chipsOn('#bt-opt-firsthour').map(Number);
    var dip       = chipsOn('#bt-opt-dip').map(Number);
    var target    = chipsOn('#bt-opt-target').map(Number);
    var stop      = chipsOn('#bt-opt-stop').map(function (v) { return v === 'none' ? null : Number(v); });
    if (!firstHour.length || !dip.length || !target.length || !stop.length) {
      throw new Error('Pick at least one value on every axis.');
    }
    return { firstHour: firstHour, dip: dip, target: target, stop: stop };
  }

  function updateComboCount() {
    try {
      var grid = readOptimizerGrid();
      var n = grid.firstHour.length * grid.dip.length * grid.target.length * grid.stop.length;
      var tickers = ($('#bt-opt-tickers').value || '').split(',').filter(function (s) { return s.trim(); }).length;
      $('#bt-opt-combo-count').textContent = 'Combinations to test: ' + (n * tickers) +
        '  (' + n + ' × ' + tickers + ' ticker' + (tickers === 1 ? '' : 's') + ')';
    } catch (e) {
      $('#bt-opt-combo-count').textContent = e.message;
    }
  }

  function runOptimizer() {
    showError('');
    var settings, grid;
    try {
      var raw = $('#bt-opt-tickers').value || '';
      var tickers = raw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
      if (!tickers.length) throw new Error('Please enter at least one ticker.');
      grid = readOptimizerGrid();
      settings = {
        tickers: tickers,
        slippageBps: Math.max(0, parseFloat($('#bt-opt-slippage').value) || 0),
        interval:    $('#bt-opt-interval').value || '5m',
        intervalMin: parseInt($('#bt-opt-interval').value, 10) || 5,
        period:      $('#bt-opt-period').value || '60d'
      };
    } catch (e) { showError(e.message); return; }

    $('#bt-opt-run').disabled = true;
    $('#bt-opt-cancel').disabled = false;
    $('#bt-opt-progress-row').style.display = '';
    updateProgress(0, 1, '');

    Promise.all(settings.tickers.map(function (t) {
      return fetchCandles(t, settings.period, settings.interval)
        .then(function (c) { return { ticker: t, candles: c }; });
    })).then(function (datasets) {
      var candlesByTicker = {};
      datasets.forEach(function (ds) { candlesByTicker[ds.ticker] = ds.candles; });

      var jobId = String(Date.now());
      var payload = { cmd: 'run', jobId: jobId, candlesByTicker: candlesByTicker, grid: grid,
                      options: { slippageBps: settings.slippageBps, intervalMin: settings.intervalMin } };

      if (state.workerSupported) runInWorker(payload, settings, candlesByTicker);
      else                       runOnMainThread(payload, settings, candlesByTicker);
    }).catch(function (err) {
      showError('Optimizer load failed: ' + (err.message || err));
      $('#bt-opt-run').disabled = false;
      $('#bt-opt-cancel').disabled = true;
    });
  }

  function runInWorker(payload, settings, candlesByTicker) {
    try {
      if (state.worker) { try { state.worker.terminate(); } catch (e) {} }
      state.worker = new Worker('js/backtester-worker.js');
    } catch (e) {
      console.warn('Worker construction failed, falling back:', e);
      $('#bt-opt-fallback').style.display = '';
      state.workerSupported = false;
      runOnMainThread(payload, settings, candlesByTicker);
      return;
    }

    state.worker.onmessage = function (e) {
      var m = e.data;
      if (!m) return;
      if (m.type === 'progress') {
        updateProgress(m.done, m.total, m.ticker || '');
      } else if (m.type === 'done') {
        finishOptimizer(m.rows, settings, candlesByTicker);
      } else if (m.type === 'error') {
        showError('Optimizer error: ' + m.message);
        finishOptimizer([], settings, candlesByTicker);
      }
    };
    state.worker.onerror = function (e) {
      showError('Optimizer worker error: ' + e.message);
      finishOptimizer([], settings, candlesByTicker);
    };
    state.worker.postMessage(payload);
  }

  function runOnMainThread(payload, settings, candlesByTicker) {
    // Same logic as the worker, but inline. Tiny grids only.
    var grid = payload.grid;
    var tickers = Object.keys(candlesByTicker);
    var total = tickers.length * grid.firstHour.length * grid.dip.length * grid.target.length * grid.stop.length;
    var done = 0;
    var rows = [];

    function step(i) {
      var batchEnd = Math.min(i + 50, total);
      for (var k = i; k < batchEnd; k++) {
        var idx = k;
        var s  = grid.stop.length;
        var g  = grid.target.length;
        var d  = grid.dip.length;
        var fh = grid.firstHour.length;
        var sI = idx % s; idx = (idx - sI) / s;
        var gI = idx % g; idx = (idx - gI) / g;
        var dI = idx % d; idx = (idx - dI) / d;
        var fI = idx % fh; idx = (idx - fI) / fh;
        var tI = idx;
        var ticker = tickers[tI];
        var r = BTEngine.runSeries(candlesByTicker[ticker], {
          ticker: ticker, trendWindowMin: grid.firstHour[fI], dipPct: grid.dip[dI],
          targetPct: grid.target[gI], stopPct: grid.stop[sI],
          slippageBps: payload.options.slippageBps, intervalMin: payload.options.intervalMin
        }).summary;
        rows.push({
          ticker: ticker, firstHourMin: grid.firstHour[fI], dipPct: grid.dip[dI],
          targetPct: grid.target[gI], stopPct: grid.stop[sI],
          tradesTaken: r.tradesTaken, winRate: r.winRate, totalPL: r.totalPL,
          avgPL: r.avgPL, profitFactor: r.profitFactor, expectancy: r.expectancy,
          maxDrawdown: r.maxDrawdown, sharpe: r.sharpe, avgHoldingMin: r.avgHoldingMin
        });
        done++;
      }
      updateProgress(done, total, tickers[Math.min(tickers.length - 1, Math.floor(done / (total / tickers.length)))] || '');
      if (done < total) setTimeout(function () { step(batchEnd); }, 0);
      else finishOptimizer(rows, settings, candlesByTicker);
    }
    step(0);
  }

  function cancelOptimizer() {
    if (state.worker) { try { state.worker.terminate(); } catch (e) {} state.worker = null; }
    $('#bt-opt-run').disabled = false;
    $('#bt-opt-cancel').disabled = true;
    $('#bt-opt-progress-row').style.display = 'none';
    showError('Optimizer cancelled.');
    setTimeout(function () { showError(''); }, 2500);
  }

  function updateProgress(done, total, ticker) {
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    $('#bt-opt-bar').style.width = pct + '%';
    $('#bt-opt-progress-text').textContent = pct + '%' + (ticker ? '  (' + ticker + ')' : '') + '  — ' + done + ' / ' + total;
    if ($('#bt-cmp-bar')) { $('#bt-cmp-bar').style.width = pct + '%'; $('#bt-cmp-progress-text').textContent = pct + '%'; }
  }

  function finishOptimizer(rows, settings, candlesByTicker) {
    $('#bt-opt-run').disabled = false;
    $('#bt-opt-cancel').disabled = true;
    state.optimizerResult = { rows: rows, settings: settings, candlesByTicker: candlesByTicker };
    // Default sort: totalPL desc
    rows.sort(function (a, b) { return (b.totalPL || -Infinity) - (a.totalPL || -Infinity); });
    renderOptimizerResults();
    renderBestPerTicker();
    populateHeatmapSelectors();
    // AI rec button enabled once we have data and we know AI is allowed.
    if (!window.BTAI || !window.BTAI.isDisabled()) $('#bt-ai-rec-run').disabled = false;
  }

  function renderOptimizerResults() {
    var body = $('#bt-opt-body'), empty = $('#bt-opt-empty');
    body.innerHTML = '';
    var rows = state.optimizerResult ? state.optimizerResult.rows : [];
    if (!rows.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    // Limit DOM to top 500 rows to keep things snappy.
    rows.slice(0, 500).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        td(r.ticker, 'sym') +
        tdNum(r.firstHourMin) + tdNum(fmtPct(r.dipPct)) + tdNum(fmtPct(r.targetPct)) +
        tdNum(r.stopPct == null ? '—' : fmtPct(r.stopPct)) +
        tdNum(r.tradesTaken) + tdNum(fmtPct(r.winRate)) +
        tdNum(plCell(r.totalPL)) + tdNum(plCell(r.avgPL)) +
        tdNum(isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞') +
        tdNum(r.expectancy.toFixed(3)) + tdNum(plCell(r.maxDrawdown)) +
        '<td><button class="btn btn-sm" data-apply="' + escapeAttr(JSON.stringify(r)) + '">Apply</button></td>';
      body.appendChild(tr);
    });
    $$('#bt-opt-body button[data-apply]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var r = JSON.parse(btn.dataset.apply);
        applyOptimizerRowToEngine(r);
      });
    });
  }

  function renderBestPerTicker() {
    var rows = state.optimizerResult.rows;
    var bestByT = {};
    rows.forEach(function (r) {
      var cur = bestByT[r.ticker];
      if (!cur || (r.totalPL || -Infinity) > (cur.totalPL || -Infinity)) bestByT[r.ticker] = r;
    });
    var tickers = Object.keys(bestByT);
    if (!tickers.length) { $('#bt-best-card').style.display = 'none'; return; }
    $('#bt-best-card').style.display = '';
    var html = '<div class="bt-chart-grid">';
    tickers.forEach(function (tk) {
      var r = bestByT[tk];
      html += '<div class="bt-kpi" style="grid-column: span 1;">' +
        '<div class="label">' + tk + ' — best</div>' +
        '<div class="value" style="font-size:14px; line-height:1.6;">' +
          '1h ' + r.firstHourMin + 'm · Dip ' + r.dipPct + '% · Tgt ' + r.targetPct + '% · Stop ' + (r.stopPct == null ? 'none' : r.stopPct + '%') +
        '</div>' +
        '<div style="margin-top:6px; font-size:12px;">' +
          'Trades ' + r.tradesTaken + ' · Win ' + r.winRate.toFixed(1) + '% · Total ' + plCell(r.totalPL) + ' · Max DD ' + plCell(r.maxDrawdown) +
        '</div>' +
        '<button class="btn btn-sm btn-primary" style="margin-top:8px;" data-apply-best="' + escapeAttr(JSON.stringify(r)) + '">Apply to Engine</button>' +
        '</div>';
    });
    html += '</div>';
    $('#bt-best-list').innerHTML = html;
    $$('#bt-best-list button[data-apply-best]').forEach(function (btn) {
      btn.addEventListener('click', function () { applyOptimizerRowToEngine(JSON.parse(btn.dataset.applyBest)); });
    });
  }

  function applyOptimizerRowToEngine(r) {
    $('#bt-tickers').value = r.ticker;
    $('#bt-trend-window').value = r.firstHourMin;
    $('#bt-dip').value = r.dipPct;
    // Replace target chips with a single chip.
    $('#bt-targets').innerHTML = '';
    $('#bt-targets').appendChild(makeChip(String(r.targetPct), true));
    // Replace stop chips with single value (or empty for none).
    $('#bt-stops').innerHTML = '';
    if (r.stopPct != null) $('#bt-stops').appendChild(makeChip(String(r.stopPct), true));
    // Switch to Engine tab and scroll up.
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'engine'); });
    $$('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-engine'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ===================================================================
  // HEATMAP TAB — Phase E
  // ===================================================================
  function bootHeatmap() {
    ['#bt-heat-ticker', '#bt-heat-metric', '#bt-heat-firsthour', '#bt-heat-stop'].forEach(function (s) {
      $(s).addEventListener('change', refreshHeatmap);
    });
  }
  function populateHeatmapSelectors() {
    var rows = state.optimizerResult ? state.optimizerResult.rows : [];
    if (!rows.length) return;
    fillSelect('#bt-heat-ticker',    uniq(rows.map(function (r) { return r.ticker; })));
    fillSelect('#bt-heat-firsthour', uniq(rows.map(function (r) { return String(r.firstHourMin); })));
    fillSelect('#bt-heat-stop',      uniq(rows.map(function (r) { return r.stopPct == null ? 'none' : String(r.stopPct); })));
    refreshHeatmap();
  }
  function refreshHeatmap() {
    var rows = state.optimizerResult ? state.optimizerResult.rows : [];
    var empty = $('#bt-heat-empty');
    var canvas = $('#bt-heat-canvas');
    if (!rows.length) { empty.style.display = ''; canvas.style.display = 'none'; return; }
    empty.style.display = 'none'; canvas.style.display = '';
    var ticker = $('#bt-heat-ticker').value;
    var metric = $('#bt-heat-metric').value;
    var fh     = Number($('#bt-heat-firsthour').value);
    var stopV  = $('#bt-heat-stop').value;
    var stopPct = stopV === 'none' ? null : Number(stopV);
    var filtered = rows.filter(function (r) {
      return r.ticker === ticker && r.firstHourMin === fh &&
             (r.stopPct == null ? 'none' : r.stopPct) === (stopPct == null ? 'none' : stopPct);
    });
    var dips    = uniq(filtered.map(function (r) { return r.dipPct; })).sort(function (a, b) { return a - b; });
    var targets = uniq(filtered.map(function (r) { return r.targetPct; })).sort(function (a, b) { return a - b; });
    BTCharts.heatmap('bt-heat-canvas', filtered, metric, { dips: dips, targets: targets });
  }
  function applyHeatmapClick(coord) {
    $('#bt-tickers').value = $('#bt-heat-ticker').value;
    $('#bt-trend-window').value = $('#bt-heat-firsthour').value;
    $('#bt-dip').value = coord.dipPct;
    $('#bt-targets').innerHTML = '';
    $('#bt-targets').appendChild(makeChip(String(coord.targetPct), true));
    var s = $('#bt-heat-stop').value;
    $('#bt-stops').innerHTML = '';
    if (s !== 'none') $('#bt-stops').appendChild(makeChip(s, true));
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'engine'); });
    $$('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-engine'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ===================================================================
  // CHARTS TAB — Phase F
  // ===================================================================
  function bootCharts() {
    ['#bt-ch-ticker', '#bt-ch-target', '#bt-ch-stop'].forEach(function (s) {
      $(s).addEventListener('change', renderCharts);
    });
  }
  function refreshChartsTab() {
    var r = state.engineResult;
    if (!r) { $('#bt-ch-empty').style.display = ''; $('#bt-ch-grid').style.display = 'none'; return; }
    var s = r.summaries;
    fillSelect('#bt-ch-ticker', uniq(s.map(function (x) { return x.ticker; })));
    fillSelect('#bt-ch-target', uniq(s.map(function (x) { return String(x.targetPct); })));
    fillSelect('#bt-ch-stop',   uniq(s.map(function (x) { return x.stopPct == null ? 'none' : String(x.stopPct); })));
    renderCharts();
  }
  function renderCharts() {
    if (!state.engineResult) return;
    var tk = $('#bt-ch-ticker').value, tgt = $('#bt-ch-target').value, st = $('#bt-ch-stop').value;
    var trades = state.engineResult.trades.filter(function (t) {
      if (tk && t.ticker !== tk) return false;
      if (tgt && String(t.targetPct) !== tgt) return false;
      if (st && (t.stopPct == null ? 'none' : String(t.stopPct)) !== st) return false;
      return true;
    });
    if (!trades.length) { $('#bt-ch-empty').style.display = ''; $('#bt-ch-grid').style.display = 'none'; return; }
    $('#bt-ch-empty').style.display = 'none'; $('#bt-ch-grid').style.display = '';
    BTCharts.equity('bt-ch-equity', trades);
    BTCharts.drawdown('bt-ch-drawdown', trades);
    BTCharts.monthly('bt-ch-monthly', trades);
    BTCharts.histogram('bt-ch-hist', trades);
    BTCharts.duration('bt-ch-duration', trades);
    BTCharts.calendar('bt-ch-calendar', trades);
  }

  // ===================================================================
  // REPLAY TAB — Phase G
  // ===================================================================
  var replayCtrl = null;
  function bootReplay() {
    $('#bt-rp-load').addEventListener('click', loadReplay);
    $('#bt-rp-play').addEventListener('click', function () {
      if (!replayCtrl) return;
      if (replayCtrl.isPlaying()) { replayCtrl.pause(); $('#bt-rp-play').innerHTML = '<i class="fa-solid fa-play"></i>'; }
      else { replayCtrl.play(); $('#bt-rp-play').innerHTML = '<i class="fa-solid fa-pause"></i>'; }
    });
    $('#bt-rp-reset').addEventListener('click', function () {
      if (replayCtrl) { replayCtrl.reset(); $('#bt-rp-play').innerHTML = '<i class="fa-solid fa-play"></i>'; }
    });
    $('#bt-rp-speed').addEventListener('change', function () { if (replayCtrl) replayCtrl.setSpeed($('#bt-rp-speed').value); });
    $('#bt-rp-scrub').addEventListener('input', function () { if (replayCtrl) { replayCtrl.pause(); replayCtrl.seek(Number($('#bt-rp-scrub').value)); $('#bt-rp-play').innerHTML = '<i class="fa-solid fa-play"></i>'; } });
    $('#bt-rp-ticker').addEventListener('change', refreshReplayDates);
  }
  function refreshReplayTab() {
    if (!state.engineResult) { $('#bt-rp-empty').style.display = ''; $('#bt-rp-grid').style.display = 'none'; return; }
    var s = state.engineResult.summaries;
    fillSelect('#bt-rp-ticker', uniq(s.map(function (x) { return x.ticker; })));
    fillSelect('#bt-rp-target', uniq(s.map(function (x) { return String(x.targetPct); })));
    fillSelect('#bt-rp-stop',   uniq(s.map(function (x) { return x.stopPct == null ? 'none' : String(x.stopPct); })));
    refreshReplayDates();
  }
  function refreshReplayDates() {
    if (!state.engineResult) return;
    var tk = $('#bt-rp-ticker').value;
    var dates = uniq(state.engineResult.trades.filter(function (t) { return t.ticker === tk; })
                                              .map(function (t) { return t.date; })).sort();
    fillSelect('#bt-rp-date', dates);
  }
  function loadReplay() {
    if (!state.engineResult) return;
    var tk = $('#bt-rp-ticker').value, date = $('#bt-rp-date').value;
    var tgt = Number($('#bt-rp-target').value);
    var stopV = $('#bt-rp-stop').value;
    var stopPct = stopV === 'none' ? null : Number(stopV);
    var trade = state.engineResult.trades.find(function (t) {
      return t.ticker === tk && t.date === date && t.targetPct === tgt &&
             (t.stopPct == null ? 'none' : t.stopPct) === (stopPct == null ? 'none' : stopPct);
    });
    var candles = state.engineResult.candlesByTicker[tk] || [];
    var dayBars = candles.filter(function (b) { return b.dateKey === date; });
    if (!dayBars.length) { showError('No bars available for ' + tk + ' on ' + date); return; }
    $('#bt-rp-empty').style.display = 'none';
    $('#bt-rp-grid').style.display = '';
    if (replayCtrl) replayCtrl.destroy();
    replayCtrl = BTReplay.load('bt-replay-chart', dayBars, trade);
    if (replayCtrl) {
      $('#bt-rp-scrub').max = replayCtrl.length();
      $('#bt-rp-scrub').value = 1;
      $('#bt-rp-pos').textContent = '1 / ' + replayCtrl.length();
      renderNarrative(trade);
    }
  }
  function renderNarrative(trade) {
    var el = $('#bt-rp-narrative');
    if (!trade || trade.tradeType === 'none') {
      el.innerHTML =
        '<div class="step">Open: ' + money(trade ? trade.open : null) + '</div>' +
        '<div class="step">Trend: ' + (trade ? trade.trend : '—') + '</div>' +
        '<div class="step">No trade taken (dip never reached).</div>';
      return;
    }
    el.innerHTML =
      '<div class="step" data-step="open">Open: ' + money(trade.open) + '</div>' +
      '<div class="step" data-step="trend">Trend: ' + trade.trend + (trade.trend === 'down' ? ' — waiting for ' + trade.dipPct + '% dip' : '') + '</div>' +
      '<div class="step" data-step="buy">Buy: ' + money(trade.buyPrice) + '</div>' +
      '<div class="step" data-step="sell">Sell: ' + money(trade.sellPrice) + ' (' + trade.exitReason + ')</div>' +
      '<div class="step" data-step="pl">P/L: ' + plCell(trade.profitPct) + '</div>';
  }
  function updateNarrative(visibleBars) {
    if (!state.engineResult) return;
    var tk = $('#bt-rp-ticker').value, date = $('#bt-rp-date').value;
    var candles = (state.engineResult.candlesByTicker[tk] || []).filter(function (b) { return b.dateKey === date; });
    if (!candles.length) return;
    var curT = candles[Math.min(candles.length - 1, visibleBars - 1)].t;
    var trade = state.engineResult.trades.find(function (t) {
      return t.ticker === tk && t.date === date && t.targetPct === Number($('#bt-rp-target').value);
    });
    if (!trade) return;
    $$('#bt-rp-narrative .step').forEach(function (el) {
      var s = el.dataset.step;
      el.classList.remove('active', 'done');
      if (s === 'open') el.classList.add('done');
      else if (s === 'trend' && curT >= candles[0].t + 60 * 60000) el.classList.add('done');
      else if (s === 'buy'  && trade.entryTime && curT >= trade.entryTime) el.classList.add('done');
      else if (s === 'sell' && trade.exitTime  && curT >= trade.exitTime)  el.classList.add('done');
      else if (s === 'pl'   && trade.exitTime  && curT >= trade.exitTime)  el.classList.add('done');
    });
  }

  // ===================================================================
  // COMPARE TAB — Phase H
  // ===================================================================
  function bootCompare() {
    $('#bt-cmp-run').addEventListener('click', runCompare);
  }
  function runCompare() {
    var tickers = chipsOn('#bt-cmp-tickers');
    if (!tickers.length) { showError('Add at least one ticker to compare.'); return; }
    showError('');
    $('#bt-cmp-run').disabled = true;
    $('#bt-cmp-progress-row').style.display = '';

    var period = '60d', interval = '5m', intervalMin = 5;
    var grid = { firstHour: [15,30,45,60], dip: [1,1.5,2,2.5,3,3.5,4],
                 target: [0.25,0.5,0.75,1,1.25,1.5,2], stop: [null,0.5,1,1.5,2,3] };

    Promise.all(tickers.map(function (t) {
      return fetchCandles(t, period, interval).then(function (c) { return { ticker: t, candles: c }; });
    })).then(function (datasets) {
      var candlesByTicker = {};
      datasets.forEach(function (ds) { candlesByTicker[ds.ticker] = ds.candles; });
      var payload = { cmd: 'run', jobId: 'cmp-' + Date.now(), candlesByTicker: candlesByTicker, grid: grid,
                      options: { slippageBps: 0, intervalMin: intervalMin } };

      function complete(rows) {
        $('#bt-cmp-run').disabled = false;
        $('#bt-cmp-progress-row').style.display = 'none';
        // Best per ticker
        var bestByT = {};
        rows.forEach(function (r) {
          var cur = bestByT[r.ticker];
          if (!cur || (r.totalPL || -Infinity) > (cur.totalPL || -Infinity)) bestByT[r.ticker] = r;
        });
        var body = $('#bt-cmp-body');
        body.innerHTML = '';
        var byTickerTrades = {};
        Object.keys(bestByT).forEach(function (tk) {
          var r = bestByT[tk];
          var run = BTEngine.runSeries(candlesByTicker[tk], {
            ticker: tk, trendWindowMin: r.firstHourMin, dipPct: r.dipPct,
            targetPct: r.targetPct, stopPct: r.stopPct,
            slippageBps: 0, intervalMin: intervalMin
          });
          byTickerTrades[tk] = run.trades;
          var tr = document.createElement('tr');
          tr.innerHTML =
            td(tk, 'sym') + tdNum(r.firstHourMin) + tdNum(fmtPct(r.dipPct)) +
            tdNum(fmtPct(r.targetPct)) + tdNum(r.stopPct == null ? '—' : fmtPct(r.stopPct)) +
            tdNum(r.tradesTaken) + tdNum(fmtPct(r.winRate)) +
            tdNum(plCell(r.totalPL)) + tdNum(plCell(r.avgPL)) + tdNum(plCell(r.maxDrawdown));
          body.appendChild(tr);
        });
        $('#bt-cmp-results-card').style.display = '';
        BTCharts.compareEquity('bt-cmp-equity', byTickerTrades);
        state.compareResult = { byTicker: byTickerTrades, bestByT: bestByT, candlesByTicker: candlesByTicker };
      }

      if (state.workerSupported) {
        try {
          var w = new Worker('js/backtester-worker.js');
          w.onmessage = function (e) {
            var m = e.data;
            if (m.type === 'progress') updateProgress(m.done, m.total, m.ticker || '');
            else if (m.type === 'done') { complete(m.rows); w.terminate(); }
            else if (m.type === 'error') { showError('Compare error: ' + m.message); complete([]); w.terminate(); }
          };
          w.postMessage(payload);
        } catch (e) {
          showError('Worker unavailable; running on main thread.');
          runOnMainThread(payload, { tickers: tickers, slippageBps: 0, interval: interval, intervalMin: intervalMin, period: period }, candlesByTicker);
          var origFinish = finishOptimizer;
          finishOptimizer = function (rows) { origFinish(rows, arguments[1], arguments[2]); finishOptimizer = origFinish; complete(rows); };
        }
      } else {
        // Reuse main-thread implementation, then complete.
        var settings = { tickers: tickers, slippageBps: 0, interval: interval, intervalMin: intervalMin, period: period };
        runOnMainThread(payload, settings, candlesByTicker);
        var orig = finishOptimizer;
        finishOptimizer = function (rows) { orig(rows, settings, candlesByTicker); finishOptimizer = orig; complete(rows); };
      }
    }).catch(function (err) {
      showError('Compare failed: ' + (err.message || err));
      $('#bt-cmp-run').disabled = false;
      $('#bt-cmp-progress-row').style.display = 'none';
    });
  }

  // ===================================================================
  // MONTE CARLO TAB — Phase I
  // ===================================================================
  function bootMonteCarlo() {
    $('#bt-mc-run').addEventListener('click', runMonteCarlo);
  }
  function runMonteCarlo() {
    showError('');
    var source = $('#bt-mc-source').value;
    var N = Math.max(100, parseInt($('#bt-mc-n').value, 10) || 10000);

    var pls = [];
    if (source === 'engine') {
      if (!state.engineResult) { showError('Run the Engine tab first.'); return; }
      pls = state.engineResult.trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; })
                                     .map(function (t) { return t.profitPct; });
    } else {
      if (!state.compareResult && !state.optimizerResult) { showError('Run the Compare or Optimizer tab first.'); return; }
      // Use Compare best-per-ticker trades if present, else best-per-ticker from optimizer.
      if (state.compareResult) {
        Object.keys(state.compareResult.byTicker).forEach(function (tk) {
          state.compareResult.byTicker[tk].forEach(function (t) {
            if (t.profitPct != null && t.tradeType !== 'none') pls.push(t.profitPct);
          });
        });
      }
    }
    if (!pls.length) { showError('No trades available for Monte Carlo.'); return; }
    var tradesPer = parseInt($('#bt-mc-trades').value, 10);
    if (!isFinite(tradesPer) || tradesPer <= 0) tradesPer = pls.length;

    var finalReturns = new Array(N);
    var sampledPaths = [];
    var capturePaths = 100;
    for (var i = 0; i < N; i++) {
      var sum = 0;
      var path = [];
      for (var j = 0; j < tradesPer; j++) {
        var r = pls[Math.floor(Math.random() * pls.length)];
        sum += r;
        if (i < capturePaths) path.push(sum);
      }
      finalReturns[i] = sum;
      if (i < capturePaths) sampledPaths.push(path);
    }

    var sorted = finalReturns.slice().sort(function (a, b) { return a - b; });
    var pPos = finalReturns.filter(function (x) { return x > 0; }).length / N;
    var pNeg = finalReturns.filter(function (x) { return x < 0; }).length / N;
    var mean = finalReturns.reduce(function (s, x) { return s + x; }, 0) / N;
    var p05 = sorted[Math.floor(0.05 * N)];
    var p50 = sorted[Math.floor(0.50 * N)];
    var p95 = sorted[Math.floor(0.95 * N)];
    var worst = sorted[0];

    $('#bt-mc-pPos').textContent = (pPos * 100).toFixed(1) + '%';
    $('#bt-mc-pNeg').textContent = (pNeg * 100).toFixed(1) + '%';
    $('#bt-mc-mean').textContent = (mean >= 0 ? '+' : '') + mean.toFixed(2) + '%';
    $('#bt-mc-p05').textContent  = p05.toFixed(2) + '%';
    $('#bt-mc-p50').textContent  = (p50 >= 0 ? '+' : '') + p50.toFixed(2) + '%';
    $('#bt-mc-p95').textContent  = (p95 >= 0 ? '+' : '') + p95.toFixed(2) + '%';
    $('#bt-mc-worst').textContent = worst.toFixed(2) + '%';

    $('#bt-mc-results').style.display = '';
    BTCharts.mcHistogram('bt-mc-hist', finalReturns);
    BTCharts.mcSpaghetti('bt-mc-spaghetti', sampledPaths);
  }

  // ===================================================================
  // INVESTMENT PLANNER TAB — Phase K
  // ===================================================================
  var planMcChart = null;

  function bootInvestmentPlanner() {
    $('#bt-ip-run').addEventListener('click', runInvestmentPlanner);
    $('#bt-ip-source').addEventListener('change', refreshInvestmentPlannerTab);
  }

  function refreshInvestmentPlannerTab() {
    // Populate ticker / target / stop selectors from the latest engine result,
    // since the planner currently uses Engine trades. (Compare source uses
    // its own pre-baked trade lists.)
    var src = $('#bt-ip-source').value;
    if (src === 'engine' && state.engineResult) {
      var s = state.engineResult.summaries;
      fillSelect('#bt-ip-source-ticker', uniq(s.map(function (r) { return r.ticker; })), 'All tickers');
      fillSelect('#bt-ip-source-target', uniq(s.map(function (r) { return String(r.targetPct); })), 'All targets');
      fillSelect('#bt-ip-source-stop',   uniq(s.map(function (r) { return r.stopPct == null ? 'none' : String(r.stopPct); })), 'All stops');
    } else {
      fillSelect('#bt-ip-source-ticker', [], 'All tickers');
      fillSelect('#bt-ip-source-target', [], 'All targets');
      fillSelect('#bt-ip-source-stop',   [], 'All stops');
    }
  }

  function collectPlannerTrades() {
    var src = $('#bt-ip-source').value;
    if (src === 'engine') {
      if (!state.engineResult) return null;
      var ft = $('#bt-ip-source-ticker').value;
      var fg = $('#bt-ip-source-target').value;
      var fs = $('#bt-ip-source-stop').value;
      return state.engineResult.trades.filter(function (t) {
        if (ft && t.ticker !== ft) return false;
        if (fg && String(t.targetPct) !== fg) return false;
        if (fs && (t.stopPct == null ? 'none' : String(t.stopPct)) !== fs) return false;
        return true;
      });
    }
    if (src === 'compare') {
      if (!state.compareResult) return null;
      var all = [];
      Object.keys(state.compareResult.byTicker).forEach(function (tk) {
        all.push.apply(all, state.compareResult.byTicker[tk]);
      });
      return all;
    }
    return null;
  }

  function runInvestmentPlanner() {
    showError('');
    var trades = collectPlannerTrades();
    if (!trades || !trades.length) {
      showError('Run the Engine (or Compare) tab first — the planner needs trades to size positions.');
      return;
    }

    var opts = {
      accountSize:                 Number($('#bt-ip-account').value) || 100000,
      desiredMonthlyIncome:        Number($('#bt-ip-income').value)  || 0,
      maxRiskPerTradePct:          Number($('#bt-ip-risk').value)    || 1,
      maxCapitalPerTradePct:       Number($('#bt-ip-cap').value)     || 50,
      expectedTradingDaysPerMonth: Number($('#bt-ip-days').value)    || 21,
      monteCarloRuns:              Number($('#bt-ip-runs').value)    || 10000
    };

    var r = BTInvestmentPlanner.analyze(trades, opts);

    $('#bt-ip-empty').style.display = 'none';
    $('#bt-ip-results').style.display = '';
    $('#bt-ip-stats').style.display = '';
    $('#bt-ip-mc-card').style.display = '';

    var fc = BTInvestmentPlanner.formatCurrency;
    var fp = BTInvestmentPlanner.formatPercent;
    var s  = r.stats;

    $('#bt-ip-suggested').textContent          = fc(s.suggestedPosition);
    $('#bt-ip-risk-dollars').textContent       = fc(s.riskDollars);
    $('#bt-ip-profit-per-trade').textContent   = fc(s.expectedProfitPerTrade);
    $('#bt-ip-trades-per-month').textContent   = isFinite(s.expectedTradesPerMonth) ? s.expectedTradesPerMonth.toFixed(1) : 'N/A';
    $('#bt-ip-monthly-profit').textContent     = fc(s.expectedMonthlyProfit);
    $('#bt-ip-capital-needed').textContent     = fc(s.capitalNeededForIncome);

    $('#bt-ip-winrate').textContent            = fp(s.winRate, 1);
    $('#bt-ip-avgwin').textContent             = fp(s.avgWinPct);
    $('#bt-ip-avgloss').textContent            = '-' + fp(s.avgLossPct);
    $('#bt-ip-worstloss').textContent          = '-' + fp(s.worstLossPct);
    $('#bt-ip-expectancy').textContent         = fp(s.expectancyPct);
    $('#bt-ip-pf').textContent                 = s.profitFactor == null ? '∞' : s.profitFactor.toFixed(2);
    $('#bt-ip-trades').textContent             = s.tradesTaken + ' / ' + (s.winningTrades + s.losingTrades + (s.tradesTaken - s.winningTrades - s.losingTrades));
    $('#bt-ip-days-tested').textContent        = s.testedTradingDays;

    var mc = r.monteCarlo;
    $('#bt-ip-mc-ppos').textContent    = (mc.probabilityPositiveMonth * 100).toFixed(1) + '%';
    $('#bt-ip-mc-ptarget').textContent = (mc.probabilityReachIncomeTarget * 100).toFixed(1) + '%';
    $('#bt-ip-mc-p5').textContent      = fc(mc.p5);
    $('#bt-ip-mc-median').textContent  = fc(mc.median);
    $('#bt-ip-mc-p95').textContent     = fc(mc.p95);
    $('#bt-ip-mc-worst').textContent   = fc(mc.worst);
    $('#bt-ip-mc-best').textContent    = fc(mc.best);

    renderPlannerWarnings(r.warnings);
    renderPlannerMcHistogram(mc.monthlyResults, opts.desiredMonthlyIncome);
  }

  function renderPlannerWarnings(warnings) {
    var host = $('#bt-ip-warnings');
    if (!warnings || !warnings.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = warnings.map(function (w) {
      return '<div class="bt-banner" style="background:#fff5f5; border-color:#fc8181; color:#742a2a;">' +
             '<i class="fa-solid fa-triangle-exclamation"></i> <span>' + escapeHtml(w) + '</span></div>';
    }).join('');
  }

  function renderPlannerMcHistogram(values, target) {
    if (!values || !values.length) return;
    if (planMcChart) { try { planMcChart.destroy(); } catch (e) {} planMcChart = null; }

    // Build 30 evenly-sized buckets.
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    if (lo === hi) { lo -= 100; hi += 100; }
    var n = 30, w = (hi - lo) / n;
    var counts = new Array(n).fill(0);
    var centers = [];
    for (var i = 0; i < n; i++) centers.push(lo + (i + 0.5) * w);
    values.forEach(function (v) {
      var idx = Math.min(n - 1, Math.floor((v - lo) / w));
      counts[idx]++;
    });
    var labels = centers.map(function (c) { return Math.round(c).toLocaleString(); });
    var colors = centers.map(function (c) {
      return c >= 0 ? 'rgba(56,161,105,0.85)' : 'rgba(229,62,62,0.85)';
    });

    // Tiny Chart.js plugin to draw the vertical income-target line.
    var targetLinePlugin = {
      id: 'plannerTargetLine',
      afterDatasetsDraw: function (chart) {
        if (!isFinite(target) || target <= lo || target >= hi) return;
        var x = chart.scales.x;
        var y = chart.scales.y;
        // Map target to the same bucket positions as the bars.
        var bucket = Math.min(n - 1, Math.max(0, (target - lo) / w));
        var px = x.getPixelForValue(bucket);
        var ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = '#dd6b20';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(px, y.top); ctx.lineTo(px, y.bottom);
        ctx.stroke();
        ctx.fillStyle = '#dd6b20';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Income target: ' + BTInvestmentPlanner.formatCurrency(target), px, y.top + 12);
        ctx.restore();
      }
    };

    var ctx = document.getElementById('bt-ip-mc-hist').getContext('2d');
    planMcChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Simulated months ($)',
          data: counts,
          backgroundColor: colors
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return 'Month outcome ≈ $' + items[0].label; },
              label: function (it) { return it.parsed.y + ' simulations'; }
            }
          }
        },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 45 }, title: { display: true, text: 'Monthly profit ($)' } },
          y: { title: { display: true, text: 'Simulations' } }
        }
      },
      plugins: [targetLinePlugin]
    });
  }

  // ===================================================================
  // SIGNAL QUALITY TAB — Phase L
  // ===================================================================
  function bootSignalQuality() {
    $('#bt-sq-run').addEventListener('click', runSignalQuality);
  }

  function refreshSignalQualityTab() {
    // Sync the first-hour window field with whatever the user picked on
    // the Engine tab so signal-quality scoring matches their backtest.
    var w = parseInt($('#bt-trend-window').value, 10);
    if (isFinite(w) && w > 0 && document.activeElement !== $('#bt-sq-window')) {
      $('#bt-sq-window').value = w;
    }
  }

  function parseNumberList(str) {
    return String(str || '').split(',').map(function (s) { return parseFloat(s.trim()); })
                            .filter(function (n) { return isFinite(n) && n > 0; });
  }

  function runSignalQuality() {
    showError('');
    if (!state.engineResult || !state.engineResult.candlesByTicker) {
      showError('Run the Engine tab first — signal quality scores the candles from your latest backtest.');
      return;
    }
    var opts = {
      trendWindowMin:  Math.max(5, parseInt($('#bt-sq-window').value, 10) || 60),
      dipPct:          Math.max(0.1, parseFloat($('#bt-sq-dip').value) || 3),
      greenTargets:    parseNumberList($('#bt-sq-green-targets').value),
      recoveryTargets: parseNumberList($('#bt-sq-rec-targets').value),
      targetSweep:     parseNumberList($('#bt-sq-sweep').value)
    };
    if (!opts.greenTargets.length)    opts.greenTargets    = [0.35, 0.5, 1];
    if (!opts.recoveryTargets.length) opts.recoveryTargets = [0.35, 0.5, 1];
    if (!opts.targetSweep.length)     opts.targetSweep     = [0.35, 0.5, 0.75, 1, 1.5, 2, 3];

    var report = BTSignalQuality.analyze(state.engineResult.candlesByTicker, opts);
    renderSignalQuality(report, opts);
  }

  function renderSignalQuality(report, opts) {
    $('#bt-sq-empty').style.display = 'none';
    $('#bt-sq-results-card').style.display = '';
    $('#bt-sq-settings-line').textContent =
      'First-hour window ' + opts.trendWindowMin + ' min · ' +
      'Dip threshold ' + opts.dipPct + '% · ' +
      'Green targets ' + opts.greenTargets.join('/') + '% · ' +
      'Recovery targets ' + opts.recoveryTargets.join('/') + '% · ' +
      'Target sweep ' + opts.targetSweep.join('/') + '%';

    var body = $('#bt-sq-body');
    var foot = $('#bt-sq-foot');
    body.innerHTML = '';
    foot.innerHTML = '';

    Object.keys(report.byTicker).sort().forEach(function (tk) {
      body.appendChild(buildSignalQualityRow(report.byTicker[tk], opts, false));
    });
    foot.appendChild(buildSignalQualityRow(report.overall, opts, true));
  }

  function buildSignalQualityRow(r, opts, isOverall) {
    var tr = document.createElement('tr');
    if (isOverall) {
      tr.style.background = '#f7fafc';
      tr.style.fontWeight = '700';
    }
    function hitCell(hits, n, total) {
      if (!total) return tdNum('—');
      var pct = n / total * 100;
      return tdNum(n + ' / ' + total + ' <span class="muted" style="font-size:11px;">(' + pct.toFixed(0) + '%)</span>');
    }
    function recCell(hits, n, denom) {
      if (!denom) return tdNum('—');
      var pct = n / denom * 100;
      return tdNum(n + ' / ' + denom + ' <span class="muted" style="font-size:11px;">(' + pct.toFixed(0) + '%)</span>');
    }
    var bt = r.bestTarget;
    var bestTargetCell = bt
      ? bt.targetPct + '% <span class="muted" style="font-size:11px;">(' + bt.tradesTaken + 'tr · WR ' + bt.winRate.toFixed(0) + '%)</span>'
      : '—';
    var bestExpCell = bt
      ? plCell(bt.expectancy)
      : '—';
    var falseSigCell = r.signalsTaken
      ? r.falseSignals + ' / ' + r.signalsTaken +
        ' <span class="muted" style="font-size:11px;">(' + (r.falseSignalRate * 100).toFixed(0) + '%)</span>'
      : '—';
    tr.innerHTML =
      td(r.ticker, 'sym') +
      tdNum(r.totalDays) +
      tdNum(r.greenDays) + tdNum(r.redDays) + tdNum(r.flatDays) +
      hitCell(r.greenHits,    r.greenHits['0.35']  || 0, r.greenDays) +
      hitCell(r.greenHits,    r.greenHits['0.5']   || 0, r.greenDays) +
      hitCell(r.greenHits,    r.greenHits['1']     || 0, r.greenDays) +
      hitCell(null,           r.redDipDays,             r.redDays) +
      recCell(r.recoveryHits, r.recoveryHits['0.35'] || 0, r.redDipDays) +
      recCell(r.recoveryHits, r.recoveryHits['0.5']  || 0, r.redDipDays) +
      recCell(r.recoveryHits, r.recoveryHits['1']    || 0, r.redDipDays) +
      tdNum(falseSigCell) +
      tdNum(plCell(r.avgPostReturn)) +
      tdNum(plCell(r.medianPostReturn)) +
      tdNum(bestTargetCell) +
      tdNum(bestExpCell);
    return tr;
  }

  // ===================================================================
  // EXPERIMENTS TAB — Timeframe Accuracy Report (Phase M)
  // -------------------------------------------------------------------
  // Designed to host multiple experiments over time. The Timeframe
  // Accuracy Report sweeps every window in `bt-tf-windows` across all
  // tickers already loaded by the Engine tab.
  // ===================================================================
  var TF_LS_IDEAS = 'btLab.experimentIdeas';
  var tfState = { lastReport: null, chart: null };

  function bootExperiments() {
    $('#bt-tf-run').addEventListener('click', runTimeframeAccuracy);

    // Re-render table/chart on sort or metric change without re-running math.
    $('#bt-tf-sort').addEventListener('change', function () {
      if (tfState.lastReport) renderTimeframeTable(tfState.lastReport);
    });
    $('#bt-tf-chart-metric').addEventListener('change', function () {
      if (tfState.lastReport) renderTimeframeChart(tfState.lastReport);
    });

    // Persist the user's experiment ideas locally so the textarea sticks.
    var ideas = $('#bt-exp-ideas');
    try { ideas.value = localStorage.getItem(TF_LS_IDEAS) || ''; } catch (e) {}
    var saveTimer = null;
    var status = $('#bt-exp-ideas-status');
    ideas.addEventListener('input', function () {
      if (saveTimer) clearTimeout(saveTimer);
      status.textContent = 'Saving…';
      saveTimer = setTimeout(function () {
        try {
          localStorage.setItem(TF_LS_IDEAS, ideas.value);
          status.textContent = 'Saved.';
        } catch (e) {
          status.textContent = 'Save failed (localStorage blocked).';
        }
      }, 250);
    });

    bootExperimentWorkbench();
  }

  function refreshExperimentsTab() {
    // Default the timeframe input to the user's first-hour window if blank.
    var el = $('#bt-tf-windows');
    if (!el.value.trim()) el.value = '15, 30, 45, 60, 90, 120';
  }

  function runTimeframeAccuracy() {
    showError('');
    if (!state.engineResult || !state.engineResult.candlesByTicker) {
      showError('Run the Engine tab first — the timeframe report scores the candles from your latest backtest.');
      return;
    }
    var timeframes = parseNumberList($('#bt-tf-windows').value)
      .map(function (n) { return Math.max(5, Math.round(n)); })
      .filter(function (n) { return n < 390; });
    if (!timeframes.length) timeframes = [15, 30, 45, 60, 90, 120];

    var opts = {
      timeframes:  timeframes,
      dipPct:      Math.max(0.1, parseFloat($('#bt-tf-dip').value) || 3),
      hitTargets:  parseNumberList($('#bt-tf-hits').value),
      targetSweep: parseNumberList($('#bt-tf-sweep').value)
    };
    if (!opts.hitTargets.length)  opts.hitTargets  = [0.35, 0.5, 1];
    if (!opts.targetSweep.length) opts.targetSweep = [0.35, 0.5, 0.75, 1, 1.5, 2, 3];

    var report = BTTimeframeAccuracy.analyze(state.engineResult.candlesByTicker, opts);
    if (!report.rows.length) {
      showError('Timeframe report produced no rows — your loaded candles may be too short for these windows.');
      return;
    }
    tfState.lastReport = report;
    renderTimeframeBest(report);
    renderTimeframeTable(report);
    renderTimeframeChart(report);
  }

  function renderTimeframeBest(report) {
    var grid = $('#bt-tf-best-grid');
    var bestKeys = Object.keys(report.bestByTicker).sort();
    if (!bestKeys.length) {
      $('#bt-tf-best-card').style.display = 'none';
      return;
    }
    $('#bt-tf-best-card').style.display = '';
    grid.innerHTML = bestKeys.map(function (tk) {
      var r = report.bestByTicker[tk];
      var sub =
        'Win ' + r.bestWinRate.toFixed(0) + '% · ' +
        'Acc ' + (r.eodAccuracy * 100).toFixed(0) + '% · ' +
        'Tot ' + (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
      var exp = r.bestExpectancy;
      var expCls = exp > 0 ? 'bt-pl-pos' : (exp < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
      return '<div class="bt-kpi">' +
        '<div class="label">' + escapeHtml(tk) + ' · best timeframe</div>' +
        '<div class="value">' + r.timeframe + 'm @ ' + r.bestTarget + '%</div>' +
        '<div class="muted" style="font-size:11px; margin-top:4px;">E <span class="' + expCls + '">' +
        (exp > 0 ? '+' : '') + exp.toFixed(2) + '%</span> · ' + sub + '</div>' +
      '</div>';
    }).join('');
  }

  function renderTimeframeTable(report) {
    $('#bt-tf-empty').style.display = 'none';
    $('#bt-tf-results-card').style.display = '';
    var s = report.settings;
    $('#bt-tf-settings-line').textContent =
      'Timeframes ' + s.timeframes.join('/') + ' min · ' +
      'Dip threshold ' + s.dipPct + '% · ' +
      'Hit targets ' + s.hitTargets.join('/') + '% · ' +
      'Sweep ' + s.targetSweep.join('/') + '%';

    var rows = report.rows.slice();
    var sortMode = $('#bt-tf-sort').value;
    if (sortMode === 'expectancy') {
      rows.sort(function (a, b) { return b.bestExpectancy - a.bestExpectancy; });
    } else if (sortMode === 'totalReturn') {
      rows.sort(function (a, b) { return b.totalReturn - a.totalReturn; });
    } else if (sortMode === 'eodAccuracy') {
      rows.sort(function (a, b) { return b.eodAccuracy - a.eodAccuracy; });
    } else {
      rows.sort(function (a, b) {
        if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
        return a.timeframe - b.timeframe;
      });
    }

    // Find best (ticker, timeframe) so we can highlight the winning row.
    var bestExpByTicker = {};
    rows.forEach(function (r) {
      var b = bestExpByTicker[r.ticker];
      if (!b || r.bestExpectancy > b) bestExpByTicker[r.ticker] = r.bestExpectancy;
    });

    var body = $('#bt-tf-body');
    body.innerHTML = '';
    rows.forEach(function (r) {
      var isBest = r.bestExpectancy === bestExpByTicker[r.ticker];
      body.appendChild(buildTimeframeRow(r, isBest));
    });
  }

  function buildTimeframeRow(r, isBest) {
    var tr = document.createElement('tr');
    if (isBest) {
      tr.style.background = '#f0fdf4'; // soft green to flag winning row
      tr.style.fontWeight = '600';
    }
    function pctCell(n) {
      if (n == null) return tdNum('—');
      return tdNum((n * 100).toFixed(0) + '%');
    }
    function plCellLocal(n) { return plCell(isFinite(n) ? n : 0); }
    var falseSigCell = r.signalsTaken
      ? r.falseSignals + ' / ' + r.signalsTaken +
        ' <span class="muted" style="font-size:11px;">(' + (r.falseSignalRate * 100).toFixed(0) + '%)</span>'
      : '—';
    var bestTargetCell = r.bestTarget != null
      ? r.bestTarget + '% <span class="muted" style="font-size:11px;">(' + r.bestTradesTaken + 'tr · WR ' + r.bestWinRate.toFixed(0) + '%)</span>'
      : '—';
    tr.innerHTML =
      td(r.ticker, 'sym') +
      tdNum(r.timeframe + 'm') +
      tdNum(r.totalDays) +
      pctCell(r.eodAccuracy) +
      pctCell(r.hits035) +
      pctCell(r.hits05) +
      pctCell(r.hits1) +
      tdNum(plCellLocal(r.avgReturn)) +
      tdNum(plCellLocal(r.bestExpectancy)) +
      tdNum(bestTargetCell) +
      tdNum(falseSigCell);
    return tr;
  }

  function renderTimeframeChart(report) {
    $('#bt-tf-chart-card').style.display = '';
    var metric = $('#bt-tf-chart-metric').value;

    // Group rows by ticker so each line traces accuracy across timeframes.
    var byTicker = {};
    report.rows.forEach(function (r) {
      (byTicker[r.ticker] = byTicker[r.ticker] || []).push(r);
    });
    Object.keys(byTicker).forEach(function (tk) {
      byTicker[tk].sort(function (a, b) { return a.timeframe - b.timeframe; });
    });

    var labels = report.settings.timeframes.slice().map(function (t) { return t + 'm'; });
    // Multi-ticker palette \u2014 teal-forward (matches js/backtester-charts.js paletteColor).
    var palette = ['#055050', '#20B26B', '#42C7E8', '#0D7A7A',
                   '#F4B740', '#D9534F', '#067A6A', '#9A6BBF',
                   '#67D9DA', '#C99100'];

    function valueFor(r) {
      if (metric === 'eodAccuracy')    return r.eodAccuracy * 100;
      if (metric === 'bestExpectancy') return r.bestExpectancy;
      if (metric === 'totalReturn')    return r.totalReturn;
      if (metric === 'avgReturn')      return r.avgReturn;
      if (metric === 'hits1')          return r.hits1 != null ? r.hits1 * 100 : null;
      return r.eodAccuracy * 100;
    }
    function metricLabel() {
      return ({
        eodAccuracy:    'EOD accuracy (%)',
        bestExpectancy: 'Expectancy at best target (%)',
        totalReturn:    'Sum of post-window returns (%)',
        avgReturn:      'Avg post-window return (%)',
        hits1:          '+1% hit rate (%)'
      })[metric] || 'Value';
    }

    var datasets = Object.keys(byTicker).sort().map(function (tk, idx) {
      var color = palette[idx % palette.length];
      var data = report.settings.timeframes.map(function (tf) {
        var row = byTicker[tk].find(function (x) { return x.timeframe === tf; });
        return row ? valueFor(row) : null;
      });
      return {
        label: tk,
        data: data,
        borderColor: color,
        backgroundColor: color + '33',
        tension: 0.25,
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6
      };
    });

    if (tfState.chart) { tfState.chart.destroy(); tfState.chart = null; }
    var ctx = $('#bt-tf-chart').getContext('2d');
    tfState.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var v = ctx.parsed.y;
                return ctx.dataset.label + ': ' + (v == null ? '—' : v.toFixed(2));
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'First-window timeframe' } },
          y: { title: { display: true, text: metricLabel() }, beginAtZero: metric === 'eodAccuracy' || metric === 'hits1' }
        }
      }
    });
  }

  // ===================================================================
  // AI LAB TAB — Phase J
  // ===================================================================
  function bootAI() {
    $('#bt-ai-rec-run').addEventListener('click', runAIRec);
    $('#bt-ai-sb-run').addEventListener('click', runAIBuilder);
    // Probe disabled state by attempting a tiny call (skipped if no result yet).
    // We rely on the recommend/builder calls to flip the banner if 503.
    if (BTAI.isDisabled()) showAIDisabled();
    $('#bt-ai-sb-run').disabled = false; // builder doesn't need optimizer results
  }
  function showAIDisabled() {
    $('#bt-ai-disabled').style.display = '';
    $('#bt-ai-rec-run').disabled = true;
    $('#bt-ai-sb-run').disabled = true;
  }
  function runAIRec() {
    if (!state.optimizerResult) { showError('Run the Optimizer first.'); return; }
    var rows = state.optimizerResult.rows.slice(0, 200);
    var bestByT = {};
    rows.forEach(function (r) {
      var cur = bestByT[r.ticker];
      if (!cur || (r.totalPL || -Infinity) > (cur.totalPL || -Infinity)) bestByT[r.ticker] = r;
    });
    var payload = {
      tickers: Object.keys(bestByT),
      slippageBps: state.optimizerResult.settings.slippageBps,
      topStrategies: bestByT,
      sampleRows: rows.slice(0, 50),
      // Forward the experiment leaderboard so the AI can also reason
      // about adjustable strategy patterns alongside the optimizer.
      experiments: (typeof BTExperiments !== 'undefined' && xpState.leaderboard && xpState.leaderboard.length)
        ? BTExperiments.rankRows(xpState.leaderboard).slice(0, 40).map(function (r) {
            var clone = Object.assign({}, r);
            delete clone.trades; // never ship raw trades to the API
            return clone;
          })
        : []
    };
    $('#bt-ai-rec-output').innerHTML = '<div class="bt-loading show"><i class="fa-solid fa-spinner"></i> Asking the AI…</div>';
    BTAI.recommend(payload).then(function (resp) {
      var html = '';
      if (resp.headline) html += '<h3>' + escapeHtml(resp.headline) + '</h3>';
      (resp.bullets || []).forEach(function (b) {
        html += '<div class="bt-ai-bullet"><i class="fa-solid fa-lightbulb"></i><span>' + escapeHtml(b) + '</span></div>';
      });
      if (!resp.bullets || !resp.bullets.length) html += '<div class="muted">No bullets returned.</div>';
      $('#bt-ai-rec-output').innerHTML = html;
    }).catch(function (err) {
      if (/ai-disabled/.test(err.message)) { showAIDisabled(); $('#bt-ai-rec-output').innerHTML = ''; return; }
      $('#bt-ai-rec-output').innerHTML = '<div class="bt-error show">' + escapeHtml(err.message || String(err)) + '</div>';
    });
  }
  function runAIBuilder() {
    var desc = $('#bt-ai-sb-input').value || '';
    if (!desc.trim()) { showError('Type a strategy description.'); return; }
    $('#bt-ai-sb-output').innerHTML = '<div class="bt-loading show"><i class="fa-solid fa-spinner"></i> Building strategy…</div>';
    BTAI.buildStrategy(desc).then(function (resp) {
      var s = resp.strategy || {};
      var html = '<div class="bt-kpi-grid">' +
        kpi('First hour', (s.firstHourMin || 60) + ' min') +
        kpi('Dip %', s.dipPct == null ? '—' : s.dipPct + '%') +
        kpi('Target %', s.targetPct + '%') +
        kpi('Stop %', s.stopPct == null ? 'none' : s.stopPct + '%') +
        kpi('Slippage', (s.slippageBps || 0) + ' bps') +
        kpi('Trend', s.trend || 'either') +
        '</div>' +
        '<button class="btn btn-primary" id="bt-ai-apply"><i class="fa-solid fa-arrow-right"></i> Apply to Engine</button>';
      $('#bt-ai-sb-output').innerHTML = html;
      $('#bt-ai-apply').addEventListener('click', function () {
        applyAIStrategy(s);
      });
    }).catch(function (err) {
      if (/ai-disabled/.test(err.message)) { showAIDisabled(); $('#bt-ai-sb-output').innerHTML = ''; return; }
      $('#bt-ai-sb-output').innerHTML = '<div class="bt-error show">' + escapeHtml(err.message || String(err)) + '</div>';
    });
  }
  function applyAIStrategy(s) {
    $('#bt-trend-window').value = s.firstHourMin || 60;
    if (s.dipPct != null) $('#bt-dip').value = s.dipPct;
    $('#bt-targets').innerHTML = '';
    $('#bt-targets').appendChild(makeChip(String(s.targetPct), true));
    $('#bt-stops').innerHTML = '';
    if (s.stopPct != null) $('#bt-stops').appendChild(makeChip(String(s.stopPct), true));
    $('#bt-slippage').value = s.slippageBps || 0;
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'engine'); });
    $$('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-engine'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ===================================================================
  // SHARED HELPERS
  // ===================================================================
  function uniq(arr) { var s = new Set(); arr.forEach(function (v) { s.add(v); }); return Array.from(s); }
  function fillSelect(sel, values, allLabel) {
    var el = $(sel);
    var current = el.value;
    el.innerHTML = (allLabel ? '<option value="">' + allLabel + '</option>' : '') +
      values.map(function (v) { return '<option value="' + escapeAttr(v) + '">' + escapeHtml(String(v)) + '</option>'; }).join('');
    if (values.indexOf(current) !== -1) el.value = current;
  }
  function td(content, klass) { return '<td' + (klass ? ' class="' + klass + '"' : '') + '>' + content + '</td>'; }
  function tdNum(content) { return '<td class="num">' + content + '</td>'; }
  function fmtPct(n) { if (!isFinite(n)) return '0.00%'; return (Math.round(n * 100) / 100).toFixed(2) + '%'; }
  function money(n) { if (n == null || !isFinite(n)) return '—'; return '$' + (Math.round(n * 100) / 100).toFixed(2); }
  function fmtMinutes(m) {
    if (!isFinite(m) || m <= 0) return '—';
    if (m < 60) return Math.round(m) + 'm';
    var h = Math.floor(m / 60), mm = Math.round(m % 60);
    return h + 'h' + (mm ? ' ' + mm + 'm' : '');
  }
  function plCell(n) {
    if (!isFinite(n)) return '<span class="bt-pl-flat">0.00%</span>';
    var cls = n > 0 ? 'bt-pl-pos' : (n < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(2) + '%</span>';
  }
  function typePill(t) {
    if (t === 'up')   return '<span class="bt-pill bt-pill-up">Trending up</span>';
    if (t === 'down') return '<span class="bt-pill bt-pill-down">Trending down</span>';
    return '<span class="bt-pill bt-pill-none">No trade</span>';
  }
  function exitPill(r) {
    if (r === 'target') return '<span class="bt-pill bt-pill-up">target</span>';
    if (r === 'stop')   return '<span class="bt-pill bt-pill-down">stop</span>';
    if (r === 'eod')    return '<span class="bt-pill bt-pill-flat">EOD</span>';
    return '<span class="bt-pill bt-pill-none">N/A</span>';
  }
  function kpi(label, val) {
    return '<div class="bt-kpi"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(String(val)) + '</div></div>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
  function setLoading(on) { $('#bt-loading').classList.toggle('show', !!on); }
  function showError(msg) {
    var el = $('#bt-error');
    if (!msg) { el.classList.remove('show'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.add('show');
  }

  // ===================================================================
  // MOCK CANDLE GENERATOR (only used when /api/bars is unavailable)
  // ===================================================================
  function generateMockCandles(ticker, period, interval) {
    var days = parseInt(String(period).replace(/\D/g, ''), 10) || 60;
    var intervalMin = parseInt(String(interval).replace(/\D/g, ''), 10) || 5;
    var startMin = BTEngine.MARKET_OPEN_MIN, endMin = BTEngine.MARKET_CLOSE_MIN;
    var barsPerDay = Math.floor((endMin - startMin) / intervalMin);
    var seed = hashStr(ticker), rand = mulberry32(seed);
    var basePrice = 50 + (seed % 350);
    var candles = [];
    var cursor = new Date(); cursor.setUTCHours(0,0,0,0);
    var addedDays = 0, safety = 0;
    while (addedDays < days && safety < days * 3) {
      safety++;
      var dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        var open = basePrice * (0.9 + rand() * 0.2);
        basePrice = open;
        var price = open;
        var dayTrend  = (rand() - 0.5) * 0.04;
        var volatility = 0.003 + rand() * 0.004;
        for (var b = 0; b < barsPerDay; b++) {
          var minuteOfDay = startMin + b * intervalMin;
          var d = new Date(cursor.getTime()); d.setUTCHours(0,0,0,0); d.setUTCMinutes(minuteOfDay);
          var endTarget = open * (1 + dayTrend);
          var pull = (endTarget - price) / Math.max(1, barsPerDay - b);
          var shock = (rand() - 0.5) * 2 * volatility * price;
          var c = Math.max(0.01, price + pull + shock);
          var o = price;
          var h = Math.max(o, c) * (1 + rand() * volatility * 0.5);
          var l = Math.min(o, c) * (1 - rand() * volatility * 0.5);
          price = c;
          candles.push({
            t: d.getTime(), o: round2(o), h: round2(h), l: round2(l), c: round2(c),
            v: Math.floor(rand() * 100000) + 10000,
            minuteOfDay: minuteOfDay,
            dateKey: cursor.getUTCFullYear() + '-' + pad2(cursor.getUTCMonth() + 1) + '-' + pad2(cursor.getUTCDate())
          });
        }
        addedDays++;
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    candles.sort(function (a, b) { return a.t - b.t; });
    return candles;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ===================================================================
  // EXPERIMENT WORKBENCH
  // -------------------------------------------------------------------
  // Drives the Experiments tab's adjustable strategy library. Each
  // experiment is described in `BTExperiments.LIBRARY`; we render its
  // controls dynamically and run it on the candles already loaded by
  // the Engine tab. Results accumulate into a leaderboard so the user
  // can iterate and compare runs.
  // ===================================================================
  var xpState = { leaderboard: [], currentId: null };

  function bootExperimentWorkbench() {
    if (typeof BTExperiments === 'undefined') return;
    // One-time self-test to catch broken builds early.
    try {
      var t = BTExperiments.selfTest();
      if (t.failed === 0) console.log('[BTExperiments] selfTest passed (' + t.passed + ' checks).');
      else console.error('[BTExperiments] selfTest FAILED:', t.results.filter(function (r) { return !r.ok; }));
    } catch (e) { console.error('[BTExperiments] selfTest threw', e); }

    var sel = $('#bt-xp-select');
    BTExperiments.LIBRARY.forEach(function (e, i) {
      var opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = (i + 1) + '. ' + e.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { renderXpControls(sel.value); });
    renderXpControls(sel.value || BTExperiments.LIBRARY[0].id);

    $('#bt-xp-reset').addEventListener('click', function () { renderXpControls($('#bt-xp-select').value, /*force*/ true); });
    $('#bt-xp-run').addEventListener('click', runExperiment);
    $('#bt-xp-clear').addEventListener('click', function () {
      xpState.leaderboard = []; renderLeaderboard();
    });
    $('#bt-xp-csv-leader').addEventListener('click', function () {
      downloadCsv(BTExperiments.exportCsv(xpState.leaderboard, 'leaderboard'), 'experiment-leaderboard.csv');
    });
    $('#bt-xp-csv-trades').addEventListener('click', function () {
      downloadCsv(BTExperiments.exportCsv(xpState.leaderboard, 'trades'), 'experiment-trades.csv');
    });
  }

  function renderXpControls(experimentId, force) {
    var expt = BTExperiments.byId(experimentId);
    if (!expt) return;
    xpState.currentId = experimentId;
    $('#bt-xp-summary').textContent = expt.summary;
    var host = $('#bt-xp-controls');
    host.innerHTML = '';
    expt.controls.forEach(function (c) {
      var field = document.createElement('div');
      field.className = 'field';
      var label = document.createElement('label');
      label.textContent = c.label + (c.suffix ? ' (' + c.suffix + ')' : '');
      label.setAttribute('for', 'bt-xp-c-' + c.id);
      field.appendChild(label);
      var control = buildXpControl(c);
      field.appendChild(control);
      host.appendChild(field);
    });
  }

  function buildXpControl(c) {
    if (c.type === 'choice' || c.type === undefined) {
      var s = document.createElement('select');
      s.className = 'select'; s.id = 'bt-xp-c-' + c.id;
      (c.options || []).forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = (v == null ? '__none__' : String(v));
        opt.textContent = (v == null ? 'none' : (String(v) + (c.suffix ? ' ' + c.suffix : '')));
        if (v === c.default || (v == null && c.default == null)) opt.selected = true;
        s.appendChild(opt);
      });
      return s;
    }
    if (c.type === 'bool') {
      var w = document.createElement('label');
      w.style.display = 'flex'; w.style.alignItems = 'center'; w.style.gap = '8px'; w.style.padding = '8px 0';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'bt-xp-c-' + c.id; cb.checked = !!c.default;
      var sp = document.createElement('span'); sp.textContent = c.default ? 'yes' : 'no';
      cb.addEventListener('change', function () { sp.textContent = cb.checked ? 'yes' : 'no'; });
      w.appendChild(cb); w.appendChild(sp);
      return w;
    }
    // number fallback
    var n = document.createElement('input');
    n.type = 'number'; n.className = 'input input-money'; n.id = 'bt-xp-c-' + c.id;
    if (c.min != null) n.min = c.min; if (c.max != null) n.max = c.max;
    n.step = c.step || 0.1; n.value = c.default == null ? '' : c.default;
    return n;
  }

  function readXpParams(expt) {
    var out = {};
    expt.controls.forEach(function (c) {
      var el = document.getElementById('bt-xp-c-' + c.id);
      if (!el) { out[c.id] = c.default; return; }
      if (c.type === 'bool') { out[c.id] = !!el.checked; return; }
      var v = (el.value !== undefined) ? el.value : c.default;
      if (v === '__none__' || v === '' || v == null) { out[c.id] = null; return; }
      var asNum = Number(v);
      out[c.id] = (typeof v === 'string' && /^[A-Za-z:]/.test(v)) ? v : (isFinite(asNum) ? asNum : v);
    });
    return out;
  }

  function runExperiment() {
    showError('');
    var expt = BTExperiments.byId(xpState.currentId);
    if (!expt) return;
    if (!state.engineResult || !state.engineResult.candlesByTicker) {
      showError('Run the Engine tab first — experiments use the same candles as the most recent backtest.');
      return;
    }
    var candlesByTicker = state.engineResult.candlesByTicker;
    var tickersRaw = ($('#bt-xp-tickers').value || '').trim();
    var tickers = tickersRaw
      ? tickersRaw.split(/[,\s]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
      : Object.keys(candlesByTicker);
    // Keep only tickers we actually have candles for.
    tickers = tickers.filter(function (tk) { return candlesByTicker[tk] && candlesByTicker[tk].length; });
    if (!tickers.length) {
      showError('No matching tickers in the loaded candle set. Run the Engine tab with those tickers first.');
      return;
    }

    var params = readXpParams(expt);
    var slippageBps = Number($('#bt-slippage').value) || 0;
    var settings = { tickers: tickers, slippageBps: slippageBps, params: params };

    $('#bt-xp-loading').classList.add('show');
    setTimeout(function () {
      try {
        var result = BTExperiments.run(expt.id, candlesByTicker, settings,
          { intervalMin: Number(state.engineResult.settings.interval && String(state.engineResult.settings.interval).replace(/[^0-9]/g, '')) || 5 });
        renderXpSummary(result, expt, settings);
        // Append to leaderboard.
        xpState.leaderboard = xpState.leaderboard.concat(result.rows);
        renderLeaderboard();
      } catch (e) {
        showError('Experiment failed: ' + (e.message || String(e)));
      } finally {
        $('#bt-xp-loading').classList.remove('show');
      }
    }, 10);
  }

  function renderXpSummary(result, expt, settings) {
    $('#bt-xp-summary-card').style.display = '';
    $('#bt-xp-settings-line').textContent =
      expt.name + ' · ' +
      Object.keys(settings.params).map(function (k) {
        return k + '=' + (settings.params[k] == null ? 'none' : settings.params[k]);
      }).join(' · ') +
      ' · slip ' + settings.slippageBps + ' bps · tickers ' + settings.tickers.join('/');

    var rows = result.rows;
    // Compose KPI tiles: one per ticker (compact).
    var html = '';
    rows.forEach(function (r) {
      var expClass = r.expectancy > 0 ? 'bt-pl-pos' : (r.expectancy < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
      var warn = r.smallSample ? ' <span class="pill warn" title="Sample below 30">small</span>' : '';
      html += '<div class="bt-kpi">' +
        '<div class="label">' + escapeHtml(r.ticker) + warn + '</div>' +
        '<div class="value">E <span class="' + expClass + '">' +
          (r.expectancy >= 0 ? '+' : '') + r.expectancy.toFixed(2) + '%</span></div>' +
        '<div class="muted" style="font-size:11px; margin-top:4px;">' +
          r.tradesTaken + ' trades · WR ' + r.winRate.toFixed(0) + '% · ' +
          'PL ' + (r.totalPL >= 0 ? '+' : '') + r.totalPL.toFixed(2) + '%' +
        '</div>' +
      '</div>';
    });
    $('#bt-xp-kpi-grid').innerHTML = html || '<div class="muted">No tickers ran.</div>';
  }

  function renderLeaderboard() {
    var card = $('#bt-xp-board-card');
    if (!xpState.leaderboard.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    var ranked = BTExperiments.rankRows(xpState.leaderboard);
    var body = $('#bt-xp-board-body');
    body.innerHTML = '';
    ranked.forEach(function (r, idx) {
      var tr = document.createElement('tr');
      if (r.expectancy <= 0)   tr.style.background = '#fef2f2';
      else if (r.smallSample)  tr.style.background = '#fffbeb';
      var expClass = r.expectancy > 0 ? 'bt-pl-pos' : (r.expectancy < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
      var plClass  = r.totalPL    > 0 ? 'bt-pl-pos' : (r.totalPL    < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
      var ddClass  = r.maxDrawdown < 0 ? 'bt-pl-neg' : 'bt-pl-flat';
      var pf = isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞';
      tr.innerHTML =
        '<td class="num">' + (idx + 1) + '</td>' +
        '<td>' + escapeHtml(r.experimentName) + '</td>' +
        '<td class="sym">' + escapeHtml(r.ticker) + '</td>' +
        '<td><span class="muted" style="font-size:11px;">' + escapeHtml(formatXpParams(r.params)) + '</span></td>' +
        '<td class="num">' + r.tradesTaken + (r.smallSample ? ' <span class="pill warn">&lt;30</span>' : '') + '</td>' +
        '<td class="num">' + r.winRate.toFixed(1) + '%</td>' +
        '<td class="num"><span class="' + expClass + '">' + (r.expectancy >= 0 ? '+' : '') + r.expectancy.toFixed(2) + '%</span></td>' +
        '<td class="num"><span class="' + plClass + '">' + (r.totalPL >= 0 ? '+' : '') + r.totalPL.toFixed(2) + '%</span></td>' +
        '<td class="num"><span class="' + ddClass + '">' + r.maxDrawdown.toFixed(2) + '%</span></td>' +
        '<td class="num">' + pf + '</td>' +
        '<td class="num">' + r.avgHoldingMin.toFixed(0) + '</td>' +
        '<td><button class="btn btn-sm btn-ghost" data-apply="' + idx + '"><i class="fa-solid fa-arrow-right"></i> Apply</button></td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('button[data-apply]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.getAttribute('data-apply'));
        applyExperimentToEngine(ranked[i]);
      });
    });
  }

  function formatXpParams(p) {
    if (!p) return '';
    return Object.keys(p).map(function (k) {
      return k + '=' + (p[k] == null ? 'none' : p[k]);
    }).join(' · ');
  }

  // Seed the Engine tab with the row's target / stop where the params
  // line up. We deliberately don't override `tickers` so the user can
  // re-run Engine on whatever they currently have loaded.
  function applyExperimentToEngine(row) {
    var p = row.params || {};
    if (p.targetPct != null) {
      $('#bt-targets').innerHTML = '';
      $('#bt-targets').appendChild(makeChip(String(p.targetPct), true));
    }
    if (p.stopPct !== undefined) {
      $('#bt-stops').innerHTML = '';
      if (p.stopPct != null) $('#bt-stops').appendChild(makeChip(String(p.stopPct), true));
    }
    if (p.windowMin != null)    $('#bt-trend-window').value = p.windowMin;
    if (p.firstWindowMin != null) $('#bt-trend-window').value = p.firstWindowMin;
    if (row.slippageBps != null) $('#bt-slippage').value = row.slippageBps;
    // Switch to Engine tab.
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'engine'); });
    $$('.tab-panel').forEach(function (panel) { panel.classList.toggle('active', panel.id === 'tab-engine'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function downloadCsv(text, filename) {
    // Prepend a BOM so Excel reads UTF-8 cleanly.
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
})();
