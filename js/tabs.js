/* Tab switching. */
(function () {
  function activate(name) {
    FU.$$('.tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    FU.$$('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    try { localStorage.setItem('fd:lastTab', name); } catch (_) {}
    document.dispatchEvent(new CustomEvent('fd:tab', { detail: { name: name } }));
  }

  function init() {
    FU.$$('.tabbar button').forEach(function (b) {
      b.addEventListener('click', function () {
        activate(b.getAttribute('data-tab'));
      });
    });
    var saved;
    try { saved = localStorage.getItem('fd:lastTab'); } catch (_) {}
    if (saved && document.getElementById('tab-' + saved)) activate(saved);
  }

  window.FinanceTabs = { init: init, activate: activate };
})();
