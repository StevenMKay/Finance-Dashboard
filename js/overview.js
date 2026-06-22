/* Overview tab — KPI tiles + allocation chart + market overview widget.
 * Re-renders on accounts/holdings/quotes changes. */
(function () {
  var allocChart = null;
  var state = { accounts: [], holdings: [], quotes: {} };
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
    dayKpi.classList.add(dayPL > 0 ? 'up' : (dayPL < 0 ? 'down' : ''));

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

    if (!labels.length) {
      if (allocChart) { allocChart.destroy(); allocChart = null; }
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      var legend = FU.$('#alloc-legend');
      legend.innerHTML = '<div class="empty"><i class="fa-regular fa-chart-pie"></i>Add accounts or holdings to see allocation.</div>';
      return;
    }

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
    FinanceTV.marketOverview('tv-market-overview');
    marketMounted = true;
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
  }

  window.FinanceOverview = {
    init: init,
    setAccounts:  function (a) { state.accounts  = a || []; recompute(); },
    setHoldings:  function (h) { state.holdings  = h || []; recompute(); },
    setQuotes:    function (q) { state.quotes    = q || {}; recompute(); }
  };
})();
