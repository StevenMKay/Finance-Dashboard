/* api/_lib/auth.js — shared Firebase Admin ID-token verification
 * --------------------------------------------------------------------
 * Lazy-initializes firebase-admin with creds from env vars. Used by
 * /api/ai-recommend and /api/ai-strategy to make sure only signed-in
 * users of THIS site can consume OpenAI tokens (and your API budget).
 *
 * Env vars
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY        (use \n for newlines in Vercel env)
 *
 * Public:
 *   verifyIdToken(req)               -> Promise<{uid,email}> or throws
 *   rateLimit(uid, key, max, win)    -> {ok, retryAfter}
 *   setCors(req, res)                -> bool (request handled if OPTIONS)
 *   readJson(req)                    -> Promise<object>
 *   sendJson(res, status, body)
 * ------------------------------------------------------------------ */

var admin = null;
function getAdmin() {
  if (admin) return admin;
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    var key = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !key) {
      throw new Error('firebase-admin credentials missing');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  key
      })
    });
  }
  return admin;
}

function verifyIdToken(req) {
  return new Promise(function (resolve, reject) {
    var h = req.headers && (req.headers.authorization || req.headers.Authorization) || '';
    var m = /^Bearer (.+)$/i.exec(h);
    if (!m) return reject(new Error('missing bearer token'));
    var token = m[1].trim();
    try {
      getAdmin().auth().verifyIdToken(token).then(function (decoded) {
        resolve({ uid: decoded.uid, email: decoded.email || null });
      }).catch(function (err) {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Per-UID sliding-window rate limit. Map<key, number[]>.
var BUCKETS = new Map();
function rateLimit(uid, key, max, windowMs) {
  var now = Date.now();
  var bucketKey = key + ':' + uid;
  var arr = BUCKETS.get(bucketKey) || [];
  // Drop old entries
  arr = arr.filter(function (t) { return (now - t) < windowMs; });
  if (arr.length >= max) {
    BUCKETS.set(bucketKey, arr);
    var retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
    return { ok: false, retryAfter: retryAfter };
  }
  arr.push(now);
  BUCKETS.set(bucketKey, arr);
  return { ok: true };
}

function setCors(req, res) {
  var origin = req.headers.origin || '';
  var allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var allowed = '';
  if (!allow.length) {
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) allowed = origin || '*';
  } else if (allow.indexOf(origin) !== -1) {
    allowed = origin;
  }
  if (allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    var data = '';
    req.on('data', function (chunk) { data += chunk; if (data.length > 200000) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', function () {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

module.exports = { verifyIdToken: verifyIdToken, rateLimit: rateLimit, setCors: setCors, readJson: readJson, sendJson: sendJson };
