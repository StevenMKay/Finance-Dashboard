/* Settings tab — export / import / wipe. */
(function () {
  function downloadJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function init() {
    FU.$('#btn-export').addEventListener('click', async function () {
      FU.toast('Preparing export…', 'ok', 1000);
      try {
        var payload = await FinanceStore.exportAll();
        var d = new Date(); var stamp = d.toISOString().slice(0, 10);
        downloadJSON(payload, 'finance-backup-' + stamp + '.json');
        FU.toast('Exported', 'ok');
      } catch (e) { FU.toast('Export failed: ' + e.message, 'err'); }
    });

    FU.$('#file-import').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!FU.confirmDanger('Import this backup? Existing accounts/holdings/watchlist with matching IDs will be overwritten.')) {
        e.target.value = ''; return;
      }
      try {
        var text = await file.text();
        var data = JSON.parse(text);
        await FinanceStore.importAll(data);
        FU.toast('Import complete', 'ok');
      } catch (err) {
        FU.toast('Import failed: ' + err.message, 'err');
      } finally {
        e.target.value = '';
      }
    });

    FU.$('#btn-wipe').addEventListener('click', async function () {
      if (!FU.confirmDanger('Delete ALL your accounts, holdings, watchlist, and salary plan? This cannot be undone.')) return;
      if (!FU.confirmDanger('Are you absolutely sure? Type OK in the next prompt.')) return;
      var typed = window.prompt('Type DELETE to confirm:');
      if (typed !== 'DELETE') { FU.toast('Cancelled', 'warn'); return; }
      try {
        await FinanceStore.wipeAll();
        FU.toast('All data deleted', 'ok');
      } catch (e) {
        FU.toast('Wipe failed: ' + e.message, 'err');
      }
    });
  }

  window.FinanceSettings = { init: init };
})();
