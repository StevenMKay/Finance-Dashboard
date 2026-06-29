/* Auth wrapper — email/pwd, Google, sign-out, route guard. */
(function () {
  function signInEmail(email, pwd) {
    return firebase.auth().signInWithEmailAndPassword(email, pwd);
  }
  function signUpEmail(email, pwd) {
    return firebase.auth().createUserWithEmailAndPassword(email, pwd);
  }
  function signInGoogle() {
    var p = new firebase.auth.GoogleAuthProvider();
    return firebase.auth().signInWithPopup(p);
  }
  function signOut() { return firebase.auth().signOut(); }

  function prettyError(e) {
    if (!e) return 'Something went wrong.';
    var c = e.code || '';
    var map = {
      'auth/invalid-email':          'That email looks invalid.',
      'auth/missing-password':       'Password is required.',
      'auth/weak-password':          'Password must be at least 6 characters.',
      'auth/email-already-in-use':   'An account with that email already exists. Try signing in.',
      'auth/user-not-found':         'No account with that email. Try signing up.',
      'auth/wrong-password':         'Wrong password — try again.',
      'auth/invalid-credential':     'Invalid email or password.',
      'auth/too-many-requests':      'Too many attempts. Wait a minute and try again.',
      'auth/popup-closed-by-user':   'Sign-in popup closed.',
      'auth/network-request-failed': 'Network error — check your connection.'
    };
    return map[c] || (e.message || String(e));
  }

  /** Use on protected pages — redirects to /index.html if not signed in.
   *  Calls onUser(user) once authenticated. */
  function requireAuth(onUser) {
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) {
        window.location.href = 'index.html';
        return;
      }
      onUser(user);
    });
  }

  window.FinanceAuth = {
    signInEmail: signInEmail,
    signUpEmail: signUpEmail,
    signInGoogle: signInGoogle,
    signOut: signOut,
    prettyError: prettyError,
    requireAuth: requireAuth
  };
})();
