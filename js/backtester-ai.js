/* AI Lab client — Phase J
 * --------------------------------------------------------------------
 * Talks to /api/ai-recommend and /api/ai-strategy. Both endpoints
 * require a Firebase ID token in the Authorization header — anonymous
 * requests are rejected server-side before any OpenAI traffic, so your
 * key (and your $) are protected.
 *
 * If either endpoint returns 503 { error:'ai-disabled' } we flip the AI
 * tab into a disabled state and never call it again until reload.
 *
 * Public:
 *   BTAI.recommend(payload) -> Promise<{ headline, bullets, raw }>
 *   BTAI.buildStrategy(description) -> Promise<{ strategy, raw }>
 *   BTAI.isDisabled() -> bool
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var disabled = false;

  function tokenHeader() {
    var u = firebase.auth().currentUser;
    if (!u) return Promise.reject(new Error('not signed in'));
    return u.getIdToken(/*forceRefresh*/ false).then(function (tok) {
      return { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' };
    });
  }

  function post(url, body) {
    return tokenHeader().then(function (headers) {
      return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), credentials: 'same-origin' });
    }).then(function (r) {
      if (r.status === 503) {
        return r.json().then(function (j) {
          disabled = true;
          throw new Error('ai-disabled: ' + (j && j.reason || 'OPENAI_API_KEY not set'));
        });
      }
      if (r.status === 401) {
        throw new Error('not authenticated');
      }
      if (r.status === 429) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error('rate limited' + (j.retryAfter ? ' — retry in ' + j.retryAfter + 's' : ''));
        });
      }
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && j.error) || ('HTTP ' + r.status));
        });
      }
      return r.json();
    });
  }

  function recommend(payload) {
    return post('/api/ai-recommend', payload);
  }
  function buildStrategy(description) {
    return post('/api/ai-strategy', { description: String(description || '').slice(0, 1000) });
  }

  window.BTAI = {
    recommend: recommend,
    buildStrategy: buildStrategy,
    isDisabled: function () { return disabled; }
  };
})();
