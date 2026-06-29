/* Live quote engine.
 *
 *  - GET /api/quote?symbols=AAPL,MSFT  →  { AAPL: {c, d, dp, h, l, o, pc, t}, ... }
 *  - Polls every REFRESH_MS while document is visible; pauses on hidden.
 *  - Maintains a Set of subscribed symbols; merges watchlist + holdings.
 *  - Caches the latest snapshot in memory and notifies listeners.
 */
(function () {
  var REFRESH_MS = 30 * 1000;
  var symbols = new Set();
  var listeners = new Set();
  var cache = Object.create(null); // { SYMBOL: { c, d, dp, h, l, o, pc, t, _at } }
  var timer = null;
  var inflight = null;

  // ---------------------------------------------------------------------
  // Static-host short-circuit.
  //
  // The /api/quote endpoint is a Vercel serverless function. GitHub Pages
  // (where the project also publishes) has no serverless runtime, so the
  // first request returns 404 and we should not bother retrying \u2014 every
  // poll cycle would spam the console + toast the user. We disable
  // polling permanently after the first 404, and skip it up-front when
  // we detect a hostname that we know does not host /api/*.
  // ---------------------------------------------------------------------
  var STATIC_HOSTS = [
    'github.io',          // GitHub Pages (any *.github.io domain)
    'localhost',          // local file servers / `python -m http.server`
    '127.0.0.1',
    ''                    // file:// protocol leaves hostname empty
  ];
  var quotesDisabled = (function () {
    try {
      var h = (location.hostname || '').toLowerCase();
      return STATIC_HOSTS.some(function (s) { return s && h.indexOf(s) !== -1; }) || !h;
    } catch (_) { return false; }
  })();

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(getSnapshot()); } catch (e) { console.warn('[quotes] listener err', e); }
    });
  }

  function getSnapshot() {
    var out = {};
    symbols.forEach(function (s) { if (cache[s]) out[s] = cache[s]; });
    return out;
  }

  function setSymbols(list) {
    var next = new Set();
    (list || []).forEach(function (s) {
      var c = FU.cleanSymbol(s);
      if (c) next.add(c);
    });
    var changed = next.size !== symbols.size;
    if (!changed) {
      next.forEach(function (s) { if (!symbols.has(s)) changed = true; });
    }
    symbols = next;
    if (changed) {
      // Trim cache to current set
      Object.keys(cache).forEach(function (k) { if (!symbols.has(k)) delete cache[k]; });
      // Fire immediate refresh if we have symbols
      if (symbols.size && !document.hidden) refreshNow();
      emit();
    }
  }

  function onUpdate(fn) {
    listeners.add(fn);
    fn(getSnapshot());
    return function () { listeners.delete(fn); };
  }

  function getQuote(symbol) {
    var s = FU.cleanSymbol(symbol);
    return cache[s] || null;
  }

  async function refreshNow() {
    if (!symbols.size) return;
    if (quotesDisabled) return;
    if (inflight) return inflight;
    var list = Array.from(symbols).join(',');
    inflight = (async function () {
      try {
        var res = await fetch('/api/quote?symbols=' + encodeURIComponent(list), {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin'
        });
        if (!res.ok) {
          if (res.status === 404) {
            // No serverless backend on this host. Disable permanently
            // so we don't keep polling and spamming the UI.
            quotesDisabled = true;
            stopPolling();
            console.info('[quotes] /api/quote not available on this host \u2014 live quotes disabled.');
            return;
          }
          var msg = 'quote ' + res.status;
          try { var j = await res.json(); if (j && j.error) msg += ': ' + j.error; } catch (_) {}
          throw new Error(msg);
        }
        var data = await res.json();
        var now = Date.now();
        Object.keys(data || {}).forEach(function (sym) {
          var q = data[sym] || {};
          cache[sym] = {
            c:  FU.safeNum(q.c, 0),
            d:  FU.safeNum(q.d, 0),
            dp: FU.safeNum(q.dp, 0),
            h:  FU.safeNum(q.h, 0),
            l:  FU.safeNum(q.l, 0),
            o:  FU.safeNum(q.o, 0),
            pc: FU.safeNum(q.pc, 0),
            t:  FU.safeNum(q.t, 0),
            _at: now
          };
        });
        emit();
      } catch (e) {
        console.warn('[quotes] refresh failed', e);
        if (!quotesDisabled) FU.toast('Couldn\u2019t refresh quotes \u2014 ' + (e.message || 'network error'), 'err');
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function startPolling() {
    stopPolling();
    if (quotesDisabled) return; // nothing to poll on static hosts
    timer = setInterval(function () {
      if (!document.hidden) refreshNow();
    }, REFRESH_MS);
    if (!document.hidden) refreshNow();
  }
  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNow();
  });

  window.FinanceQuotes = {
    setSymbols: setSymbols,
    onUpdate: onUpdate,
    getQuote: getQuote,
    refreshNow: refreshNow,
    startPolling: startPolling,
    stopPolling: stopPolling,
    getSnapshot: getSnapshot
  };
})();
