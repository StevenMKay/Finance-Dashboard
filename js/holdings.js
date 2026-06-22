/* Holdings tab. */
(function () {
  var items = [];
  var accounts = [];
  var quotes = {};

  function render() {
    var body = FU.$('#h-body');
    var empty = FU.$('#h-empty');
    body.innerHTML = '';

    refreshAccountOptions();

    if (!items.length) {
      empty.style.display = '';
      FU.$('#h-tot-mv').textContent  = FU.money(0);
      FU.$('#h-tot-pl').textContent  = FU.money(0);
      FU.$('#h-tot-plp').textContent = '0%';
      return;
    }
    empty.style.display = 'none';

    var totMV = 0, totCost = 0;
    var rows = items.map(function (h) {
      var q = quotes[h.symbol] || {};
      var px = FU.safeNum(q.c, 0);
      var sh = FU.safeNum(h.shares, 0);
      var cb = FU.safeNum(h.costBasis, 0);
      var mv = px * sh;
      var cost = cb * sh;
      var pl = mv - cost;
      var plp = cost > 0 ? (pl / cost * 100) : 0;
      totMV += mv; totCost += cost;
      return { h: h, q: q, px: px, sh: sh, cb: cb, mv: mv, cost: cost, pl: pl, plp: plp };
    });

    rows.forEach(function (r) {
      var weight = totMV > 0 ? (r.mv / totMV * 100) : 0;
      var plClass  = r.pl > 0 ? 'up' : (r.pl < 0 ? 'down' : 'muted');
      var pxStr = r.px ? FU.money(r.px) : '—';

      var tr = FU.el('tr', { 'data-id': r.h.id }, [
        FU.el('td', { class: 'sym' }, [
          FU.el('a', {
            href: '#',
            onclick: function (ev) { ev.preventDefault(); FinanceWatchlist.openSymbolModal(r.h.symbol); },
            text: r.h.symbol
          })
        ]),
        editableNum('shares', r.h.id, r.sh, 0.0001),
        editableNum('costBasis', r.h.id, r.cb, 0.0001),
        FU.el('td', { class: 'num muted' }, [pxStr]),
        FU.el('td', { class: 'num' }, [FU.money(r.mv)]),
        FU.el('td', { class: 'num ' + plClass }, [FU.delta(r.pl)]),
        FU.el('td', { class: 'num ' + plClass }, [FU.pctRaw(r.plp)]),
        FU.el('td', { class: 'num muted' }, [weight.toFixed(1) + '%']),
        FU.el('td', { class: 'num' }, [
          FU.el('button', {
            class: 'btn btn-danger btn-sm', title: 'Delete',
            onclick: function () {
              if (!FU.confirmDanger('Delete ' + r.h.symbol + ' holding?')) return;
              FinanceStore.deleteHolding(r.h.id).catch(function (e) { FU.toast('Delete failed: ' + e.message, 'err'); });
            }
          }, [FU.el('i', { class: 'fa-solid fa-trash' })])
        ])
      ]);
      body.appendChild(tr);
    });

    var totPL = totMV - totCost;
    var totPlp = totCost > 0 ? (totPL / totCost * 100) : 0;
    FU.$('#h-tot-mv').textContent  = FU.money(totMV);
    FU.$('#h-tot-pl').textContent  = FU.delta(totPL);
    FU.$('#h-tot-pl').className    = 'num ' + (totPL > 0 ? 'up' : (totPL < 0 ? 'down' : 'muted'));
    FU.$('#h-tot-plp').textContent = FU.pctRaw(totPlp);
    FU.$('#h-tot-plp').className   = 'num ' + (totPL > 0 ? 'up' : (totPL < 0 ? 'down' : 'muted'));
  }

  function editableNum(field, id, value, step) {
    var input = FU.el('input', {
      class: 'input input-money',
      type: 'number',
      step: step,
      value: value,
      style: { padding: '4px 6px', maxWidth: '110px' }
    });
    var saving = false;
    var save = function () {
      if (saving) return;
      var v = FU.safeNum(input.value, 0);
      saving = true;
      var patch = {};
      // Need full sanitized doc — fetch current item to preserve other fields
      var cur = items.find(function (x) { return x.id === id; }) || {};
      patch.symbol    = cur.symbol;
      patch.shares    = cur.shares;
      patch.costBasis = cur.costBasis;
      patch.accountId = cur.accountId || null;
      patch[field] = v;
      FinanceStore.updateHolding(id, patch).catch(function (e) {
        FU.toast('Save failed: ' + e.message, 'err');
      }).finally(function () { saving = false; });
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') input.blur(); });
    return FU.el('td', { class: 'num' }, [input]);
  }

  function refreshAccountOptions() {
    var sel = FU.$('#h-acct');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">— none —</option>';
    accounts.forEach(function (a) {
      var opt = FU.el('option', { value: a.id, text: a.name + ' (' + a.type + ')' });
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  }

  function add() {
    var sym = FU.cleanSymbol(FU.$('#h-sym').value);
    var sh  = FU.safeNum(FU.$('#h-sh').value, 0);
    var cb  = FU.safeNum(FU.$('#h-cb').value, 0);
    var acct = FU.$('#h-acct').value || null;
    if (!sym) { FU.toast('Symbol required', 'err'); return; }
    if (sh <= 0) { FU.toast('Shares must be > 0', 'err'); return; }
    FinanceStore.addHolding({ symbol: sym, shares: sh, costBasis: cb, accountId: acct }).then(function () {
      FU.$('#h-sym').value = ''; FU.$('#h-sh').value = ''; FU.$('#h-cb').value = '';
      FU.toast('Added ' + sym, 'ok', 1200);
    }).catch(function (e) { FU.toast('Add failed: ' + e.message, 'err'); });
  }

  function init() {
    FU.$('#h-add').addEventListener('click', add);
    ['#h-sym', '#h-sh', '#h-cb'].forEach(function (id) {
      FU.$(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    });
  }

  window.FinanceHoldings = {
    init: init,
    setItems:    function (it) { items = it || []; render(); },
    setAccounts: function (a)  { accounts = a || []; refreshAccountOptions(); render(); },
    setQuotes:   function (q)  { quotes = q || {}; render(); }
  };
})();
