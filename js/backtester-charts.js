/* Strategy Lab charts — Phases E, F, I
 * --------------------------------------------------------------------
 * Thin Chart.js wrappers. Each renderer accepts plain data and writes
 * into a <canvas> by id. All charts are destroyed and recreated on
 * every render so re-running a backtest never leaks old state.
 *
 * Public:
 *   BTCharts.equity(canvasId, trades)
 *   BTCharts.drawdown(canvasId, trades)
 *   BTCharts.monthly(canvasId, trades)
 *   BTCharts.histogram(canvasId, trades)
 *   BTCharts.duration(canvasId, trades)
 *   BTCharts.calendar(containerId, trades)
 *   BTCharts.heatmap(canvasId, rows, metric, axisKeys)
 *   BTCharts.compareEquity(canvasId, byTickerTrades)
 *   BTCharts.mcHistogram(canvasId, finalReturns)
 *   BTCharts.mcSpaghetti(canvasId, equityPaths)
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var instances = {}; // canvasId -> Chart

  // -------------------------------------------------------------------
  // Chart palette — read from CSS custom properties so the chart colors
  // re-skin automatically when /css/style.css tokens change.
  // Falls back to literal hex if the page is rendered without the
  // shared stylesheet (e.g. a unit test in jsdom).
  // -------------------------------------------------------------------
  function cssVar(name, fallback) {
    if (typeof window === 'undefined' || !document || !document.documentElement) return fallback;
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  var PALETTE = {
    equity:    cssVar('--chart-equity',    '#20B26B'),
    benchmark: cssVar('--chart-benchmark', '#42C7E8'),
    drawdown:  cssVar('--chart-drawdown',  '#D9534F'),
    monte:     cssVar('--chart-monte',     '#67D9DA'),
    brand:     cssVar('--c-brand',         '#055050'),
    brandLite: cssVar('--c-brand-light',   '#0D7A7A'),
    accent:    cssVar('--c-accent',        '#F4B740'),
    heat: [
      cssVar('--chart-heat-1', '#CCEDE9'),
      cssVar('--chart-heat-2', '#67D9DA'),
      cssVar('--chart-heat-3', '#0D7A7A'),
      cssVar('--chart-heat-4', '#055050')
    ]
  };
  function withAlpha(hex, a) {
    var n = parseInt(hex.replace('#', ''), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function destroy(id) {
    if (instances[id]) { try { instances[id].destroy(); } catch (e) {} delete instances[id]; }
  }
  function ctx(id) {
    var el = document.getElementById(id);
    return el ? el.getContext('2d') : null;
  }

  function plColor(n) {
    return n >= 0 ? withAlpha(PALETTE.equity, 0.85) : withAlpha(PALETTE.drawdown, 0.85);
  }

  // -------------------- Equity curve --------------------
  function equity(canvasId, trades) {
    destroy(canvasId);
    var taken = trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; });
    var cum = 0;
    var data = taken.map(function (t) { cum += t.profitPct; return { x: t.date, y: cum }; });
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'line',
      data: {
        labels: data.map(function (d) { return d.x; }),
        datasets: [{
          label: 'Cumulative P/L %',
          data: data.map(function (d) { return d.y; }),
          fill: true, tension: 0.2,
          borderColor: PALETTE.equity,
          backgroundColor: withAlpha(PALETTE.equity, 0.15)
        }]
      },
      options: chartOpts({ y: { ticks: { callback: function (v) { return v.toFixed(1) + '%'; } } } })
    });
  }

  // -------------------- Drawdown --------------------
  function drawdown(canvasId, trades) {
    destroy(canvasId);
    var taken = trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; });
    var cum = 0, peak = 0;
    var data = taken.map(function (t) {
      cum += t.profitPct;
      if (cum > peak) peak = cum;
      return { x: t.date, y: cum - peak }; // <= 0
    });
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'line',
      data: {
        labels: data.map(function (d) { return d.x; }),
        datasets: [{
          label: 'Drawdown %',
          data: data.map(function (d) { return d.y; }),
          fill: true, tension: 0.1,
          borderColor: PALETTE.drawdown,
          backgroundColor: withAlpha(PALETTE.drawdown, 0.18)
        }]
      },
      options: chartOpts({ y: { ticks: { callback: function (v) { return v.toFixed(1) + '%'; } } } })
    });
  }

  // -------------------- Monthly bars --------------------
  function monthly(canvasId, trades) {
    destroy(canvasId);
    var by = {};
    trades.forEach(function (t) {
      if (t.profitPct == null) return;
      var key = (t.date || '').slice(0, 7);
      if (!key) return;
      by[key] = (by[key] || 0) + t.profitPct;
    });
    var keys = Object.keys(by).sort();
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'bar',
      data: {
        labels: keys,
        datasets: [{
          label: 'Month P/L %',
          data: keys.map(function (k) { return by[k]; }),
          backgroundColor: keys.map(function (k) { return plColor(by[k]); })
        }]
      },
      options: chartOpts({ y: { ticks: { callback: function (v) { return v.toFixed(1) + '%'; } } } })
    });
  }

  // -------------------- Distribution histogram --------------------
  function histogram(canvasId, trades) {
    destroy(canvasId);
    var vals = trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; })
                     .map(function (t) { return t.profitPct; });
    var bins = bucketize(vals, 20);
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'bar',
      data: {
        labels: bins.labels,
        datasets: [{
          label: 'Trades',
          data: bins.counts,
          backgroundColor: bins.centers.map(plColor)
        }]
      },
      options: chartOpts({})
    });
  }

  // -------------------- Duration histogram --------------------
  function duration(canvasId, trades) {
    destroy(canvasId);
    var vals = trades.filter(function (t) { return t.tradeType !== 'none' && t.holdingMinutes > 0; })
                     .map(function (t) { return t.holdingMinutes; });
    var bins = bucketize(vals, 15);
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'bar',
      data: {
        labels: bins.labels,
        datasets: [{
          label: 'Trades',
          data: bins.counts,
          backgroundColor: withAlpha(PALETTE.brandLite, 0.7)
        }]
      },
      options: chartOpts({})
    });
  }

  // -------------------- Win/Loss calendar --------------------
  function calendar(containerId, trades) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    var byDate = {};
    trades.forEach(function (t) { if (t.profitPct != null) byDate[t.date] = t.profitPct; });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) { el.innerHTML = '<div class="muted" style="font-size:12px;">No trades.</div>'; return; }

    // Build a calendar from first month to last.
    var first = new Date(dates[0] + 'T00:00:00Z');
    var last  = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    first.setUTCDate(1);
    last.setUTCDate(28);

    var max = 0;
    dates.forEach(function (d) { if (Math.abs(byDate[d]) > max) max = Math.abs(byDate[d]); });
    max = max || 1;

    var html = '<div class="bt-cal">';
    // Day-of-week headers
    ['S','M','T','W','T','F','S'].forEach(function (h) {
      html += '<div style="text-align:center; font-weight:700; color:var(--c-text-muted);">' + h + '</div>';
    });
    var cur = new Date(first.getTime());
    // Pad with empty cells for the first week.
    for (var i = 0; i < cur.getUTCDay(); i++) html += '<div></div>';
    while (cur <= last) {
      var key = cur.getUTCFullYear() + '-' + pad2(cur.getUTCMonth() + 1) + '-' + pad2(cur.getUTCDate());
      var pl = byDate[key];
      if (pl == null) {
        html += '<div class="bt-cal-cell"><span class="d">' + cur.getUTCDate() + '</span></div>';
      } else {
        var intensity = Math.min(1, Math.abs(pl) / max);
        var bg = pl >= 0
          ? withAlpha(PALETTE.equity,   (0.25 + intensity * 0.65))
          : withAlpha(PALETTE.drawdown, (0.25 + intensity * 0.65));
        html += '<div class="bt-cal-cell has-trade" title="' + key + ': ' + (pl >= 0 ? '+' : '') + pl.toFixed(2) + '%" ' +
                'style="background:' + bg + '; border-color: transparent;">' +
                '<span class="d">' + cur.getUTCDate() + '</span>' +
                '<span>' + (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%</span>' +
                '</div>';
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // -------------------- Heatmap (Phase E) --------------------
  // rows = optimizer rows already filtered to a single ticker × firstHour × stop.
  // We render a matrix with x = targetPct, y = dipPct, color = metric value.
  function heatmap(canvasId, rows, metric, axisKeys) {
    destroy(canvasId);
    if (typeof Chart === 'undefined' || !Chart.controllers || !Chart.controllers.matrix) {
      // chartjs-chart-matrix missing — graceful degrade.
      var c = document.getElementById(canvasId);
      if (c) c.outerHTML = '<div class="empty" style="display:block;">Heatmap plugin failed to load.</div>';
      return;
    }
    var targets = axisKeys.targets;
    var dips    = axisKeys.dips;

    // Build a fast lookup.
    var look = {};
    rows.forEach(function (r) { look[r.dipPct + '|' + r.targetPct] = r; });

    var data = [];
    var values = [];
    dips.forEach(function (d) {
      targets.forEach(function (t) {
        var r = look[d + '|' + t];
        var v = r ? r[metric] : null;
        if (v != null && isFinite(v)) values.push(v);
        data.push({ x: t, y: d, v: v });
      });
    });

    var vMin = Math.min.apply(null, values.length ? values : [0]);
    var vMax = Math.max.apply(null, values.length ? values : [1]);
    var span = vMax - vMin || 1;

    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'matrix',
      data: {
        datasets: [{
          label: metric,
          data: data,
          backgroundColor: function (c) {
            var v = c.dataset.data[c.dataIndex].v;
            if (v == null) return 'rgba(0,0,0,0.04)';
            var t = (v - vMin) / span;
            return interpColor(t);
          },
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.6)',
          width:  function (c) { return (c.chart.chartArea || {}).width  / targets.length - 4; },
          height: function (c) { return (c.chart.chartArea || {}).height / dips.length    - 4; }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function () { return ''; },
              label: function (c) {
                var d = c.dataset.data[c.dataIndex];
                return ['Dip: ' + d.y + '%  Target: ' + d.x + '%',
                        metric + ': ' + (d.v != null ? d.v.toFixed(2) : 'n/a')];
              }
            }
          }
        },
        scales: {
          x: { type: 'category', labels: targets.map(String), title: { display: true, text: 'Target %' } },
          y: { type: 'category', labels: dips.map(String).reverse(), title: { display: true, text: 'Dip %' }, reverse: true }
        },
        onClick: function (evt, items) {
          if (!items.length) return;
          var d = items[0].element.$context.dataset.data[items[0].index];
          if (window.BTLab && window.BTLab.onHeatmapClick) {
            window.BTLab.onHeatmapClick({ dipPct: d.y, targetPct: d.x });
          }
        }
      }
    });
  }
  function interpColor(t) {
    // Teal gradient — light teal → mid teal → deep brand teal.
    // Replaces the old red → yellow → green rainbow so heatmaps fit
    // the new design system. Tokens come from CSS so a theme tweak
    // here just needs a token change in /css/style.css.
    t = Math.max(0, Math.min(1, t));
    var stops = PALETTE.heat; // 4 colors
    var seg = t * (stops.length - 1);
    var i = Math.floor(seg);
    var k = seg - i;
    if (i >= stops.length - 1) return stops[stops.length - 1];
    return mixHex(stops[i], stops[i + 1], k);
  }
  function mixHex(a, b, k) {
    var pa = parseInt(a.replace('#', ''), 16);
    var pb = parseInt(b.replace('#', ''), 16);
    var r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * k);
    var g = Math.round(((pa >> 8)  & 255) + (((pb >> 8)  & 255) - ((pa >> 8)  & 255)) * k);
    var c = Math.round((pa & 255)         + ((pb & 255)         - (pa & 255))         * k);
    return 'rgb(' + r + ',' + g + ',' + c + ')';
  }

  // -------------------- Compare equity overlay (Phase H) --------------------
  function compareEquity(canvasId, byTicker) {
    destroy(canvasId);
    var tickers = Object.keys(byTicker);
    if (!tickers.length) return;
    // Use trade indices as the x-axis so different-length series overlay cleanly.
    var maxLen = 0;
    var sets = tickers.map(function (tk, i) {
      var trades = byTicker[tk] || [];
      var cum = 0;
      var arr = trades.filter(function (t) { return t.profitPct != null && t.tradeType !== 'none'; })
                      .map(function (t) { cum += t.profitPct; return cum; });
      if (arr.length > maxLen) maxLen = arr.length;
      return {
        label: tk,
        data: arr,
        borderColor: paletteColor(i),
        backgroundColor: paletteColor(i, 0.12),
        tension: 0.2, fill: false
      };
    });
    var labels = [];
    for (var i = 1; i <= maxLen; i++) labels.push(i);
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'line',
      data: { labels: labels, datasets: sets },
      options: chartOpts({
        x: { title: { display: true, text: 'Trade #' } },
        y: { ticks: { callback: function (v) { return v.toFixed(1) + '%'; } } }
      })
    });
  }

  // -------------------- Monte Carlo viz (Phase I) --------------------
  function mcHistogram(canvasId, finalReturns) {
    destroy(canvasId);
    var bins = bucketize(finalReturns, 30);
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'bar',
      data: {
        labels: bins.labels,
        datasets: [{
          label: 'Simulations',
          data: bins.counts,
          backgroundColor: bins.centers.map(plColor)
        }]
      },
      options: chartOpts({})
    });
  }

  function mcSpaghetti(canvasId, paths) {
    destroy(canvasId);
    var sets = paths.map(function (p, i) {
      return {
        data: p,
        borderColor: withAlpha(PALETTE.monte, (0.10 + (i % 7) * 0.025)),
        borderWidth: 1,
        pointRadius: 0,
        tension: 0.05,
        fill: false
      };
    });
    var maxLen = paths.reduce(function (m, p) { return Math.max(m, p.length); }, 0);
    var labels = [];
    for (var i = 0; i <= maxLen; i++) labels.push(i);
    instances[canvasId] = new Chart(ctx(canvasId), {
      type: 'line',
      data: { labels: labels.slice(0, maxLen), datasets: sets },
      options: chartOpts({ plugins: { legend: { display: false } }, y: { ticks: { callback: function (v) { return v.toFixed(0) + '%'; } } } })
    });
  }

  // -------------------- Common helpers --------------------
  function chartOpts(overrides) {
    var base = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { ticks: { font: { size: 10 } } }
      }
    };
    return deepMerge(base, overrides || {});
  }
  function deepMerge(a, b) {
    for (var k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        a[k] = deepMerge(a[k] || {}, b[k]);
      } else {
        a[k] = b[k];
      }
    }
    return a;
  }
  function bucketize(vals, n) {
    if (!vals.length) return { labels: [], counts: [], centers: [] };
    var lo = Math.min.apply(null, vals);
    var hi = Math.max.apply(null, vals);
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    var w = (hi - lo) / n;
    var counts = new Array(n).fill(0);
    vals.forEach(function (v) {
      var idx = Math.min(n - 1, Math.floor((v - lo) / w));
      counts[idx]++;
    });
    var labels = [], centers = [];
    for (var i = 0; i < n; i++) {
      var l = lo + i * w, h = l + w;
      labels.push(l.toFixed(2) + '–' + h.toFixed(2));
      centers.push((l + h) / 2);
    }
    return { labels: labels, counts: counts, centers: centers };
  }
  function paletteColor(i, alpha) {
    // Compare-equity multi-ticker palette — teal-forward but with enough
    // hue variation to keep tickers distinguishable. Limited to 8 entries;
    // wraps around after that. To change the design, edit this array.
    var colors = ['#055050', '#20B26B', '#42C7E8', '#0D7A7A',
                  '#F4B740', '#D9534F', '#067A6A', '#9A6BBF'];
    var c = colors[i % colors.length];
    if (alpha != null) {
      var rgb = hexToRgb(c);
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
    }
    return c;
  }
  function hexToRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  window.BTCharts = {
    equity: equity,
    drawdown: drawdown,
    monthly: monthly,
    histogram: histogram,
    duration: duration,
    calendar: calendar,
    heatmap: heatmap,
    compareEquity: compareEquity,
    mcHistogram: mcHistogram,
    mcSpaghetti: mcSpaghetti,
    destroy: destroy
  };
})();
