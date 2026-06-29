/* =====================================================================
   bt-header.js — Strategy Lab top chrome controller
   ---------------------------------------------------------------------
   Owns three pieces of UI that live outside the tab system:

     1. Top-right account dropdown      (Google photo avatar + menu)
     2. Top-left slide-in sidebar       (brand icon → nav drawer)
     3. "How to use" modal              (gradient pill in header)
     4. Footer year stamp               (#bt-footer-year)

   This module REPLACES the inline <script> block that previously
   lived at the bottom of backtester.html. Keeping it as a real file
   makes it (a) reusable on dashboard.html later, (b) testable, and
   (c) easier to extend without growing the HTML.

   ---------------------------------------------------------------------
   LONG-TERM-FRIENDLY DESIGN NOTES (read before changing):

   1.  Auth-aware but auth-optional. Every wiring step null-checks its
       target element first so adding/removing markup in backtester.html
       cannot break this file. If you move a piece of UI to another
       page, drop the same IDs in and it just works.

   2.  Photo fallback chain:
          user.photoURL  →  Firestore users/{uid}.photoUrl  →  initial
       Always degrade gracefully. Do not assume photoURL is present —
       email/password users have no photo.

   3.  Backdrop is shared between the sidebar and the How-to modal.
       Don't add a second backdrop; just gate close() on whichever
       panel is open.

   4.  MOBILE: the dropdown is anchored to the avatar button using
       absolute positioning. On screens < 600px it expands to fill
       most of the viewport width (see CSS in backtester.html). Do
       NOT move it into the header flow — the fixed position is what
       keeps the avatar tappable on phones.

   5.  Menu items are declared in MENU_ITEMS below. Add a new entry
       to add a new sidebar link — do not edit backtester.html.
   ===================================================================== */

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // Sidebar menu items — single source of truth.
  // Add entries here to grow the menu. Each entry is one of:
  //   { type: 'link',    icon, label, href }
  //   { type: 'modal',   icon, label, open: 'terms'|'privacy'|'how-ai'|'about' }
  //   { type: 'action',  icon, label, action: 'signOut'|'howto' }
  //   { type: 'divider' }
  // -------------------------------------------------------------------
  var MENU_ITEMS = [
    { type: 'link',   icon: 'fa-house',            label: 'Dashboard',                href: 'dashboard.html' },
    { type: 'link',   icon: 'fa-flask',            label: 'Strategy Lab',             href: 'backtester.html' },
    { type: 'action', icon: 'fa-circle-question',  label: 'How to use',               action: 'howto' },
    { type: 'divider' },
    { type: 'modal',  icon: 'fa-file-lines',       label: 'Terms of Use',             open: 'terms' },
    { type: 'modal',  icon: 'fa-shield-halved',    label: 'Privacy Policy',           open: 'privacy' },
    { type: 'modal',  icon: 'fa-robot',            label: 'How AI is used',           open: 'how-ai' },
    { type: 'modal',  icon: 'fa-user',             label: 'About the Creator',        open: 'about' },
    { type: 'divider' },
    { type: 'action', icon: 'fa-arrow-right-from-bracket', label: 'Sign out',         action: 'signOut' }
  ];

  // -------------------------------------------------------------------
  // Account dropdown menu items — mirrors the sidebar but compact.
  // Avatar opens this on the top-right.
  // -------------------------------------------------------------------
  var ACCOUNT_ITEMS = [
    { type: 'link',   icon: 'fa-house',                    label: 'Dashboard',          href: 'dashboard.html' },
    { type: 'action', icon: 'fa-circle-question',          label: 'How to use',         action: 'howto' },
    { type: 'modal',  icon: 'fa-shield-halved',            label: 'Privacy',            open: 'privacy' },
    { type: 'modal',  icon: 'fa-file-lines',               label: 'Terms',              open: 'terms' },
    { type: 'modal',  icon: 'fa-user',                     label: 'About the Creator',  open: 'about' },
    { type: 'divider' },
    { type: 'action', icon: 'fa-arrow-right-from-bracket', label: 'Sign out',           action: 'signOut' }
  ];

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function initialFor(user) {
    if (!user) return 'A';
    var src = (user.displayName || user.email || '').trim();
    return (src.charAt(0) || 'A').toUpperCase();
  }
  function signOutAndGoHome() {
    if (window.FinanceAuth && FinanceAuth.signOut) {
      FinanceAuth.signOut().then(function () { window.location.href = 'index.html'; });
    } else {
      // Belt-and-suspenders fallback — should never hit.
      window.location.href = 'index.html';
    }
  }
  // Try to fetch a saved profile photo from Firestore. Best-effort;
  // any failure (rule denied, offline, doc missing) is swallowed and
  // we just leave the initial / Google photo in place.
  function loadFirestorePhoto(user, cb) {
    if (!user || !user.uid) return;
    if (!window.FinanceFB || !FinanceFB.db) return;
    try {
      FinanceFB.db().collection('users').doc(user.uid).get()
        .then(function (doc) {
          if (doc && doc.exists) {
            var data = doc.data() || {};
            if (data.photoUrl) cb(data.photoUrl);
          }
        })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------
  // Render menu items into a container <nav> or <div>.
  // Caller is responsible for the container element + its CSS.
  // -------------------------------------------------------------------
  function renderMenu(container, items, closeFn) {
    if (!container) return;
    container.innerHTML = '';
    items.forEach(function (item) {
      if (item.type === 'divider') {
        var d = document.createElement('div');
        d.className = 'bt-menu-divider';
        container.appendChild(d);
        return;
      }
      var el;
      if (item.type === 'link') {
        el = document.createElement('a');
        el.href = item.href;
      } else {
        el = document.createElement('button');
        el.type = 'button';
      }
      el.className = 'bt-menu-item';
      el.innerHTML = '<i class="fa-solid ' + item.icon + '"></i> <span>' + item.label + '</span>';
      el.addEventListener('click', function (e) {
        if (item.type === 'modal' && window.BTLegalModals) {
          e.preventDefault();
          BTLegalModals.open(item.open);
        } else if (item.type === 'action' && item.action === 'signOut') {
          e.preventDefault();
          signOutAndGoHome();
        } else if (item.type === 'action' && item.action === 'howto') {
          e.preventDefault();
          openHowtoModal();
        }
        if (closeFn) closeFn();
      });
      container.appendChild(el);
    });
  }

  // -------------------------------------------------------------------
  // Account dropdown — top-right avatar + popover
  // -------------------------------------------------------------------
  function applyAvatarPhoto(avatarEl, url, user) {
    if (!avatarEl) return;
    var initial = initialFor(user);
    if (url) {
      avatarEl.classList.add('has-photo');
      avatarEl.innerHTML = ''; // remove any prior letter
      var img = new Image();
      img.alt = '';
      img.onload = function () {
        avatarEl.innerHTML = '';
        avatarEl.appendChild(img);
      };
      img.onerror = function () {
        avatarEl.classList.remove('has-photo');
        avatarEl.textContent = initial;
      };
      img.src = url;
    } else {
      avatarEl.classList.remove('has-photo');
      avatarEl.textContent = initial;
    }
  }

  function attachAccountMenu(user) {
    var btn   = $('#bt-acct-btn');
    var panel = $('#bt-acct-panel');
    var avatar= $('#bt-acct-avatar');
    var name  = $('#bt-acct-name');
    if (!btn || !panel || !avatar) return;

    // Identity strip
    if (name) name.textContent = user ? (user.displayName || user.email || 'Account') : 'Account';
    applyAvatarPhoto(avatar, user && user.photoURL, user);
    loadFirestorePhoto(user, function (url) { applyAvatarPhoto(avatar, url, user); });

    // Render menu
    renderMenu(panel.querySelector('.bt-acct-menu'), ACCOUNT_ITEMS, closeAcct);

    function openAcct() {
      panel.classList.add('show');
      btn.setAttribute('aria-expanded', 'true');
    }
    function closeAcct() {
      panel.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggleAcct() {
      if (panel.classList.contains('show')) closeAcct(); else openAcct();
    }

    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleAcct(); });
    // Click outside to close
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('show')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      closeAcct();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAcct();
    });
  }

  // -------------------------------------------------------------------
  // Sidebar (top-left brand icon → slide-in drawer)
  // -------------------------------------------------------------------
  var sidebarRefs = {};
  function attachSidebar() {
    sidebarRefs.menuBtn = $('#bt-menu-btn');
    sidebarRefs.sidebar = $('#bt-sidebar');
    sidebarRefs.backdrop = $('#bt-backdrop');
    sidebarRefs.close   = $('#bt-sidebar-close');
    var nav = sidebarRefs.sidebar ? sidebarRefs.sidebar.querySelector('nav') : null;
    if (!sidebarRefs.menuBtn || !sidebarRefs.sidebar || !sidebarRefs.backdrop || !nav) return;

    renderMenu(nav, MENU_ITEMS, closeSidebar);

    sidebarRefs.menuBtn.addEventListener('click', openSidebar);
    if (sidebarRefs.close) sidebarRefs.close.addEventListener('click', closeSidebar);
  }

  function openSidebar() {
    if (!sidebarRefs.sidebar) return;
    sidebarRefs.sidebar.classList.add('show');
    sidebarRefs.backdrop.classList.add('show');
    sidebarRefs.sidebar.setAttribute('aria-hidden', 'false');
    if (sidebarRefs.menuBtn) sidebarRefs.menuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    if (!sidebarRefs.sidebar) return;
    sidebarRefs.sidebar.classList.remove('show');
    sidebarRefs.sidebar.setAttribute('aria-hidden', 'true');
    if (sidebarRefs.menuBtn) sidebarRefs.menuBtn.setAttribute('aria-expanded', 'false');
    // Only remove the backdrop if the how-to modal isn't also open.
    var howto = $('#bt-howto-modal');
    if (!howto || !howto.classList.contains('show')) sidebarRefs.backdrop.classList.remove('show');
  }

  // -------------------------------------------------------------------
  // "How to use" modal
  // -------------------------------------------------------------------
  function attachHowto() {
    var btn = $('#bt-howto-btn');
    var modal = $('#bt-howto-modal');
    var close = $('#bt-howto-close');
    var backdrop = $('#bt-backdrop');
    if (!modal) return;

    if (btn)   btn.addEventListener('click', openHowtoModal);
    if (close) close.addEventListener('click', closeHowtoModal);
    if (backdrop) backdrop.addEventListener('click', function () {
      closeHowtoModal();
      closeSidebar();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeHowtoModal();
    });
    // Click outside the card closes the modal.
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeHowtoModal();
    });
  }

  function openHowtoModal() {
    var modal = $('#bt-howto-modal');
    var backdrop = $('#bt-backdrop');
    if (!modal) return;
    modal.classList.add('show');
    if (backdrop) backdrop.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeHowtoModal() {
    var modal = $('#bt-howto-modal');
    var backdrop = $('#bt-backdrop');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    // Only remove backdrop if sidebar isn't also open.
    var sidebar = $('#bt-sidebar');
    if (backdrop && (!sidebar || !sidebar.classList.contains('show'))) backdrop.classList.remove('show');
  }

  // -------------------------------------------------------------------
  // Footer year
  // -------------------------------------------------------------------
  function stampFooterYear() {
    var el = $('#bt-footer-year');
    if (el) el.textContent = new Date().getFullYear();
  }

  // -------------------------------------------------------------------
  // Public API
  // Called from js/backtester.js inside FinanceAuth.requireAuth so
  // we have the signed-in user object for the avatar.
  // -------------------------------------------------------------------
  function init(user) {
    attachSidebar();
    attachHowto();
    attachAccountMenu(user);
    stampFooterYear();
  }

  window.BTHeader = { init: init };
})();
