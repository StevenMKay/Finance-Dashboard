/* Shared utilities: formatters, debounce, toast, dom helpers. */
(function () {
  var fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  var fmtMoney0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var fmtPct = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtNum = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

  function money(n, opts)   { if (!isFinite(n)) n = 0; return (opts && opts.compact) ? fmtMoney0.format(n) : fmtMoney.format(n); }
  function pct(frac)        { if (!isFinite(frac)) frac = 0; return fmtPct.format(frac); }
  function pctRaw(p)        { if (!isFinite(p)) p = 0; return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'; }
  function num(n)           { if (!isFinite(n)) n = 0; return fmtNum.format(n); }
  function delta(n)         { if (!isFinite(n)) n = 0; return (n >= 0 ? '+' : '') + money(n); }

  function $(sel, root)     { return (root || document).querySelector(sel); }
  function $$(sel, root)    { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class')      node.className = attrs[k];
      else if (k === 'html')  node.innerHTML = attrs[k];
      else if (k === 'text')  node.textContent = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function debounce(fn, ms) {
    var t; return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 200);
    };
  }

  function toast(msg, kind, ms) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var t = el('div', { class: 'toast ' + (kind || ''), text: msg });
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity 0.3s ease';
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 300);
    }, ms || 2800);
  }

  function cleanSymbol(s) {
    return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  }

  function safeNum(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (dflt == null ? 0 : dflt);
  }

  function colorClass(n) { return n > 0 ? 'up' : (n < 0 ? 'down' : 'muted'); }

  function confirmDanger(msg) { return window.confirm(msg); }

  window.FU = {
    money: money, pct: pct, pctRaw: pctRaw, num: num, delta: delta,
    $: $, $$: $$, el: el, debounce: debounce, toast: toast,
    cleanSymbol: cleanSymbol, safeNum: safeNum, colorClass: colorClass,
    confirmDanger: confirmDanger
  };
})();
