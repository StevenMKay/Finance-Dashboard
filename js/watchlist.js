/* Watchlist tab. */
(function () {
  var items = [];
  var quotes = {};

  function render() {
    var body = FU.$('#wl-body');
    var empty = FU.$('#wl-empty');
    body.innerHTML = '';
    if (!items.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';

    items.forEach(function (it) {
      var q = quotes[it.symbol] || {};
      var hasData = !!q.c;
      var deltaClass = q.d > 0 ? 'up' : (q.d < 0 ? 'down' : 'muted');
      var pctClass = q.dp > 0 ? 'up' : (q.dp < 0 ? 'down' : 'muted');

      var tr = FU.el('tr', { 'data-sym': it.symbol }, [
        FU.el('td', { class: 'sym' }, [
          FU.el('a', {
            href: '#',
            onclick: function (ev) { ev.preventDefault(); openSymbolModal(it.symbol); },
            text: it.symbol
          })
        ]),
        FU.el('td', { class: 'num' }, [hasData ? FU.money(q.c) : skeleton()]),
        FU.el('td', { class: 'num ' + deltaClass }, [hasData ? FU.delta(q.d) : '—']),
        FU.el('td', { class: 'num ' + pctClass }, [hasData ? FU.pctRaw(q.dp) : '—']),
        FU.el('td', { class: 'num muted' }, [hasData ? FU.money(q.o) : '—']),
        FU.el('td', { class: 'num muted' }, [hasData ? FU.money(q.h) : '—']),
        FU.el('td', { class: 'num muted' }, [hasData ? FU.money(q.l) : '—']),
        FU.el('td', { class: 'num muted' }, [hasData ? FU.money(q.pc) : '—']),
        FU.el('td', { class: 'num' }, [
          FU.el('button', {
            class: 'btn btn-danger btn-sm',
            title: 'Remove',
            onclick: function () { remove(it.symbol); }
          }, [FU.el('i', { class: 'fa-solid fa-xmark' })])
        ])
      ]);
      body.appendChild(tr);
    });
  }
  function skeleton() {
    var s = FU.el('span', { class: 'skeleton', text: '——' });
    s.style.display = 'inline-block'; s.style.minWidth = '52px';
    return s;
  }

  function remove(sym) {
    FinanceStore.removeWatch(sym).catch(function (e) { FU.toast('Remove failed: ' + e.message, 'err'); });
  }

  function add() {
    var s = FU.cleanSymbol(FU.$('#wl-symbol').value);
    if (!s) { FU.toast('Enter a symbol', 'err'); return; }
    FU.$('#wl-symbol').value = '';
    FinanceStore.addWatch(s).then(function () {
      FU.toast('Added ' + s, 'ok', 1200);
    }).catch(function (e) {
      FU.toast('Couldn’t add: ' + e.message, 'err');
    });
  }

  function openSymbolModal(sym) {
    FU.$('#sym-modal-title').textContent = sym;
    FU.$('#sym-modal').classList.add('open');
    FinanceTV.symbolOverview('sym-modal-overview', sym);
    FinanceTV.timeline('sym-modal-news', sym);
  }
  function closeModal() {
    FU.$('#sym-modal').classList.remove('open');
    FU.$('#sym-modal-overview').innerHTML = '';
    FU.$('#sym-modal-news').innerHTML = '';
  }

  function init() {
    FU.$('#wl-add').addEventListener('click', add);
    FU.$('#wl-symbol').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') add();
    });
    FU.$('#sym-modal-close').addEventListener('click', closeModal);
    FU.$('#sym-modal').addEventListener('click', function (e) {
      if (e.target === FU.$('#sym-modal')) closeModal();
    });
  }

  window.FinanceWatchlist = {
    init: init,
    setItems:  function (it) { items = it || []; render(); },
    setQuotes: function (q)  { quotes = q || {}; render(); },
    openSymbolModal: openSymbolModal
  };
})();
