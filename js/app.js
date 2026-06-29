/* App boot — runs on dashboard.html only. */
(function () {
  // State cached at this layer so we can union watchlist+holdings symbols.
  var watchlist = [];
  var holdings = [];
  var accounts = [];

  function refreshSymbolUnion() {
    var set = new Set();
    watchlist.forEach(function (w) { if (w.symbol) set.add(w.symbol); });
    holdings.forEach(function (h)  { if (h.symbol) set.add(h.symbol); });
    var list = Array.from(set);
    FinanceQuotes.setSymbols(list);

    // For TradingView ticker tape, prefix common exchanges if possible — TV accepts bare symbol too
    FinanceTV.tickerTape('tv-ticker-tape', list);

    FinanceCalc.setSymbolList(list);
  }

  function wireOnUserReady(user) {
    // Header email + sign-out
    FU.$('#hdr-email').textContent = user.email || user.displayName || 'Signed in';
    FU.$('#btn-signout').addEventListener('click', function () {
      FinanceAuth.signOut().then(function () { window.location.href = 'index.html'; });
    });

    FinanceStore.init(user);

    // Init each module
    FinanceTabs.init();
    FinanceOverview.init();
    FinanceWatchlist.init();
    FinanceHoldings.init();
    FinanceAccounts.init();
    FinanceSalary.init();
    FinanceCalc.init();
    FinanceSettings.init();

    // Subscribe to data; broadcast to each consumer.
    FinanceStore.subscribeAccounts(function (items) {
      accounts = items;
      FinanceAccounts.setItems(items);
      FinanceHoldings.setAccounts(items);
      FinanceOverview.setAccounts(items);
    });
    FinanceStore.subscribeHoldings(function (items) {
      holdings = items;
      FinanceHoldings.setItems(items);
      FinanceOverview.setHoldings(items);
      refreshSymbolUnion();
    });
    FinanceStore.subscribeWatchlist(function (items) {
      watchlist = items;
      FinanceWatchlist.setItems(items);
      refreshSymbolUnion();
    });
    FinanceStore.subscribeSalary(function (plan) {
      if (plan) FinanceSalary.setPlan(plan);
    });

    // Quote updates fan out
    FinanceQuotes.onUpdate(function (snap) {
      FinanceWatchlist.setQuotes(snap);
      FinanceHoldings.setQuotes(snap);
      FinanceOverview.setQuotes(snap);
      FinanceCalc.onQuotes();
    });

    FinanceQuotes.startPolling();
  }

  // Only boot on dashboard page
  if (document.body && FU.$('#kpi-grid')) {
    FinanceAuth.requireAuth(wireOnUserReady);
  }
})();
