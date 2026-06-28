/* Strategy Backtester
 * --------------------------------------------------------------------
 * Beginner-friendly notes:
 *
 *   1. This script is loaded on /backtester.html only. It uses the same
 *      Firebase auth guard (`FinanceAuth.requireAuth`) as the dashboard,
 *      so if the user is not signed in they are bounced to /index.html.
 *
 *   2. Data flow:
 *        readSettings() -> fetchCandles() -> runStrategy() -> render
 *
 *      `fetchCandles()` is the ONLY place that touches market data.
 *      Today it returns mock candles so the page works without a backend.
 *      When you have a real backend, replace the body of `fetchCandles()`
 *      with a call to your endpoint -- the rest of the file stays the same.
 *
 *   3. Backend contract (suggested):
 *        GET /api/backtest?ticker=AMD&period=60d&interval=5m
 *      Response shape (JSON):
 *        {
 *          ticker: "AMD",
 *          interval: "5m",
 *          candles: [
 *            { t: 1719406200000, o: 162.3, h: 162.9, l: 162.1, c: 162.7, v: 12345 },
 *            ...
 *          ]
 *        }
 *      `t` is a unix ms timestamp at the START of the bar. Times must be in
 *      US/Eastern market hours (9:30-16:00 ET).
 *
 *   IMPORTANT: do NOT put any API key into this file. Keys belong on the
 *   server-side endpoint (see /api/quote.js for the existing pattern).
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  // ----- DOM helpers ------------------------------------------------
  var $ = function (sel) { return document.querySelector(sel); };

  // ----- Page state -------------------------------------------------
  var lastResult = null; // { summaries: [...], trades: [...] }

  // ----- Boot: require auth, then wire UI ---------------------------
  FinanceAuth.requireAuth(function (user) {
    $('#hdr-email').textContent = user.email || user.displayName || 'Signed in';
    $('#btn-signout').addEventListener('click', function () {
      FinanceAuth.signOut().then(function () { window.location.href = '/index.html'; });
    });

    $('#bt-run').addEventListener('click', onRunClicked);
    $('#bt-filter-ticker').addEventListener('change', renderTrades);
    $('#bt-filter-target').addEventListener('change', renderTrades);
    $('#bt-filter-type').addEventListener('change', renderTrades);
  });

  // ----- 1) Read form -----------------------------------------------
  function readSettings() {
    var raw = $('#bt-tickers').value || '';
    var tickers = raw.split(',')
      .map(function (s) { return s.trim().toUpperCase(); })
      .filter(Boolean);

    var trendWindowMin = Math.max(5, parseInt($('#bt-trend-window').value, 10) || 60);
    var dipPct         = Math.max(0.1, parseFloat($('#bt-dip').value)         || 3);
    var target1        = Math.max(0.1, parseFloat($('#bt-target-1').value)    || 0.5);
    var target2        = Math.max(0.1, parseFloat($('#bt-target-2').value)    || 1);
    var interval       = $('#bt-interval').value || '5m';
    var period         = $('#bt-period').value   || '60d';

    return {
      tickers: tickers,
      trendWindowMin: trendWindowMin,
      dipPct: dipPct,
      targets: [target1, target2],
      interval: interval,
      period: period
    };
  }

  // ----- 2) Run button handler --------------------------------------
  function onRunClicked() {
    showError('');
    var settings;
    try {
      settings = readSettings();
      if (!settings.tickers.length) throw new Error('Please enter at least one ticker.');
    } catch (e) {
      showError(e.message || String(e));
      return;
    }

    setLoading(true);
    $('#bt-run').disabled = true;

    // Fetch candles for all tickers in parallel.
    var jobs = settings.tickers.map(function (t) {
      return fetchCandles(t, settings.period, settings.interval)
        .then(function (candles) { return { ticker: t, candles: candles }; });
    });

    Promise.all(jobs)
      .then(function (datasets) {
        var summaries = [];
        var trades    = [];

        datasets.forEach(function (ds) {
          settings.targets.forEach(function (targetPct) {
            var result = runStrategy(ds.candles, {
              ticker:         ds.ticker,
              trendWindowMin: settings.trendWindowMin,
              dipPct:         settings.dipPct,
              targetPct:      targetPct
            });
            summaries.push(result.summary);
            trades.push.apply(trades, result.trades);
          });
        });

        lastResult = { summaries: summaries, trades: trades, settings: settings };
        populateFilters(summaries);
        renderSummary();
        renderTrades();
      })
      .catch(function (err) {
        console.error('Backtest failed:', err);
        showError('Backtest failed: ' + (err.message || err));
      })
      .then(function () {
        setLoading(false);
        $('#bt-run').disabled = false;
      });
  }

  // ====================================================================
  // 3) DATA LAYER -- replace this with a real backend call later.
  // ====================================================================
  /**
   * Fetch OHLC candles for `ticker` over `period` at `interval`.
   *
   * --- TO CONNECT A REAL BACKEND ---
   * Replace the body below with something like:
   *
   *   var url = '/api/backtest?ticker=' + encodeURIComponent(ticker)
   *           + '&period='   + encodeURIComponent(period)
   *           + '&interval=' + encodeURIComponent(interval);
   *   return fetch(url, { credentials: 'same-origin' })
   *     .then(function (r) {
   *       if (!r.ok) throw new Error('HTTP ' + r.status);
   *       return r.json();
   *     })
   *     .then(function (json) { return json.candles; });
   *
   * The server-side endpoint should keep API keys in env vars (see
   * /api/quote.js for the existing Finnhub proxy pattern).
   */
  function fetchCandles(ticker, period, interval) {
    // ----- MOCK DATA MODE -------------------------------------------
    return new Promise(function (resolve) {
      // Small artificial delay so the loading state is visible.
      setTimeout(function () {
        resolve(generateMockCandles(ticker, period, interval));
      }, 250);
    });
  }

  // ----- Mock candle generator --------------------------------------
  // Produces a deterministic-but-varied set of 5m bars for the requested
  // period, restricted to market hours 9:30-16:00 ET. The values are NOT
  // real prices -- they exist purely to populate the UI.
  function generateMockCandles(ticker, period, interval) {
    var days = parseInt(String(period).replace(/\D/g, ''), 10) || 60;
    var intervalMin = parseInt(String(interval).replace(/\D/g, ''), 10) || 5;
    var barsPerDay = Math.floor((6 * 60 + 30) / intervalMin); // 9:30 -> 16:00

    // Seeded RNG so the same ticker always gives the same series.
    var seed = hashStr(ticker);
    var rand = mulberry32(seed);

    // Per-ticker baseline price.
    var basePrice = 50 + (seed % 350); // 50..400

    var candles = [];
    // Walk backwards from "today" so the newest day is the most recent
    // weekday on the user's clock. We just step a UTC day each loop and
    // skip weekends.
    var cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);

    var addedDays = 0;
    var safety = 0;
    while (addedDays < days && safety < days * 3) {
      safety++;
      var dow = cursor.getUTCDay(); // 0=Sun, 6=Sat
      if (dow !== 0 && dow !== 6) {
        // Build candles for this day starting at 9:30 ET.
        // We treat the date as the calendar date and use UTC offsets only
        // to label each bar's timestamp; the strategy logic uses minute
        // offsets within the day, so DST shifts don't change results.
        var open = basePrice * (0.9 + rand() * 0.2); // drift the base
        basePrice = open; // carry the new base forward (random walk)

        var price = open;
        // Day "personality": which way does it tend to drift?
        var dayTrend = (rand() - 0.5) * 0.04; // -2% .. +2% total
        var volatility = 0.003 + rand() * 0.004; // ~0.3-0.7% per bar

        for (var b = 0; b < barsPerDay; b++) {
          var minuteOfDay = 9 * 60 + 30 + b * intervalMin;
          var t = isoToMs(cursor, minuteOfDay);

          // Drift toward end-of-day target.
          var endTarget = open * (1 + dayTrend);
          var pull = (endTarget - price) / Math.max(1, barsPerDay - b);
          var shock = (rand() - 0.5) * 2 * volatility * price;
          var c = Math.max(0.01, price + pull + shock);
          var o = price;
          var h = Math.max(o, c) * (1 + rand() * volatility * 0.5);
          var l = Math.min(o, c) * (1 - rand() * volatility * 0.5);
          price = c;

          candles.push({
            t: t,
            o: round2(o),
            h: round2(h),
            l: round2(l),
            c: round2(c),
            v: Math.floor(rand() * 100000) + 10000,
            // Minute-of-day is stored so the strategy is timezone-proof.
            minuteOfDay: minuteOfDay,
            dateKey: dateKey(cursor)
          });
        }
        addedDays++;
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    // Sort ascending by timestamp.
    candles.sort(function (a, b) { return a.t - b.t; });
    return candles;
  }

  function isoToMs(dateUTC, minuteOfDay) {
    // Build a timestamp at YYYY-MM-DD 09:30 + minuteOffset UTC. For the
    // mock data the absolute timezone doesn't matter -- we only need
    // unique, sortable timestamps and stable date grouping.
    var d = new Date(dateUTC.getTime());
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMinutes(minuteOfDay);
    return d.getTime();
  }
  function dateKey(d) {
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
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
  function round2(n) { return Math.round(n * 100) / 100; }

  // ====================================================================
  // 4) STRATEGY ENGINE
  // ====================================================================
  /**
   * Apply the first-hour-trend strategy to a flat list of candles.
   *
   * Inputs:
   *   candles[]      -- ordered by time, each has { t, o, h, l, c,
   *                     minuteOfDay, dateKey }
   *   opts.ticker
   *   opts.trendWindowMin  -- minutes (default 60)
   *   opts.dipPct          -- % drop required for down-trend entry
   *   opts.targetPct       -- profit target in %
   *
   * Returns:
   *   { summary: {...}, trades: [...] }
   */
  function runStrategy(candles, opts) {
    var byDay = groupByDay(candles);
    var trades = [];

    Object.keys(byDay).sort().forEach(function (dayKey) {
      var dayBars = byDay[dayKey];
      if (!dayBars.length) return;

      // First-hour boundary: the bar whose minuteOfDay is exactly
      // 9:30 + trendWindowMin (i.e. the close of the first hour).
      var firstHourEndMin = 9 * 60 + 30 + opts.trendWindowMin;
      var firstHourBars = dayBars.filter(function (b) { return b.minuteOfDay <  firstHourEndMin; });
      var laterBars     = dayBars.filter(function (b) { return b.minuteOfDay >= firstHourEndMin; });

      if (firstHourBars.length === 0 || laterBars.length === 0) {
        // Day too short -- skip silently. Could also push a 'no trade' row.
        return;
      }

      var openPrice          = firstHourBars[0].o;
      var firstHourClose     = firstHourBars[firstHourBars.length - 1].c;
      var endOfDayClose      = laterBars[laterBars.length - 1].c;

      var trade = {
        date:      dayKey,
        ticker:    opts.ticker,
        targetPct: opts.targetPct,
        tradeType: 'none', // 'up' | 'down' | 'none'
        buyPrice:  null,
        sellPrice: null,
        plPct:     null,
        targetHit: false
      };

      // ---- Trend up -------------------------------------------------
      if (firstHourClose > openPrice) {
        trade.tradeType = 'up';
        trade.buyPrice  = firstHourClose;
        var upTarget    = trade.buyPrice * (1 + opts.targetPct / 100);

        // Walk the remaining bars looking for the target.
        var hitUp = false;
        for (var i = 0; i < laterBars.length; i++) {
          if (laterBars[i].h >= upTarget) {
            trade.sellPrice = upTarget;
            trade.targetHit = true;
            hitUp = true;
            break;
          }
        }
        if (!hitUp) trade.sellPrice = endOfDayClose;

      // ---- Trend down ----------------------------------------------
      } else if (firstHourClose < openPrice) {
        trade.tradeType = 'down';
        var dipPrice = openPrice * (1 - opts.dipPct / 100);

        // Find the first later bar whose low reaches the dip price.
        var entryIdx = -1;
        for (var j = 0; j < laterBars.length; j++) {
          if (laterBars[j].l <= dipPrice) { entryIdx = j; break; }
        }

        if (entryIdx === -1) {
          // Dip never hit -> no trade taken.
          trade.tradeType = 'none';
        } else {
          trade.buyPrice = dipPrice;
          var downTarget = trade.buyPrice * (1 + opts.targetPct / 100);

          var hitDown = false;
          for (var k = entryIdx; k < laterBars.length; k++) {
            if (laterBars[k].h >= downTarget) {
              trade.sellPrice = downTarget;
              trade.targetHit = true;
              hitDown = true;
              break;
            }
          }
          if (!hitDown) trade.sellPrice = endOfDayClose;
        }

      // ---- Exactly flat -- treat as no trade -----------------------
      } else {
        trade.tradeType = 'none';
      }

      if (trade.tradeType !== 'none' && trade.buyPrice && trade.sellPrice) {
        trade.plPct = (trade.sellPrice - trade.buyPrice) / trade.buyPrice * 100;
      }
      trades.push(trade);
    });

    // Build a per-ticker-per-target summary row.
    var totalDays    = trades.length;
    var taken        = trades.filter(function (t) { return t.tradeType !== 'none'; });
    var noTrade      = trades.filter(function (t) { return t.tradeType === 'none'; });
    var wins         = taken.filter(function (t) { return t.plPct >  0; });
    var losses       = taken.filter(function (t) { return t.plPct <= 0; });
    var sumPL        = taken.reduce(function (s, t) { return s + (t.plPct || 0); }, 0);
    var avgPL        = taken.length ? sumPL / taken.length : 0;
    var best         = taken.reduce(function (m, t) { return (t.plPct > (m ? m.plPct : -Infinity)) ? t : m; }, null);
    var worst        = taken.reduce(function (m, t) { return (t.plPct < (m ? m.plPct :  Infinity)) ? t : m; }, null);

    return {
      summary: {
        ticker:      opts.ticker,
        targetPct:   opts.targetPct,
        totalDays:   totalDays,
        tradesTaken: taken.length,
        noTradeDays: noTrade.length,
        wins:        wins.length,
        losses:      losses.length,
        winRate:     taken.length ? (wins.length / taken.length) * 100 : 0,
        avgPL:       avgPL,
        totalPL:     sumPL,
        bestDay:     best  ? { date: best.date,  plPct: best.plPct  } : null,
        worstDay:    worst ? { date: worst.date, plPct: worst.plPct } : null
      },
      trades: trades
    };
  }

  function groupByDay(candles) {
    var by = {};
    candles.forEach(function (c) {
      var k = c.dateKey || isoDayKey(c.t);
      if (!by[k]) by[k] = [];
      by[k].push(c);
    });
    // Ensure each day is sorted by minuteOfDay.
    Object.keys(by).forEach(function (k) {
      by[k].sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });
    });
    return by;
  }
  function isoDayKey(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' +
           String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
           String(d.getUTCDate()).padStart(2, '0');
  }

  // ====================================================================
  // 5) RENDERING
  // ====================================================================
  function renderSummary() {
    var body = $('#bt-summary-body');
    var empty = $('#bt-summary-empty');
    body.innerHTML = '';
    if (!lastResult || !lastResult.summaries.length) {
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    lastResult.summaries.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        td(s.ticker, 'sym') +
        tdNum(fmtPct(s.targetPct)) +
        tdNum(s.totalDays) +
        tdNum(s.tradesTaken) +
        tdNum(s.noTradeDays) +
        tdNum(s.wins) +
        tdNum(s.losses) +
        tdNum(fmtPct(s.winRate)) +
        tdNum(plCell(s.avgPL)) +
        tdNum(plCell(s.totalPL)) +
        tdNum(s.bestDay  ? s.bestDay.date  + ' (' + plCell(s.bestDay.plPct)  + ')' : '—') +
        tdNum(s.worstDay ? s.worstDay.date + ' (' + plCell(s.worstDay.plPct) + ')' : '—');
      body.appendChild(tr);
    });
  }

  function renderTrades() {
    var body = $('#bt-trades-body');
    var empty = $('#bt-trades-empty');
    body.innerHTML = '';
    if (!lastResult || !lastResult.trades.length) {
      empty.style.display = '';
      return;
    }

    var ft = $('#bt-filter-ticker').value;
    var fg = $('#bt-filter-target').value;
    var fy = $('#bt-filter-type').value;

    var rows = lastResult.trades.filter(function (t) {
      if (ft && t.ticker !== ft) return false;
      if (fg && String(t.targetPct) !== fg) return false;
      if (fy && t.tradeType !== fy) return false;
      return true;
    });

    if (!rows.length) {
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    rows.forEach(function (t) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        td(t.date) +
        td(t.ticker, 'sym') +
        tdNum(fmtPct(t.targetPct)) +
        td(typePill(t.tradeType)) +
        tdNum(t.buyPrice  != null ? '$' + t.buyPrice.toFixed(2)  : '—') +
        tdNum(t.sellPrice != null ? '$' + t.sellPrice.toFixed(2) : '—') +
        tdNum(t.plPct != null ? plCell(t.plPct) : '—') +
        td(t.tradeType === 'none' ? '<span class="bt-pill bt-pill-none">N/A</span>'
                                  : (t.targetHit ? '<span class="bt-pill bt-pill-up">true</span>'
                                                 : '<span class="bt-pill bt-pill-down">false</span>'));
      body.appendChild(tr);
    });
  }

  function populateFilters(summaries) {
    var tickerSel = $('#bt-filter-ticker');
    var targetSel = $('#bt-filter-target');
    var tickers = Array.from(new Set(summaries.map(function (s) { return s.ticker; })));
    var targets = Array.from(new Set(summaries.map(function (s) { return s.targetPct; })));

    tickerSel.innerHTML = '<option value="">All tickers</option>' +
      tickers.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('');
    targetSel.innerHTML = '<option value="">All targets</option>' +
      targets.map(function (g) { return '<option value="' + g + '">' + fmtPct(g) + '</option>'; }).join('');
  }

  // ----- Tiny rendering helpers -------------------------------------
  function td(content, klass) {
    return '<td' + (klass ? ' class="' + klass + '"' : '') + '>' + content + '</td>';
  }
  function tdNum(content) { return '<td class="num">' + content + '</td>'; }
  function fmtPct(n) {
    if (!isFinite(n)) return '0.00%';
    return (Math.round(n * 100) / 100).toFixed(2) + '%';
  }
  function plCell(n) {
    if (!isFinite(n)) return '<span class="bt-pl-flat">0.00%</span>';
    var cls = n > 0 ? 'bt-pl-pos' : (n < 0 ? 'bt-pl-neg' : 'bt-pl-flat');
    var sign = n > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + n.toFixed(2) + '%</span>';
  }
  function typePill(t) {
    if (t === 'up')   return '<span class="bt-pill bt-pill-up">Trending up</span>';
    if (t === 'down') return '<span class="bt-pill bt-pill-down">Trending down</span>';
    return '<span class="bt-pill bt-pill-none">No trade</span>';
  }

  // ----- Loading / error UI -----------------------------------------
  function setLoading(on) {
    $('#bt-loading').classList.toggle('show', !!on);
  }
  function showError(msg) {
    var el = $('#bt-error');
    if (!msg) { el.classList.remove('show'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.add('show');
  }
})();
