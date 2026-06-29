/* Overview tab — KPI tiles + allocation chart + market overview widget.
 * Re-renders on accounts/holdings/quotes changes. */
(function () {
  var allocChart = null;
  var state = { accounts: [], holdings: [], quotes: {}, watchlist: [] };
  var marketMounted = false;

  function recompute() {
    var accountsTotal = state.accounts.reduce(function (s, a) { return s + FU.safeNum(a.balance, 0); }, 0);
    var cashTotal = state.accounts
      .filter(function (a) { return ['checking', 'savings', 'cash'].indexOf(a.type) >= 0; })
      .reduce(function (s, a) { return s + FU.safeNum(a.balance, 0); }, 0);

    var holdingsMV = 0, dayPL = 0;
    state.holdings.forEach(function (h) {
      var q = state.quotes[h.symbol];
      var px = q ? q.c : 0;
      var pc = q ? q.pc : 0;
      var sh = FU.safeNum(h.shares, 0);
      holdingsMV += px * sh;
      dayPL += (px - pc) * sh;
    });

    var net = accountsTotal + holdingsMV;
    var dayPct = (holdingsMV - dayPL) !== 0 ? (dayPL / (holdingsMV - dayPL)) : 0;

    FU.$('#kpi-net').textContent  = FU.money(net);
    FU.$('#kpi-hold').textContent = FU.money(holdingsMV);
    FU.$('#kpi-hold-sub').textContent = 'across ' + state.holdings.length + ' position' + (state.holdings.length === 1 ? '' : 's');

    var dayEl = FU.$('#kpi-day');
    var dayKpi = dayEl.closest('.kpi');
    dayEl.textContent = FU.delta(dayPL);
    FU.$('#kpi-day-pct').textContent = FU.pctRaw(dayPct * 100);
    dayKpi.classList.remove('up', 'down', 'warn');
    // classList.add('') throws DOMException — only add when there's a class to add.
    if (dayPL > 0)      dayKpi.classList.add('up');
    else if (dayPL < 0) dayKpi.classList.add('down');

    var cashPct = net > 0 ? (cashTotal / net) : 0;
    FU.$('#kpi-cash').textContent = (cashPct * 100).toFixed(1) + '%';
    FU.$('#kpi-cash-sub').textContent = FU.money(cashTotal) + ' in cash accounts';

    renderAlloc(net, holdingsMV);
  }

  function renderAlloc(net, holdingsMV) {
    // Group accounts by type
    var groups = {};
    state.accounts.forEach(function (a) {
      groups[a.type] = (groups[a.type] || 0) + FU.safeNum(a.balance, 0);
    });
    // Add holdings as one segment (or per-symbol if few)
    var labels = [], values = [];
    Object.keys(groups).forEach(function (k) {
      if (groups[k] !== 0) { labels.push(typeLabel(k)); values.push(groups[k]); }
    });
    if (holdingsMV > 0) {
      if (state.holdings.length <= 8) {
        state.holdings.forEach(function (h) {
          var q = state.quotes[h.symbol];
          var v = (q ? q.c : 0) * FU.safeNum(h.shares, 0);
          if (v > 0) { labels.push(h.symbol); values.push(v); }
        });
      } else {
        labels.push('Stock holdings'); values.push(holdingsMV);
      }
    }

    var colors = ['#1a2744', '#27ae60', '#2980b9', '#8e44ad', '#f39c12', '#e74c3c', '#16a085', '#34495e', '#d35400', '#7f8c8d', '#3498db', '#c0392b'];
    var ctx = FU.$('#allocChart').getContext('2d');
    var emptyEl = FU.$('#alloc-empty');
    var chartCanvas = FU.$('#allocChart');
    var legendBox = FU.$('#alloc-legend');

    if (!labels.length) {
      if (allocChart) { allocChart.destroy(); allocChart = null; }
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      // Hide the donut + legend grid, surface the dedicated empty state
      // instead so the card doesn't have a tall blank canvas.
      if (chartCanvas && chartCanvas.parentNode && chartCanvas.parentNode.parentNode) {
        chartCanvas.parentNode.parentNode.style.display = 'none';
      }
      legendBox.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (chartCanvas && chartCanvas.parentNode && chartCanvas.parentNode.parentNode) {
      chartCanvas.parentNode.parentNode.style.display = '';
    }
    if (emptyEl) emptyEl.style.display = 'none';

    if (allocChart) {
      allocChart.data.labels = labels;
      allocChart.data.datasets[0].data = values;
      allocChart.data.datasets[0].backgroundColor = labels.map(function (_, i) { return colors[i % colors.length]; });
      allocChart.update();
    } else {
      allocChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: values,
            backgroundColor: labels.map(function (_, i) { return colors[i % colors.length]; }),
            borderWidth: 2, borderColor: '#fff'
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (c) {
                  var v = c.parsed;
                  var pct = net > 0 ? (v / net * 100) : 0;
                  return c.label + ': ' + FU.money(v) + ' (' + pct.toFixed(1) + '%)';
                }
              }
            }
          }
        }
      });
    }
    var total = values.reduce(function (a, b) { return a + b; }, 0);
    var legend = FU.$('#alloc-legend');
    legend.innerHTML = '';
    labels.forEach(function (l, i) {
      var v = values[i];
      var p = total > 0 ? (v / total * 100) : 0;
      var row = FU.el('div', { class: 'result-row' }, [
        FU.el('span', { class: 'lbl' }, [
          FU.el('span', { style: { display:'inline-block', width:'10px', height:'10px', borderRadius:'2px', background: colors[i % colors.length], marginRight:'8px', verticalAlign:'middle' }}),
          l
        ]),
        FU.el('span', { class: 'val' }, [FU.money(v) + '  (' + p.toFixed(1) + '%)'])
      ]);
      legend.appendChild(row);
    });
  }

  function typeLabel(t) {
    return ({
      checking:'Checking', savings:'Savings', brokerage:'Brokerage',
      retirement:'Retirement', cash:'Cash', crypto:'Crypto', other:'Other'
    })[t] || t;
  }

  function ensureMarketWidget() {
    if (marketMounted) return;
    FinanceTV.marketOverview('tv-market-overview', { extraTabs: customTabs() });
    marketMounted = true;
  }

  // ---- Custom symbols (user-added entries in the Market overview) ----
  var MO_LS = 'fd.marketOverview.custom';   // array of TV symbol strings
  function loadCustom() {
    try { var raw = localStorage.getItem(MO_LS); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function saveCustom(list) {
    try { localStorage.setItem(MO_LS, JSON.stringify(list)); } catch (e) {}
  }
  function customTabs() {
    var tabs = [];
    var list = loadCustom();
    if (list.length) {
      tabs.push({
        title: 'Custom',
        symbols: list.map(function (s) { return { s: s }; }),
        originalTitle: 'Custom'
      });
    }
    // Watchlist tab — user-added items from the Watchlist tab show up
    // here too so the Market Overview is a single source of truth.
    var watchSyms = (state.watchlist || [])
      .map(function (w) { return w && w.symbol ? String(w.symbol).toUpperCase() : null; })
      .filter(Boolean);
    if (watchSyms.length) {
      tabs.push({
        title: 'Watchlist',
        // TradingView resolves bare symbols, but prefixing keeps the
        // logo + sparkline accurate. Custom-tab entries that already
        // have a prefix are left untouched.
        symbols: watchSyms.map(function (s) {
          return { s: s.indexOf(':') === -1 ? 'NASDAQ:' + s : s };
        }),
        originalTitle: 'Watchlist'
      });
    }
    return tabs;
  }
  function normalizeSymbol(input) {
    var s = String(input || '').trim().toUpperCase();
    if (!s) return '';
    // If the user typed a bare ticker, assume NASDAQ. TradingView accepts
    // EXCHANGE:SYMBOL — anything with a colon we leave alone.
    if (s.indexOf(':') === -1) return 'NASDAQ:' + s.replace(/[^A-Z0-9.\-]/g, '');
    return s.replace(/[^A-Z0-9.:\-]/g, '');
  }
  function renderCustomChips() {
    var host = FU.$('#mo-custom-chips');
    if (!host) return;
    var list = loadCustom();
    if (!list.length) { host.innerHTML = ''; return; }
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    }
    host.innerHTML = list.map(function (sym, i) {
      var safe = esc(sym);
      return '<span class="bt-chip" style="display:inline-flex; align-items:center; gap:6px; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; padding:3px 8px; border-radius:999px; font-size:12px;">' +
        safe +
        '<button type="button" data-mo-remove="' + i + '" aria-label="Remove ' + safe + '" style="background:none; border:0; color:inherit; cursor:pointer; font-size:14px; padding:0; line-height:1;">&times;</button>' +
      '</span>';
    }).join('');
    host.querySelectorAll('[data-mo-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-mo-remove'), 10);
        var arr = loadCustom();
        arr.splice(idx, 1);
        saveCustom(arr);
        renderCustomChips();
        remountMarket();
      });
    });
  }
  function remountMarket() {
    // TradingView widgets cannot be re-configured in place — clear and remount.
    var el = FU.$('#tv-market-overview');
    if (!el) return;
    el.innerHTML = '';
    marketMounted = false;
    FinanceTV.marketOverview('tv-market-overview', { extraTabs: customTabs() });
    marketMounted = true;
  }
  function initCustomControls() {
    var input = FU.$('#mo-custom-input');
    var addBtn = FU.$('#mo-custom-add');
    var clearBtn = FU.$('#mo-custom-clear');
    if (!input || !addBtn) return;

    function addNow() {
      var sym = normalizeSymbol(input.value);
      if (!sym) return;
      var arr = loadCustom();
      if (arr.indexOf(sym) === -1) arr.push(sym);
      saveCustom(arr);
      input.value = '';
      renderCustomChips();
      remountMarket();
    }
    addBtn.addEventListener('click', addNow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addNow(); }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (!loadCustom().length) return;
        if (!confirm('Clear all custom market-overview symbols?')) return;
        saveCustom([]);
        renderCustomChips();
        remountMarket();
      });
    }
    renderCustomChips();
  }

  function init() {
    FU.$('#btn-refresh-now').addEventListener('click', function () {
      FinanceQuotes.refreshNow();
      FU.toast('Refreshing…', 'ok', 1200);
    });
    document.addEventListener('fd:tab', function (e) {
      if (e.detail.name === 'overview') ensureMarketWidget();
    });
    if (FU.$('#tab-overview').classList.contains('active')) ensureMarketWidget();
    initCustomControls();
  }

  window.FinanceOverview = {
    init: init,
    setAccounts:  function (a) { state.accounts  = a || []; recompute(); },
    setHoldings:  function (h) { state.holdings  = h || []; recompute(); },
    setQuotes:    function (q) { state.quotes    = q || {}; recompute(); },
    setWatchlist: function (w) {
      // Cache + remount the Market Overview widget so its "Watchlist" tab
      // reflects what the user has saved. We only remount when the widget
      // was already mounted; otherwise the next ensureMarketWidget() call
      // will pick up the new list naturally.
      state.watchlist = w || [];
      if (marketMounted) remountMarket();
    }
  };
})();
