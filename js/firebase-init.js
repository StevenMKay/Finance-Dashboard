/* Firebase initialization — compat v10 (matches the existing site). */
(function () {
  var firebaseConfig = {
    apiKey:            'AIzaSyBupprzs7nXLXXa29T9z3aJcq_7kjm03-U',
    authDomain:        'career-solutions-project-tool.firebaseapp.com',
    projectId:         'career-solutions-project-tool',
    storageBucket:     'career-solutions-project-tool.firebasestorage.app',
    messagingSenderId: '834959161768',
    appId:             '1:834959161768:web:d9b653a7039e865c1e859d'
  };

  if (!window.firebase) {
    console.error('[finance] Firebase SDK not loaded.');
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  // Long polling fallback for restrictive networks (matches existing pattern)
  try {
    firebase.firestore().settings({ experimentalAutoDetectLongPolling: true, merge: true });
  } catch (e) { /* settings can only be set once — ignore on re-init */ }

  // Persist auth across reloads
  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function (err) {
    console.warn('[finance] auth persistence:', err);
  });

  window.FinanceFB = {
    auth: function () { return firebase.auth(); },
    db:   function () { return firebase.firestore(); }
  };
})();
