/* Accounts tab — card grid with inline editing. */
(function () {
  var items = [];

  var TYPE_META = {
    checking:   { label: 'Checking',   icon: 'fa-wallet',         color: '#2980b9' },
    savings:    { label: 'Savings',    icon: 'fa-piggy-bank',     color: '#27ae60' },
    brokerage:  { label: 'Brokerage',  icon: 'fa-chart-line',     color: '#8e44ad' },
    retirement: { label: 'Retirement', icon: 'fa-shield-halved',  color: '#1a2744' },
    cash:       { label: 'Cash',       icon: 'fa-money-bill-wave',color: '#16a085' },
    crypto:     { label: 'Crypto',     icon: 'fa-coins',          color: '#f39c12' },
    other:      { label: 'Other',      icon: 'fa-folder',         color: '#718096' }
  };

  function render() {
    var grid = FU.$('#a-grid');
    var empty = FU.$('#a-empty');
    grid.innerHTML = '';
    if (!items.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';

    var total = 0;
    items.forEach(function (a) { total += FU.safeNum(a.balance, 0); });

    items.forEach(function (a) {
      var meta = TYPE_META[a.type] || TYPE_META.other;
      var balInput = FU.el('input', {
        class: 'input input-money',
        type: 'number', step: '0.01',
        value: a.balance,
        style: { fontSize: '20px', fontWeight: '700', padding: '6px 8px' }
      });
      var saving = false;
      balInput.addEventListener('blur', function () {
        if (saving) return;
        saving = true;
        FinanceStore.updateAccount(a.id, {
          name: a.name, type: a.type, balance: FU.safeNum(balInput.value, 0), notes: a.notes || ''
        }).then(function () { FU.toast('Saved', 'ok', 900); })
          .catch(function (e) { FU.toast('Save failed: ' + e.message, 'err'); })
          .finally(function () { saving = false; });
      });
      balInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') balInput.blur(); });

      var nameInput = FU.el('input', {
        class: 'input',
        value: a.name,
        style: { fontWeight: '600', padding: '4px 6px', border: 'none', background: 'transparent', fontSize: '14px' }
      });
      nameInput.addEventListener('blur', function () {
        var v = nameInput.value.trim() || a.name;
        if (v === a.name) return;
        FinanceStore.updateAccount(a.id, { name: v, type: a.type, balance: a.balance, notes: a.notes || '' })
          .catch(function (e) { FU.toast('Rename failed: ' + e.message, 'err'); });
      });

      var pct = total > 0 ? (FU.safeNum(a.balance, 0) / total * 100) : 0;

      var card = FU.el('div', {
        class: 'card',
        style: { borderLeft: '4px solid ' + meta.color, padding: '14px', margin: '0' }
      }, [
        FU.el('div', { style: { display:'flex', alignItems:'center', justifyContent:'space-between', gap:'8px', marginBottom:'8px' }}, [
          FU.el('div', { style: { display:'flex', alignItems:'center', gap:'10px', flex:'1', minWidth:0 }}, [
            FU.el('i', { class: 'fa-solid ' + meta.icon, style: { color: meta.color, fontSize:'18px' }}),
            nameInput
          ]),
          FU.el('button', {
            class: 'btn btn-danger btn-sm', title: 'Delete account',
            onclick: function () {
              if (!FU.confirmDanger('Delete account "' + a.name + '"?')) return;
              FinanceStore.deleteAccount(a.id).catch(function (e) { FU.toast('Delete failed: ' + e.message, 'err'); });
            }
          }, [FU.el('i', { class: 'fa-solid fa-trash' })])
        ]),
        FU.el('div', { class: 'muted', style: { fontSize:'11px', textTransform:'uppercase', letterSpacing:'.4px', marginBottom:'4px' }, text: meta.label + '  ·  ' + pct.toFixed(1) + '% of total' }),
        balInput
      ]);
      grid.appendChild(card);
    });

    // Total row
    var totRow = FU.el('div', {
      class: 'card',
      style: { background: 'var(--c-header)', color: '#fff', borderLeft: '4px solid var(--c-grad-2)', padding: '14px', margin: '0' }
    }, [
      FU.el('div', { class: 'muted', style: { fontSize:'11px', textTransform:'uppercase', letterSpacing:'.4px', color:'#cbd5e1' }, text: 'All accounts' }),
      FU.el('div', { style: { fontSize:'22px', fontWeight:'700', marginTop:'4px' }, text: FU.money(total) })
    ]);
    grid.appendChild(totRow);
  }

  function add() {
    var name = FU.$('#a-name').value.trim();
    var type = FU.$('#a-type').value;
    var bal  = FU.safeNum(FU.$('#a-bal').value, 0);
    if (!name) { FU.toast('Name required', 'err'); return; }
    FinanceStore.addAccount({ name: name, type: type, balance: bal }).then(function () {
      FU.$('#a-name').value = ''; FU.$('#a-bal').value = '';
      FU.toast('Added ' + name, 'ok', 1200);
    }).catch(function (e) { FU.toast('Add failed: ' + e.message, 'err'); });
  }

  function init() {
    FU.$('#a-add').addEventListener('click', add);
    ['#a-name', '#a-bal'].forEach(function (id) {
      FU.$(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    });
  }

  window.FinanceAccounts = {
    init: init,
    setItems: function (it) { items = it || []; render(); }
  };
})();
