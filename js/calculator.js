/* What-if calculator — live recompute on every keystroke. */
(function () {
  var allSyms = []; // symbols known from watchlist + holdings, for autocomplete

  function recompute() {
    var cur = FU.safeNum(FU.$('#ci-cur').value, 0);
    var tgt = FU.safeNum(FU.$('#ci-tgt').value, 0);
    var sh  = FU.safeNum(FU.$('#ci-sh').value, 0);
    var fee = FU.safeNum(FU.$('#ci-fee').value, 0);
    var days = Math.max(1, FU.safeNum(FU.$('#ci-days').value, 365));

    var cost = cur * sh + fee;
    var mv = tgt * sh;
    var gain = mv - cost;
    var pct  = cost > 0 ? (gain / cost * 100) : 0;
    var years = days / 365;
    var ann   = (cost > 0 && years > 0 && (mv / cost) > 0)
      ? (Math.pow(mv / cost, 1 / years) - 1) * 100
      : 0;
    var be = sh > 0 ? (cost / sh) : 0;

    FU.$('#ci-cost').textContent = FU.money(cost);
    FU.$('#ci-mv').textContent   = FU.money(mv);

    var gEl = FU.$('#ci-gain'); gEl.textContent = FU.delta(gain);
    gEl.className = 'val ' + FU.colorClass(gain);
    var pEl = FU.$('#ci-pct'); pEl.textContent = FU.pctRaw(pct);
    pEl.className = 'val ' + FU.colorClass(pct);
    var aEl = FU.$('#ci-ann'); aEl.textContent = FU.pctRaw(ann);
    aEl.className = 'val ' + FU.colorClass(ann);

    FU.$('#ci-be').textContent = FU.money(be);
  }

  function setSymbolList(syms) {
    allSyms = Array.from(new Set(syms || []));
    var dl = FU.$('#ci-sym-list');
    dl.innerHTML = '';
    allSyms.forEach(function (s) {
      dl.appendChild(FU.el('option', { value: s }));
    });
  }

  function maybeAutofillPrice() {
    var s = FU.cleanSymbol(FU.$('#ci-sym').value);
    if (!s) return;
    var q = FinanceQuotes.getQuote(s);
    if (q && q.c) {
      // Only overwrite if blank or matches the previous cached value (so user edits aren't clobbered)
      var inp = FU.$('#ci-cur');
      if (!inp.value || inp.dataset.autofilled === '1') {
        inp.value = q.c.toFixed(2);
        inp.dataset.autofilled = '1';
        recompute();
      }
    }
  }

  function init() {
    ['#ci-cur','#ci-tgt','#ci-sh','#ci-fee','#ci-days'].forEach(function (id) {
      FU.$(id).addEventListener('input', function () {
        if (id === '#ci-cur') FU.$('#ci-cur').dataset.autofilled = '';
        recompute();
      });
    });
    FU.$('#ci-sym').addEventListener('input', maybeAutofillPrice);
    FU.$('#ci-sym').addEventListener('change', maybeAutofillPrice);
    recompute();
  }

  window.FinanceCalc = {
    init: init,
    setSymbolList: setSymbolList,
    onQuotes: function () { maybeAutofillPrice(); }
  };
})();
