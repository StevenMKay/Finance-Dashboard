/* Firestore data layer. All data is per-user under users/{uid}/...
 *
 * Collections:
 *   users/{uid}                       — profile
 *   users/{uid}/accounts/{id}         — { name, type, balance, notes, updatedAt }
 *   users/{uid}/holdings/{id}         — { symbol, shares, costBasis, accountId, notes }
 *   users/{uid}/watchlist/{symbol}    — { symbol, addedAt }
 *   users/{uid}/meta/salaryPlan       — single doc
 */
(function () {
  var uid = null;
  var unsubs = [];

  function init(user) {
    uid = user.uid;
    // Touch profile (best-effort, fire-and-forget)
    db().collection('users').doc(uid).set({
      email: user.email || null,
      displayName: user.displayName || null,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(function (e) { console.warn('[store] profile touch failed', e); });
  }

  function db() { return firebase.firestore(); }
  function userRef() { return db().collection('users').doc(uid); }

  /* ---------- Accounts ---------- */
  function subscribeAccounts(cb) {
    var u = userRef().collection('accounts').orderBy('name');
    var un = u.onSnapshot(function (snap) {
      var items = []; snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
      cb(items);
    }, function (err) { console.error('[store] accounts', err); cb([]); });
    unsubs.push(un); return un;
  }
  function addAccount(data) {
    return userRef().collection('accounts').add(sanitizeAccount(data, true));
  }
  function updateAccount(id, data) {
    return userRef().collection('accounts').doc(id).set(sanitizeAccount(data, false), { merge: true });
  }
  function deleteAccount(id) {
    return userRef().collection('accounts').doc(id).delete();
  }
  function sanitizeAccount(d, isNew) {
    var out = {
      name:    String(d.name || '').slice(0, 60),
      type:    String(d.type || 'other'),
      balance: FU.safeNum(d.balance, 0),
      notes:   String(d.notes || '').slice(0, 500),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (isNew) out.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    return out;
  }

  /* ---------- Holdings ---------- */
  function subscribeHoldings(cb) {
    var u = userRef().collection('holdings').orderBy('symbol');
    var un = u.onSnapshot(function (snap) {
      var items = []; snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
      cb(items);
    }, function (err) { console.error('[store] holdings', err); cb([]); });
    unsubs.push(un); return un;
  }
  function addHolding(data) {
    return userRef().collection('holdings').add(sanitizeHolding(data, true));
  }
  function updateHolding(id, data) {
    return userRef().collection('holdings').doc(id).set(sanitizeHolding(data, false), { merge: true });
  }
  function deleteHolding(id) {
    return userRef().collection('holdings').doc(id).delete();
  }
  function sanitizeHolding(d, isNew) {
    var out = {
      symbol:    FU.cleanSymbol(d.symbol),
      shares:    FU.safeNum(d.shares, 0),
      costBasis: FU.safeNum(d.costBasis, 0),
      accountId: d.accountId ? String(d.accountId) : null,
      notes:     String(d.notes || '').slice(0, 500),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (isNew) out.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    return out;
  }

  /* ---------- Watchlist ---------- */
  function subscribeWatchlist(cb) {
    var u = userRef().collection('watchlist').orderBy('addedAt');
    var un = u.onSnapshot(function (snap) {
      var items = []; snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
      cb(items);
    }, function (err) { console.error('[store] watchlist', err); cb([]); });
    unsubs.push(un); return un;
  }
  function addWatch(symbol) {
    var s = FU.cleanSymbol(symbol);
    if (!s) return Promise.reject(new Error('Invalid symbol'));
    return userRef().collection('watchlist').doc(s).set({
      symbol: s,
      addedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  function removeWatch(symbol) {
    var s = FU.cleanSymbol(symbol);
    return userRef().collection('watchlist').doc(s).delete();
  }

  /* ---------- Salary plan (single doc under meta) ---------- */
  function subscribeSalary(cb) {
    var ref = userRef().collection('meta').doc('salaryPlan');
    var un = ref.onSnapshot(function (snap) {
      cb(snap.exists ? snap.data() : null);
    }, function (err) { console.error('[store] salary', err); cb(null); });
    unsubs.push(un); return un;
  }
  function saveSalary(plan) {
    var ref = userRef().collection('meta').doc('salaryPlan');
    return ref.set(Object.assign({}, plan, {
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
  }

  /* ---------- Bulk export / import / wipe ---------- */
  async function exportAll() {
    var [accounts, holdings, watchlist, salaryDoc] = await Promise.all([
      userRef().collection('accounts').get(),
      userRef().collection('holdings').get(),
      userRef().collection('watchlist').get(),
      userRef().collection('meta').doc('salaryPlan').get()
    ]);
    function dump(snap) {
      var arr = []; snap.forEach(function (d) {
        var data = d.data();
        // strip server timestamps to keep export portable
        delete data.createdAt; delete data.updatedAt; delete data.addedAt;
        arr.push(Object.assign({ id: d.id }, data));
      });
      return arr;
    }
    return {
      exportedAt: new Date().toISOString(),
      version: 1,
      accounts: dump(accounts),
      holdings: dump(holdings),
      watchlist: dump(watchlist),
      salaryPlan: salaryDoc.exists ? salaryDoc.data() : null
    };
  }

  async function importAll(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid backup file');
    var batch = db().batch();
    (payload.accounts || []).forEach(function (a) {
      var ref = userRef().collection('accounts').doc(a.id || db().collection('_').doc().id);
      batch.set(ref, sanitizeAccount(a, true));
    });
    (payload.holdings || []).forEach(function (h) {
      var ref = userRef().collection('holdings').doc(h.id || db().collection('_').doc().id);
      batch.set(ref, sanitizeHolding(h, true));
    });
    (payload.watchlist || []).forEach(function (w) {
      var s = FU.cleanSymbol(w.symbol || w.id);
      if (!s) return;
      var ref = userRef().collection('watchlist').doc(s);
      batch.set(ref, { symbol: s, addedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    if (payload.salaryPlan) {
      var ref = userRef().collection('meta').doc('salaryPlan');
      batch.set(ref, Object.assign({}, payload.salaryPlan, {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }), { merge: true });
    }
    await batch.commit();
  }

  async function wipeAll() {
    var subs = ['accounts', 'holdings', 'watchlist'];
    for (var i = 0; i < subs.length; i++) {
      var snap = await userRef().collection(subs[i]).get();
      var batch = db().batch();
      snap.forEach(function (d) { batch.delete(d.ref); });
      await batch.commit();
    }
    await userRef().collection('meta').doc('salaryPlan').delete().catch(function () {});
  }

  function teardown() {
    unsubs.forEach(function (un) { try { un(); } catch (_) {} });
    unsubs = [];
    uid = null;
  }

  window.FinanceStore = {
    init: init,
    teardown: teardown,
    subscribeAccounts: subscribeAccounts, addAccount: addAccount, updateAccount: updateAccount, deleteAccount: deleteAccount,
    subscribeHoldings: subscribeHoldings, addHolding: addHolding, updateHolding: updateHolding, deleteHolding: deleteHolding,
    subscribeWatchlist: subscribeWatchlist, addWatch: addWatch, removeWatch: removeWatch,
    subscribeSalary: subscribeSalary, saveSalary: saveSalary,
    exportAll: exportAll, importAll: importAll, wipeAll: wipeAll
  };
})();
