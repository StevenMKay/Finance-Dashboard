/* Trade Replay — Phase G
 * --------------------------------------------------------------------
 * Uses TradingView's open-source lightweight-charts (MIT) to animate
 * intraday candles for one day, with markers for trend / buy / sell /
 * stop. Beginner-friendly: one create call, one update call per frame.
 *
 * Public:
 *   BTReplay.load(containerId, dayBars, trade) -> {play, pause, reset, seek, isPlaying}
 *
 * Notes:
 *   - `dayBars` are the raw 5m bars for ONE trading day.
 *   - `trade` is the corresponding tradeRow (or null for no-trade days).
 *   - Returns a controller object so the host page can wire UI buttons.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  function load(containerId, dayBars, trade) {
    var el = document.getElementById(containerId);
    if (!el) return null;
    el.innerHTML = '';

    if (typeof LightweightCharts === 'undefined') {
      el.innerHTML = '<div class="empty" style="display:block;">Lightweight-charts failed to load.</div>';
      return null;
    }

    var chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: 360,
      layout: { background: { color: '#ffffff' }, textColor: '#1a202c' },
      grid: { vertLines: { color: '#eef2f7' }, horzLines: { color: '#eef2f7' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#d0d5dd' }
    });
    var series = chart.addCandlestickSeries({
      upColor: '#2f9e44', downColor: '#c0392b',
      borderUpColor: '#2f9e44', borderDownColor: '#c0392b',
      wickUpColor: '#2f9e44', wickDownColor: '#c0392b'
    });

    // lightweight-charts wants UTC seconds.
    var fullData = dayBars.map(function (b) {
      return { time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c };
    });

    var visible = 0;
    var timer = null;
    var speed = 1;
    var playing = false;

    function applyMarkers(upTo) {
      var markers = [];
      // First-hour boundary marker
      if (trade && trade.firstHourClose != null) {
        var fhEnd = trade.entryTime;
        if (trade.tradeType === 'down' && trade.entryTime) {
          // For down-trend trades the entryTime is the dip bar, not the
          // first-hour boundary. Find the boundary bar by scanning.
          for (var i = 0; i < fullData.length; i++) {
            if ((fullData[i].time * 1000) >= (dayBars[0].t + 60 * 60000)) { // 60 min after open
              fhEnd = fullData[i].time * 1000;
              break;
            }
          }
        }
        if (fhEnd && (fhEnd / 1000) <= fullData[upTo - 1].time) {
          markers.push({
            time: Math.floor(fhEnd / 1000),
            position: 'aboveBar',
            color: '#dd6b20',
            shape: 'circle',
            text: 'Trend ' + (trade.trend || '-')
          });
        }
      }
      if (trade && trade.tradeType !== 'none' && trade.entryTime &&
          (trade.entryTime / 1000) <= fullData[upTo - 1].time) {
        markers.push({
          time: Math.floor(trade.entryTime / 1000),
          position: 'belowBar', color: '#2980b9', shape: 'arrowUp',
          text: 'Buy ' + fmtMoney(trade.buyPrice)
        });
      }
      if (trade && trade.tradeType !== 'none' && trade.exitTime &&
          (trade.exitTime / 1000) <= fullData[upTo - 1].time) {
        var col = (trade.exitReason === 'stop') ? '#c0392b'
                : (trade.exitReason === 'target') ? '#2f9e44' : '#718096';
        markers.push({
          time: Math.floor(trade.exitTime / 1000),
          position: 'aboveBar', color: col, shape: 'arrowDown',
          text: 'Sell ' + fmtMoney(trade.sellPrice) + ' (' + (trade.profitPct >= 0 ? '+' : '') + trade.profitPct.toFixed(2) + '%)'
        });
      }
      series.setMarkers(markers);
    }

    function seek(n) {
      visible = Math.max(0, Math.min(fullData.length, n));
      if (visible === 0) {
        series.setData([]);
        series.setMarkers([]);
        return;
      }
      series.setData(fullData.slice(0, visible));
      applyMarkers(visible);
      if (visible === fullData.length) chart.timeScale().fitContent();
    }

    function step() {
      if (visible >= fullData.length) { pause(); return; }
      seek(visible + 1);
      if (window.BTLab && window.BTLab.onReplayTick) window.BTLab.onReplayTick(visible, fullData.length);
    }

    function play() {
      if (playing || visible >= fullData.length) return;
      playing = true;
      var interval = Math.max(40, 240 / speed);
      timer = setInterval(step, interval);
    }
    function pause() {
      playing = false;
      if (timer) { clearInterval(timer); timer = null; }
    }
    function reset() {
      pause();
      seek(0);
    }

    // Initial paint: first bar.
    seek(1);

    // Resize handling
    var ro = new ResizeObserver(function () { chart.applyOptions({ width: el.clientWidth }); });
    ro.observe(el);

    return {
      play: play, pause: pause, reset: reset, seek: seek,
      isPlaying: function () { return playing; },
      setSpeed: function (s) { speed = +s || 1; if (playing) { pause(); play(); } },
      length: function () { return fullData.length; },
      position: function () { return visible; },
      destroy: function () { pause(); try { ro.disconnect(); chart.remove(); } catch (e) {} el.innerHTML = ''; }
    };
  }

  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '—';
    return '$' + (Math.round(n * 100) / 100).toFixed(2);
  }

  window.BTReplay = { load: load };
})();
