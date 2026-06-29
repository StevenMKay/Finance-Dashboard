/* =====================================================================
   bt-legal-modals.js â€” Strategy Lab legal & about modals
   ---------------------------------------------------------------------
   Self-contained module that injects four modals (Terms / Privacy /
   How AI is Used / About the Creator) into the page and exposes a
   tiny API so any element can open one:

       <a data-bt-open="terms">Terms of Use</a>
       <button data-bt-open="about">About the Creator</button>

   Or programmatically:
       BTLegalModals.open('privacy');

   ---------------------------------------------------------------------
   LONG-TERM-FRIENDLY DESIGN NOTES (read before changing):

   1.  Content is data, not HTML. Each modal lives in MODAL_DEFS as a
       structured object with { id, title, subtitle, sections[] }.
       Adding a new legal page = adding one entry, not new markup.
       Keep sections shallow (h3 + paragraphs/lists) so the template
       renderer below can stay simple.

   2.  Self-contained. The module injects its own DOM and CSS so it
       drops into any Career Solutions page without coupling to a
       host stylesheet. If you move it to dashboard.html or a future
       workspace page, no further wiring is needed beyond loading the
       script and using data-bt-open / BTLegalModals.open().

   3.  MOBILE: All modals cap at 92vw / 85vh with internal scroll.
       The close button stays sticky at the bottom of the modal card.
       Touch targets are >= 44px. Do NOT remove the .bt-legal-modal
       max-height rule â€” that's what prevents the modal from running
       off-screen on small phones.

   4.  Accessibility: role=dialog + aria-modal, ESC closes, focus
       returns to the trigger element on close. Keep these intact.
   ===================================================================== */

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // Modal content registry â€” edit text here, not in the template below.
  // -------------------------------------------------------------------
  // Each section is rendered as <h3> + body. Body can be either:
  //   { type: 'p',    text: '...' }
  //   { type: 'ul',   items: ['...', '...'] }
  //   { type: 'ol',   items: ['...', '...'] }
  //   { type: 'note', text: '...' }   // yellow callout
  //   { type: 'html', html: '...' }   // raw HTML â€” use sparingly
  // -------------------------------------------------------------------
  var MODAL_DEFS = {
    terms: {
      title: 'Terms of Use',
      subtitle: 'Career Solutions for Today Â· Strategy Lab Â· Version 1.0 Â· Last updated: June 2026',
      sections: [
        { h: '1. Research and Simulation Only',
          body: [
            { type: 'p', text: 'The Strategy Lab is a research and simulation tool. Nothing in this app is investment advice, an offer to buy or sell securities, or a recommendation of any particular trade. Past or simulated performance does not guarantee future results.' },
            { type: 'p', text: 'You are solely responsible for any investment decisions you make. Do your own research and consider speaking with a licensed financial advisor before trading.' }
          ]},
        { h: '2. Acceptance of Terms',
          body: [{ type: 'p', text: 'By using the Strategy Lab you agree to these Terms. If you do not agree, do not use the platform.' }] },
        { h: '3. Description of Service',
          body: [
            { type: 'p', text: 'The Strategy Lab provides:' },
            { type: 'ul', items: [
              'Backtesting of intraday strategies against historical market data',
              'Parameter optimization, heatmaps, and Monte Carlo simulation',
              'Position-sizing calculators and investment planning tools',
              'AI-assisted strategy summarization (optional)',
              'CSV exports of trades and leaderboard results'
            ]}
          ]},
        { h: '4. Market Data',
          body: [
            { type: 'p', text: 'Historical candle data is sourced from third-party market data providers (currently Polygon.io) through our server-side proxy. We do not guarantee that the data is complete, timely, or free from errors.' },
            { type: 'p', text: 'When live data is unavailable, the app falls back to clearly-labeled synthetic ("mock") data so the UI keeps working in development. Do not treat mock-data results as real backtests.' }
          ]},
        { h: '5. AI Disclaimer',
          body: [
            { type: 'p', text: 'AI-generated summaries and strategy suggestions:' },
            { type: 'ul', items: [
              'May contain errors or omissions',
              'Should be reviewed before use',
              'Are not a substitute for professional financial advice',
              'Do not guarantee any trading outcome'
            ]}
          ]},
        { h: '6. User Responsibilities',
          body: [
            { type: 'p', text: 'You agree to:' },
            { type: 'ul', items: [
              'Provide accurate information when creating an account',
              'Use the service lawfully',
              'Not attempt to bypass rate limits or exploit API endpoints',
              'Review all backtest output before relying on it for any decision'
            ]}
          ]},
        { h: '7. Pricing & Billing',
          body: [{ type: 'p', text: 'The Strategy Lab is currently offered free of charge while in active development. If pricing is introduced in the future, it will be clearly disclosed before any charge is made.' }] },
        { h: '8. Account & Data',
          body: [
            { type: 'p', text: 'You may delete your account and associated saved data (presets, favorites, leaderboard history) at any time by signing in and using the account menu. Deletion is permanent except for limited backups retained for legal or operational reasons.' }
          ]},
        { h: '9. Limitation of Liability',
          body: [{ type: 'p', text: 'We are not liable for any trading losses, missed opportunities, or financial decisions made based on output from this tool. Use the service at your own risk.' }] },
        { h: '10. Changes to Terms',
          body: [{ type: 'p', text: 'We may update these Terms at any time. Continued use means acceptance of updates.' }] },
        { h: '11. Governing Law',
          body: [{ type: 'p', text: 'These Terms are governed by the laws of the State of Arizona, without regard to conflict-of-law principles.' }] },
        { h: '12. Contact',
          body: [{ type: 'html', html: '<a href="mailto:stevenk@careersolutionsfortoday.com">stevenk@careersolutionsfortoday.com</a>' }] }
      ]
    },

    privacy: {
      title: 'Privacy Policy',
      subtitle: 'Career Solutions for Today Â· Strategy Lab Â· Version 1.0 Â· Last updated: June 2026',
      sections: [
        { h: '1. Information We Collect',
          body: [
            { type: 'p', text: 'When you sign in we collect:' },
            { type: 'ul', items: [
              'Email address, display name, and (for Google sign-in) profile photo URL',
              'Saved strategies, presets, favorite tickers, and leaderboard history',
              'Watchlist, accounts, holdings, and salary plan data (Finance Dashboard)',
              'Free-text notes and experiment ideas you choose to save'
            ]},
            { type: 'p', text: 'We also automatically collect anonymous device/browser metadata and usage events to monitor reliability.' }
          ]},
        { h: '2. How We Use Your Information',
          body: [{ type: 'ul', items: [
            'Operate and improve the Strategy Lab and Finance Dashboard',
            'Persist your saved presets, favorites, and leaderboard history across devices',
            'Process AI requests when you explicitly trigger them',
            'Communicate important updates or support responses'
          ]}]},
        { h: '3. Market Data Provider',
          body: [{ type: 'p', text: 'Historical candle data is proxied through our server from Polygon.io. Your ticker queries are sent to Polygon to retrieve bars. We do not share your account identity with Polygon â€” only the ticker / period / interval requested.' }] },
        { h: '4. AI Processing (OpenAI)',
          body: [
            { type: 'p', text: 'When you trigger an AI feature in the AI Lab, the relevant backtest summary or your free-text strategy description is sent to OpenAI through our server. We do not share your email, Firebase UID, or any personal identifier with OpenAI â€” only the strategy content.' },
            { type: 'p', text: 'Per OpenAI\'s API policy, content sent through the API is not used to train OpenAI\'s models by default.' },
            { type: 'note', text: 'Avoid putting sensitive personal data into free-text fields. Anything you type will be sent to the AI provider as part of the request.' }
          ]},
        { h: '5. Data Storage & Security',
          body: [
            { type: 'p', text: 'Your data is stored using:' },
            { type: 'ul', items: [
              'Firebase Authentication (sign-in)',
              'Firestore (saved presets, favorites, holdings, leaderboard, plans)'
            ]},
            { type: 'p', text: 'We use Firestore security rules so only the signed-in owner can read or write their own documents. No system is 100% secure â€” please use a strong unique password.' }
          ]},
        { h: '6. Data Retention',
          body: [{ type: 'p', text: 'We retain your data as long as your account is active. Deleted content may remain in backups for a limited period.' }] },
        { h: '7. Account & Data Deletion',
          body: [{ type: 'p', text: 'Sign in and use the account menu to delete saved data. To delete the account itself or request a full data export, email us at the address below.' }] },
        { h: '8. Your Rights',
          body: [{ type: 'ul', items: [
            'Access your data',
            'Update or correct your information',
            'Delete your account and associated data',
            'Request a copy of your data'
          ]}]},
        { h: '9. Third-Party Services',
          body: [{ type: 'ul', items: [
            'Firebase (Google) â€” authentication, database, hosting',
            'Polygon.io â€” historical market data',
            'OpenAI â€” optional AI summarization (only when you trigger it)',
            'Vercel â€” serverless API hosting'
          ]}]},
        { h: '10. Data Sharing',
          body: [{ type: 'p', text: 'We do not sell your personal data. We only share data with service providers needed to operate the platform, when required by law, or to protect rights and prevent fraud.' }] },
        { h: '11. Children\'s Privacy',
          body: [{ type: 'p', text: 'This service is not intended for users under 18.' }] },
        { h: '12. Changes to This Policy',
          body: [{ type: 'p', text: 'We may update this policy. Continued use means you accept the updated terms.' }] },
        { h: '13. Contact',
          body: [{ type: 'html', html: '<a href="mailto:stevenk@careersolutionsfortoday.com">stevenk@careersolutionsfortoday.com</a>' }] }
      ]
    },

    'how-ai': {
      title: 'How AI is Used',
      subtitle: 'Plain-English explanation of every AI step in the Strategy Lab.',
      sections: [
        { h: '1. What we use AI for',
          body: [
            { type: 'p', text: 'The Strategy Lab uses OpenAI\'s API (currently the gpt-4o-mini family) for two focused tasks, both inside the "AI Lab" tab:' },
            { type: 'ul', items: [
              'Recommendations â€” summarizes your latest optimizer result and flags overfitting risks or low-sample-size rows.',
              'Strategy Builder â€” turns a plain-English description ("Buy after a 2% dip, sell at 0.8%â€¦") into a validated strategy JSON you can apply to the Engine tab.'
            ]},
            { type: 'p', text: 'That is the entire list. AI is never used silently in the background â€” it only runs when you click an AI button.' }
          ]},
        { h: '2. What data is sent to OpenAI',
          body: [
            { type: 'ul', items: [
              'For Recommendations: the parameter axes from your last optimizer run, plus the top-ranked rows (ticker, target, stop, trade count, win rate, expectancy).',
              'For Strategy Builder: your free-text description (capped at 1000 characters).'
            ]},
            { type: 'p', text: 'We do not send: your password, payment information, billing data, IP address, browsing history, or your account email / Firebase UID. We do not send raw market data â€” only the aggregated stats from your backtest.' },
            { type: 'note', text: 'Avoid putting sensitive personal data into the strategy description. Anything in the text box will be sent to OpenAI as part of the request.' }
          ]},
        { h: '3. What we get back',
          body: [
            { type: 'p', text: 'Every AI request is constrained to return structured JSON, not free-form text, so the app can validate it before showing it to you:' },
            { type: 'ul', items: [
              'Recommendations: a short headline and a list of bullets.',
              'Strategy Builder: a strategy object with only whitelisted values (first-hour window 15â€“60 min, target 0.25â€“3%, stop 0.5â€“4% or none, slippage 0â€“10 bps). The AI cannot return arbitrary values â€” anything outside the whitelist is rejected.'
            ]}
          ]},
        { h: '4. Rate limits and timeouts',
          body: [
            { type: 'p', text: 'AI calls are made from our backend server, never the browser, so the OpenAI key is never exposed. Each call has a 60-second timeout. We rate-limit at 20 Recommendations / hour and 10 Strategy Builder calls / hour per user to keep costs predictable.' }
          ]},
        { h: '5. Training and retention',
          body: [
            { type: 'p', text: 'We use OpenAI\'s API (not ChatGPT). Per OpenAI\'s API policy, content sent through the API is not used to train OpenAI\'s models by default. OpenAI may retain API request data for a limited period for abuse monitoring and legal compliance.' }
          ]},
        { h: '6. AI is a draft, not the final word',
          body: [
            { type: 'p', text: 'Every AI suggestion is a starting point. The Strategy Lab is a research tool â€” AI output is not investment advice. Always read the suggestions for accuracy and combine them with your own judgment.' }
          ]},
        { h: '7. AI is optional',
          body: [
            { type: 'p', text: 'The AI Lab tab is purely additive. Every other feature â€” Engine, Optimizer, Heatmap, Charts, Replay, Compare, Monte Carlo, Investment Planner, Signal Quality, Experiments â€” works fully without any AI involvement.' }
          ]},
        { h: '8. Questions',
          body: [{ type: 'html', html: 'Email <a href="mailto:stevenk@careersolutionsfortoday.com">stevenk@careersolutionsfortoday.com</a>.' }] }
      ]
    },

    about: {
      title: 'About the Creator',
      subtitle: null,
      sections: [
        { h: null,
          body: [
            // Special "hero" block â€” handled by renderer when h is null and first body item is type:'about-hero'.
            { type: 'about-hero',
              photo: 'https://raw.githubusercontent.com/StevenMKay/CareerSolutionsForToday/83f39f1306afa2ace31b6cd0c549d2929c520d79/photos/stevenphoto.png',
              name: 'Steven Kay',
              role: 'Creator of Career Solutions for Today'
            },
            { type: 'p', text: 'With a career rooted in finance and business strategy, Steven Kay brings over two decades of multifaceted experience across reporting and analytics, sales, training, credit underwriting, management, and project leadership. His focus is on empowering others and creating sustainable systems for growth.' },
            { type: 'p', text: 'Career Solutions for Today was built to give professionals the tools and confidence they need to tell their story, plan their next move, and stand out â€” all powered by thoughtful design and smart software.' },
            { type: 'about-socials',
              links: [
                { label: 'YouTube',   href: 'https://www.youtube.com/@CareerSolutionsforToday', icon: 'fa-youtube',  color: '#dc2626' },
                { label: 'LinkedIn',  href: 'https://linkedin.com/in/stevenmichaelkay',          icon: 'fa-linkedin', color: '#0a66c2' },
                { label: 'Instagram', href: 'https://www.instagram.com/stevenkayhiker',          icon: 'fa-instagram', color: '#e1306c' }
              ]
            },
            { type: 'html', html: '<div style="text-align:center;margin-top:14px"><a href="https://www.careersolutionsfortoday.com/AboutMe.html" target="_blank" rel="noopener" style="font-size:12px;color:#2980b9;">View full profile â†’</a></div>' }
          ]}
      ]
    }
  };

  // -------------------------------------------------------------------
  // CSS â€” injected once, scoped with .bt-legal- prefix so it cannot
  // leak into the rest of the page.
  // MOBILE: do not remove the @media block below â€” it is what keeps
  // the modal usable on phones.
  // -------------------------------------------------------------------
  var CSS = [
    '.bt-legal-backdrop{position:fixed;inset:0;background:rgba(3,62,62,0.55);backdrop-filter:blur(3px);z-index:1000;display:none;align-items:center;justify-content:center;padding:16px;}',
    '.bt-legal-backdrop.show{display:flex;}',
    '.bt-legal-modal{background:#fff;color:#0F2A2A;width:100%;max-width:640px;max-height:85vh;border-radius:14px;box-shadow:0 20px 60px rgba(3,62,62,0.30);border:1px solid #D9ECE9;display:flex;flex-direction:column;animation:btLegalPop .2s ease;}',
    '.bt-legal-modal--narrow{max-width:520px;}',
    '@keyframes btLegalPop{from{opacity:0;transform:translateY(8px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}',
    '.bt-legal-head{padding:18px 24px 12px;flex-shrink:0;border-bottom:3px solid #F4B740;background:#055050;border-radius:14px 14px 0 0;}',
    '.bt-legal-head h2{margin:0;color:#fff;font-size:18px;font-weight:700;}',
    '.bt-legal-head .sub{color:#DDF5F2;font-size:11px;margin:4px 0 0;letter-spacing:0.3px;text-transform:uppercase;}',
    '.bt-legal-body{overflow-y:auto;padding:16px 24px;color:#335959;font-size:14px;line-height:1.65;flex:1;}',
    '.bt-legal-body h3{color:#055050;margin:18px 0 6px;font-size:14px;font-weight:700;}',
    '.bt-legal-body h3:first-child{margin-top:0;}',
    '.bt-legal-body p{margin:0 0 8px;}',
    '.bt-legal-body ul,.bt-legal-body ol{margin:0 0 10px;padding-left:22px;}',
    '.bt-legal-body li{margin-bottom:4px;}',
    '.bt-legal-body a{color:#0D7A7A;}',
    '.bt-legal-body .bt-legal-note{background:#FFF7E0;border:1px solid #F8DFA0;border-left:4px solid #F4B740;padding:10px 12px;border-radius:6px;color:#705100;margin:10px 0;font-size:13px;}',
    '.bt-legal-foot{padding:12px 24px;border-top:1px solid #E6F1EF;text-align:center;flex-shrink:0;border-radius:0 0 14px 14px;background:#EEF8F7;}',
    '.bt-legal-close-btn{background:#055050;color:#fff;border:0;padding:10px 28px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;min-height:44px;}',
    '.bt-legal-close-btn:hover{background:#066060;}',
    '.bt-legal-xmark{position:absolute;top:10px;right:10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:18px;line-height:1;}',
    '.bt-legal-xmark:hover{background:rgba(255,255,255,0.25);}',
    // About hero
    '.bt-legal-about-hero{text-align:center;margin-bottom:14px;}',
    '.bt-legal-about-hero img{width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #D9ECE9;display:block;margin:0 auto 8px;}',
    '.bt-legal-about-hero .name{color:#055050;font-size:18px;font-weight:700;margin:0;}',
    '.bt-legal-about-hero .role{color:#0D7A7A;font-size:12px;font-weight:600;margin:2px 0 0;}',
    '.bt-legal-about-socials{display:flex;justify-content:center;gap:10px;margin-top:14px;flex-wrap:wrap;}',
    '.bt-legal-about-socials a{display:inline-flex;align-items:center;gap:6px;font-size:12px;text-decoration:none;padding:8px 12px;border:1px solid #D9ECE9;border-radius:8px;background:#F6FCFC;color:#0F2A2A;min-height:36px;transition:background .15s ease;}',
    '.bt-legal-about-socials a:hover{background:#EEF8F7;}',
    '.bt-legal-about-socials a i{font-size:14px;}',
    // MOBILE: tighten paddings, ensure tap targets are large enough.
    '@media (max-width: 480px){',
    '  .bt-legal-modal{max-height:90vh;}',
    '  .bt-legal-head{padding:14px 18px 10px;}',
    '  .bt-legal-body{padding:12px 18px;font-size:13px;}',
    '  .bt-legal-foot{padding:10px 18px;}',
    '  .bt-legal-close-btn{width:100%;}',
    '  .bt-legal-about-socials a{flex:1 1 calc(50% - 6px);justify-content:center;}',
    '}'
  ].join('');

  // -------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------
  var injected = false;
  var lastTrigger = null;
  var openId = null;

  function injectOnce() {
    if (injected) return;
    injected = true;

    // 1) styles
    var style = document.createElement('style');
    style.setAttribute('data-bt-legal-modals', '1');
    style.textContent = CSS;
    document.head.appendChild(style);

    // 2) backdrop + container (single root for all 4 modals)
    var root = document.createElement('div');
    root.id = 'bt-legal-root';
    root.className = 'bt-legal-backdrop';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<div class="bt-legal-modal" role="dialog" aria-modal="true" aria-labelledby="bt-legal-title" style="position:relative">'
                  +   '<button type="button" class="bt-legal-xmark" aria-label="Close" data-bt-legal-close>&times;</button>'
                  +   '<div class="bt-legal-head"><h2 id="bt-legal-title"></h2><p class="sub" id="bt-legal-sub" hidden></p></div>'
                  +   '<div class="bt-legal-body" id="bt-legal-body"></div>'
                  +   '<div class="bt-legal-foot"><button type="button" class="bt-legal-close-btn" data-bt-legal-close>Close</button></div>'
                  + '</div>';
    document.body.appendChild(root);

    // 3) wire close
    root.addEventListener('click', function (e) {
      if (e.target === root) close();
      if (e.target.closest && e.target.closest('[data-bt-legal-close]')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openId) close();
    });

    // 4) delegate openers anywhere on the page
    document.addEventListener('click', function (e) {
      var trig = e.target.closest && e.target.closest('[data-bt-open]');
      if (!trig) return;
      var id = trig.getAttribute('data-bt-open');
      if (!MODAL_DEFS[id]) return;
      e.preventDefault();
      lastTrigger = trig;
      open(id);
    });
  }

  // -------------------------------------------------------------------
  // Render a single modal definition into the shared container.
  // -------------------------------------------------------------------
  function render(def) {
    var root = document.getElementById('bt-legal-root');
    if (!root) return;
    var modalEl = root.querySelector('.bt-legal-modal');
    var body = root.querySelector('#bt-legal-body');
    var title = root.querySelector('#bt-legal-title');
    var sub = root.querySelector('#bt-legal-sub');

    title.textContent = def.title;
    if (def.subtitle) { sub.textContent = def.subtitle; sub.hidden = false; }
    else              { sub.textContent = ''; sub.hidden = true; }

    // About uses a narrower card
    modalEl.classList.toggle('bt-legal-modal--narrow', def.title === 'About the Creator');

    body.innerHTML = '';
    (def.sections || []).forEach(function (section) {
      if (section.h) {
        var h3 = document.createElement('h3');
        h3.textContent = section.h;
        body.appendChild(h3);
      }
      (section.body || []).forEach(function (block) { body.appendChild(renderBlock(block)); });
    });
  }

  function renderBlock(block) {
    if (block.type === 'p') {
      var p = document.createElement('p');
      p.textContent = block.text;
      return p;
    }
    if (block.type === 'ul' || block.type === 'ol') {
      var list = document.createElement(block.type);
      (block.items || []).forEach(function (it) {
        var li = document.createElement('li');
        li.textContent = it;
        list.appendChild(li);
      });
      return list;
    }
    if (block.type === 'note') {
      var n = document.createElement('div');
      n.className = 'bt-legal-note';
      n.textContent = block.text;
      return n;
    }
    if (block.type === 'html') {
      var holder = document.createElement('div');
      holder.innerHTML = block.html;
      return holder;
    }
    if (block.type === 'about-hero') {
      var hero = document.createElement('div');
      hero.className = 'bt-legal-about-hero';
      hero.innerHTML =
        '<img alt="" />' +
        '<p class="name"></p>' +
        '<p class="role"></p>';
      hero.querySelector('img').src = block.photo;
      hero.querySelector('img').alt = block.name;
      hero.querySelector('.name').textContent = block.name;
      hero.querySelector('.role').textContent = block.role;
      return hero;
    }
    if (block.type === 'about-socials') {
      var wrap = document.createElement('div');
      wrap.className = 'bt-legal-about-socials';
      (block.links || []).forEach(function (l) {
        var a = document.createElement('a');
        a.href = l.href; a.target = '_blank'; a.rel = 'noopener';
        a.style.color = l.color;
        a.innerHTML = '<i class="fa-brands ' + l.icon + '"></i> ' + l.label;
        wrap.appendChild(a);
      });
      return wrap;
    }
    return document.createComment('unknown block: ' + block.type);
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------
  function open(id) {
    injectOnce();
    var def = MODAL_DEFS[id];
    if (!def) return;
    render(def);
    var root = document.getElementById('bt-legal-root');
    root.classList.add('show');
    root.setAttribute('aria-hidden', 'false');
    openId = id;
    // Move focus to the close button for keyboard users.
    setTimeout(function () {
      var btn = root.querySelector('.bt-legal-xmark');
      if (btn) btn.focus();
    }, 50);
  }

  function close() {
    var root = document.getElementById('bt-legal-root');
    if (!root) return;
    root.classList.remove('show');
    root.setAttribute('aria-hidden', 'true');
    openId = null;
    if (lastTrigger && lastTrigger.focus) { try { lastTrigger.focus(); } catch (e) {} }
    lastTrigger = null;
  }

  // Inject on DOMContentLoaded so [data-bt-open] click delegation
  // starts working immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectOnce);
  } else {
    injectOnce();
  }

  window.BTLegalModals = { open: open, close: close, init: injectOnce };
})();
