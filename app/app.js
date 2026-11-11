/* ⊗ AICS — app controller
 * Hash router plus the workflow features layered on top of the landing page and
 * dashboard: onboarding, registry, install check, API keys, invoices & payouts,
 * legal documents, account settings and enterprise contact.
 *
 * Depends on: shield/shield.js (AICS), app/store.js, app/billing.js, app/legal.js,
 * and the globals defined by the inline script in index.html (loadCfg, renderSetup,
 * renderAll, initDashboard, downloadFile, copySnippet, currentSnippet, toggleDemo).
 */
(function (w, d) {
  'use strict';
  var S = w.AICSStore, B = w.AICSBilling, L = w.AICSLegal, A = w.AICS;
  var $ = function (id) { return d.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var usd = B.usd;
  var reduceMotion = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PLAN = {
    starter: { label: 'Starter', share: 0.80 },
    pro: { label: 'Pro', share: 0.85 },
    enterprise: { label: 'Enterprise', share: 0.85 }
  };

  /* ═══════════════ CONFIG & ACCOUNT ═══════════════ */
  function account() { return S.get('account', null); }

  /** Merge into the persisted shield config and re-render every view that depends on it. */
  function writeCfg(partial) {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('aics:config') || '{}'); } catch (e) {}
    Object.assign(saved, partial);
    try { localStorage.setItem('aics:config', JSON.stringify(saved)); } catch (e) {}
    Object.assign(A.config, partial);
    if (typeof w.loadCfg === 'function') w.loadCfg();
    w.renderSetup();
    w.renderAll();
    paintIdentity();
  }

  function termsURL() { try { return new URL(A.config.terms, location.href).href; } catch (e) { return A.config.terms; } }
  function cfgForDocs() { return Object.assign({}, A.config, { termsURL: termsURL() }); }

  function paintIdentity() {
    var acct = account();
    if (acct && $('sbDomain')) $('sbDomain').textContent = acct.domain;
    var plan = PLAN[(acct && acct.plan) || 'pro'];
    if ($('sbPlan')) $('sbPlan').textContent = 'Protected · ' + plan.label + ' Plan';
    if ($('acctPlanBadge')) $('acctPlanBadge').textContent = plan.label + ' · ' + Math.round(A.config.share * 100) + '% share';
  }

  // Keep the sidebar identity in sync whenever the inline script re-renders setup.
  var baseRenderSetup = w.renderSetup;
  w.renderSetup = function (fill) { baseRenderSetup(fill); paintIdentity(); };

  /* ═══════════════ ROUTER ═══════════════ */
  var LANDING = { home: null, how: 'how', compare: 'compare', pricing: 'pricing', install: 'install' };
  var DASH = {
    dashboard: 'dashTop', events: 'eventsCard', analytics: 'chartsRow', revenue: 'revenueCard',
    billing: 'billingCard', rules: 'rulesCard', badge: 'setupCard', verify: 'verifyCard',
    'api-keys': 'keysCard', 'legal-docs': 'legalCard', account: 'accountCard'
  };
  var PAGES = {
    'get-started': 'view-get-started', registry: 'view-registry', docs: 'view-docs',
    legal: 'view-legal', contact: 'view-contact'
  };
  var TITLES = {
    home: 'Home', how: 'How it works', compare: 'Compare', pricing: 'Pricing', install: 'Install',
    dashboard: 'Dashboard', events: 'Live events', analytics: 'Analytics', revenue: 'Revenue',
    billing: 'Invoices & payouts', rules: 'Bot rules', badge: 'Badge settings', verify: 'Install check',
    'api-keys': 'API keys', 'legal-docs': 'Legal documents', account: 'Account',
    'get-started': 'Get started', registry: 'Registry', docs: 'Docs', legal: 'Legal', contact: 'Contact sales'
  };
  var BASE_TITLE = d.title.split(' — ')[0].split(' · ')[0];
  var currentView = null;
  var reverseDash = {};
  Object.keys(DASH).forEach(function (k) { reverseDash[DASH[k]] = k; });

  function routeFromHash() { return decodeURIComponent(location.hash.replace(/^#/, '')) || 'home'; }

  function go(route) {
    if (!route) route = 'home';
    if (location.hash.replace(/^#/, '') === route) render(route);
    else location.hash = route;
  }

  function scrollToEl(el, smooth) {
    if (!el) return;
    el.scrollIntoView({ behavior: smooth && !reduceMotion ? 'smooth' : 'auto', block: 'start' });
  }

  function showOnly(view) {
    $('landing').style.display = view === 'landing' ? 'block' : 'none';
    $('dashboard').style.display = view === 'dashboard' ? 'block' : 'none';
    d.querySelectorAll('.page').forEach(function (p) { p.hidden = p.id !== view; });
  }

  function markActive(route) {
    d.querySelectorAll('[data-route]').forEach(function (el) {
      var r = el.getAttribute('data-route');
      var on = r === route || (r === 'home' && route in LANDING && el.closest('.nav-links'));
      el.classList.toggle('active', !!on);
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    var tab = d.querySelector('.dash-tabs a.active');
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function render(route) {
    var prev = currentView;
    if (route in LANDING) {
      showOnly('landing'); currentView = 'landing';
      if (LANDING[route]) setTimeout(function () { scrollToEl($(LANDING[route]), prev === 'landing'); }, 0);
      else w.scrollTo(0, 0);
    } else if (route in DASH) {
      showOnly('dashboard'); currentView = 'dashboard';
      w.initDashboard();
      refreshDashboardPanels();
      if (route === 'dashboard') w.scrollTo(0, 0);
      else setTimeout(function () { scrollToEl($(DASH[route]), prev === 'dashboard'); }, 0);
    } else if (route in PAGES) {
      showOnly(PAGES[route]); currentView = PAGES[route];
      w.scrollTo(0, 0);
      if (PAGE_RENDER[route]) PAGE_RENDER[route]();
    } else {
      showOnly('view-not-found'); currentView = 'view-not-found';
      w.scrollTo(0, 0);
    }
    markActive(route);
    d.title = BASE_TITLE + ' · ' + (TITLES[route] || 'Not found');
  }

  w.addEventListener('hashchange', function () { render(routeFromHash()); });

  // In-app links: route even when the hash is unchanged (so the section scrolls again).
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a && !e.defaultPrevented && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      go(a.getAttribute('href').slice(1));
      return;
    }
    var f = e.target.closest && e.target.closest('a[data-file]');
    if (f) { e.preventDefault(); w.downloadFile(f.getAttribute('data-file')); }
  });

  // Replace the original page switchers with routed versions so every caller gets deep links.
  w.go = go;
  w.showLanding = function () { go('home'); };
  w.showDashboard = function () { go('dashboard'); };
  w.navTo = function (id) { go(reverseDash[id] || 'dashboard'); };
  w.openSetup = function () { go('badge'); };
  w.startPlan = function (plan) {
    pendingPlan = plan || 'pro';
    if (location.hash === '#get-started') renderOnboarding(); else go('get-started');
  };

  /* ═══════════════ SHARED UI HELPERS ═══════════════ */
  function showText(name, text, type) {
    // fvFile is the viewer's current file, declared with `let` by the inline script in index.html.
    fvFile = { name: name, text: text, type: type || 'text/plain' }; // eslint-disable-line no-undef
    $('fvName').textContent = name;
    $('fvBody').textContent = text;
    $('fvStatus').textContent = '';
    $('fileViewer').hidden = false;
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var t = btn.textContent; btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = t; }, 1200);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { showText('copy.txt', text); });
    else showText('copy.txt', text);
  }

  /** Two-click confirmation for destructive buttons (dialogs are not available everywhere). */
  function confirmClick(btn, label, action) {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; action(); return; }
    btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
    setTimeout(function () { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3000);
  }

  function flash(el, msg, ok) {
    if (!el) return;
    el.textContent = msg; el.classList.toggle('err', ok === false);
    clearTimeout(el._t); el._t = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

  /* ═══════════════ INSTALL CHECK ═══════════════ */
  function checkHTML(html) {
    var c = A.config, has = function (re) { return re.test(html); };
    return [
      { label: 'Shield script included', ok: has(/<script[^>]+shield(\.min)?\.js/i), hint: 'Add the <script src=".../shield.js"> tag from the snippet.' },
      { label: 'Licence ID matches ' + c.id, ok: html.indexOf(c.id) !== -1, hint: 'Set data-id="' + c.id + '" on the script tag.' },
      { label: 'robots meta: noai, noimageai', ok: has(/<meta[^>]+name=["']robots["'][^>]+noai/i), hint: 'Add <meta name="robots" content="noai, noimageai">.' },
      { label: 'TDM reservation meta', ok: has(/<meta[^>]+name=["']tdm-reservation["'][^>]+content=["']1/i), hint: 'Add <meta name="tdm-reservation" content="1">.' },
      { label: 'ai-rights meta', ok: has(/<meta[^>]+name=["']ai-rights["']/i), hint: 'Add the ai-rights meta tag from the snippet.' },
      { label: 'Licence link', ok: has(/<link[^>]+rel=["']license["']/i), hint: 'Add <link rel="license" href="/ai.txt">.' },
      { label: 'Static watermark for non-JS crawlers', ok: has(/AI PROTECTED/), hint: 'Paste the <footer data-nosnippet> fallback from the snippet.' }
    ];
  }

  function robotsGroups(txt) {
    var groups = [], cur = null, lastWasAgent = false;
    txt.split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      var m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!m) return;
      var k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'user-agent') {
        if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
        cur.agents.push(v.toLowerCase()); lastWasAgent = true;
      } else {
        lastWasAgent = false;
        if (cur && (k === 'disallow' || k === 'allow')) cur.rules.push({ type: k, path: v });
      }
    });
    return groups;
  }

  function robotsBlocks(groups, agent) {
    var g = groups.filter(function (x) { return x.agents.indexOf(agent.toLowerCase()) !== -1; })[0];
    return !!(g && g.rules.some(function (r) { return r.type === 'disallow' && r.path === '/'; }));
  }

  function checkRobots(txt) {
    var groups = robotsGroups(txt);
    var star = groups.filter(function (x) { return x.agents.indexOf('*') !== -1; })[0];
    var out = ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Meta-ExternalAgent', 'PerplexityBot', 'Bytespider'].map(function (b) {
      return { label: 'robots.txt blocks ' + b, ok: robotsBlocks(groups, b), hint: 'Add "User-agent: ' + b + '" to the AI crawler group with "Disallow: /".' };
    });
    out.push({ label: 'Search engines still allowed', ok: !star || !star.rules.some(function (r) { return r.type === 'disallow' && r.path === '/'; }), hint: 'Do not disallow "/" for User-agent: *.' });
    out.push({ label: 'Policy files reachable (ai.txt allowed)', ok: /allow:\s*\/ai\.txt/i.test(txt), hint: 'Add "Allow: /ai.txt" so crawlers can read your terms.' });
    return out;
  }

  function renderChecklist(out, items, source) {
    var passed = items.filter(function (i) { return i.ok; }).length;
    out.innerHTML = '<div class="check-head">' + esc(source) + ' · ' + passed + '/' + items.length + ' passed</div>' +
      items.map(function (i) {
        return '<li class="' + (i.ok ? 'ok' : 'bad') + '"><span class="tick" aria-hidden="true">' + (i.ok ? '✓' : '✕') + '</span><div><div>' +
          esc(i.label) + '</div>' + (i.ok ? '' : '<div class="hint">' + esc(i.hint) + '</div>') + '</div></li>';
      }).join('');
    return { passed: passed, total: items.length };
  }

  function recordVerify(results) {
    var passed = 0, total = 0;
    results.forEach(function (r) { passed += r.passed; total += r.total; });
    S.set('verify', { passed: passed, total: total, at: Date.now() });
    paintVerifyBadge();
  }

  function paintVerifyBadge() {
    var v = S.get('verify', null), el = $('verifyBadge');
    if (!el) return;
    el.textContent = v ? v.passed + '/' + v.total + ' checks · ' + fmtDate(v.at) : 'not checked';
  }

  function mountVerify(host) {
    var id = host.getAttribute('data-verify');
    host.innerHTML =
      '<div class="field"><label for="' + id + 'Url">Site URL</label><div class="search-row tight">' +
      '<input id="' + id + 'Url" type="url" placeholder="https://yoursite.com">' +
      '<button class="btn-cyan" type="button" data-act="url">Check site</button></div></div>' +
      '<div class="field"><label for="' + id + 'Paste">Or paste your page source or robots.txt</label>' +
      '<textarea id="' + id + 'Paste" rows="4" placeholder="&lt;html&gt;… or User-agent: GPTBot …"></textarea></div>' +
      '<div class="dl-row"><button class="dl-btn" type="button" data-act="paste">Check pasted text</button>' +
      '<button class="dl-btn" type="button" data-act="self">Check this app</button></div>' +
      '<ul class="checklist" aria-live="polite"></ul>';
    var out = host.querySelector('.checklist');
    host.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'paste') {
        var txt = $(id + 'Paste').value;
        if (!txt.trim()) { out.innerHTML = '<li class="bad"><span class="tick">!</span><div>Paste your page source or robots.txt first.</div></li>'; return; }
        var isRobots = /^\s*user-agent\s*:/im.test(txt) && !/<html|<head|<meta/i.test(txt);
        recordVerify([renderChecklist(out, isRobots ? checkRobots(txt) : checkHTML(txt), isRobots ? 'robots.txt' : 'Page source')]);
      } else if (act === 'self') {
        var html = d.documentElement.outerHTML;
        fetch('robots.txt', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })
          .then(function (robots) {
            var items = checkHTML(html).concat(robots ? checkRobots(robots) : [{ label: 'robots.txt reachable', ok: false, hint: 'Serve robots.txt from the site root.' }]);
            recordVerify([renderChecklist(out, items, 'This app')]);
          });
      } else if (act === 'url') {
        var raw = $(id + 'Url').value.trim();
        if (!raw) { out.innerHTML = '<li class="bad"><span class="tick">!</span><div>Enter your site URL.</div></li>'; return; }
        var url;
        try { url = new URL(/^https?:/i.test(raw) ? raw : 'https://' + raw); } catch (err) { out.innerHTML = '<li class="bad"><span class="tick">!</span><div>That isn\'t a valid URL.</div></li>'; return; }
        out.innerHTML = '<li><span class="tick">…</span><div>Checking ' + esc(url.host) + '</div></li>';
        Promise.all([
          fetch(url.href, { mode: 'cors' }).then(function (r) { return r.text(); }),
          fetch(url.origin + '/robots.txt', { mode: 'cors' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })
        ]).then(function (res) {
          var items = checkHTML(res[0]).concat(res[1] ? checkRobots(res[1]) : [{ label: 'robots.txt reachable', ok: false, hint: 'Serve robots.txt from ' + url.origin + '/robots.txt.' }]);
          recordVerify([renderChecklist(out, items, url.host)]);
        }).catch(function () {
          out.innerHTML = '<li class="bad"><span class="tick">!</span><div>Your browser blocked reading ' + esc(url.host) +
            ' (cross-origin request). Open your page, view source, and paste it above; or paste your robots.txt.</div></li>';
        });
      }
    });
  }

  /* ═══════════════ API KEYS ═══════════════ */
  function keys() { return S.get('keys', []); }

  function renderKeys() {
    var list = $('keysList'); if (!list) return;
    var sel = $('keyBot');
    if (sel && !sel.options.length) sel.innerHTML = A.bots.map(function (b) { return '<option value="' + esc(b[0]) + '">' + esc(b[0]) + ' · ' + esc(b[1]) + '</option>'; }).join('');
    var all = keys();
    var active = all.filter(function (k) { return k.status === 'active'; });
    $('keysCount').textContent = active.length + ' active';
    list.innerHTML = all.length ? all.slice().reverse().map(function (k) {
      return '<div class="list-row' + (k.status === 'revoked' ? ' muted' : '') + '"><div class="lr-main"><div>' + esc(k.bot) +
        ' <span class="rule-vendor">' + esc(k.label || 'no note') + '</span></div><code class="key">' + esc(k.key.slice(0, 12)) + '…' + esc(k.key.slice(-4)) +
        '</code><div class="lr-sub">Issued ' + fmtDate(k.createdAt) + (k.revokedAt ? ' · revoked ' + fmtDate(k.revokedAt) : '') + '</div></div>' +
        '<div class="lr-actions">' + (k.status === 'active'
          ? '<button class="dl-btn" data-key-copy="' + esc(k.id) + '">Copy</button><button class="dl-btn danger" data-key-revoke="' + esc(k.id) + '">Revoke</button>'
          : '<span class="status-pill blocked">Revoked</span>') + '</div></div>';
    }).join('') : '<div class="empty">No keys yet. Issue one for each crawler that pays for access.</div>';
  }

  function issueKey(e) {
    e.preventDefault();
    var bot = $('keyBot').value, label = $('keyLabel').value.trim();
    var k = { id: 'key_' + S.randomHex(4), key: 'k_live_' + S.randomHex(16), bot: bot, label: label, status: 'active', createdAt: Date.now() };
    S.update('keys', [], function (list) { return list.concat(k); });
    if ($('keyLicense').checked) {
      var lic = A.config.licensed.slice();
      if (lic.indexOf(bot.toLowerCase()) === -1) lic.push(bot.toLowerCase());
      writeCfg({ licensed: lic });
    }
    $('keyLabel').value = '';
    renderKeys();
    showText(bot + '-licence-key.txt', [
      'Licence key for ' + bot + (label ? ' (' + label + ')' : ''),
      '', k.key, '',
      'Give this key to the licensee. Their crawler must send it on every request:',
      '  Authorization: AICS-License ' + k.key, '',
      'Then update the edge worker secret (Dashboard → API Keys → Edge worker secret).',
      'This is the only time the full key is shown in a dialog; you can copy it again from the list.'
    ].join('\n'));
  }

  function onKeysClick(e) {
    var c = e.target.getAttribute('data-key-copy'), r = e.target.getAttribute('data-key-revoke');
    if (c) { var k = keys().filter(function (x) { return x.id === c; })[0]; if (k) copyText(k.key, e.target); }
    if (r) confirmClick(e.target, 'Click to revoke', function () {
      var revoked;
      S.update('keys', [], function (list) {
        return list.map(function (k) { if (k.id === r) { revoked = k; return Object.assign({}, k, { status: 'revoked', revokedAt: Date.now() }); } return k; });
      });
      var stillActive = keys().some(function (k) { return k.status === 'active' && revoked && k.bot === revoked.bot; });
      if (revoked && !stillActive) writeCfg({ licensed: A.config.licensed.filter(function (b) { return b !== revoked.bot.toLowerCase(); }) });
      renderKeys();
    });
  }

  function showKeysSecret() {
    var active = keys().filter(function (k) { return k.status === 'active'; });
    var value = active.map(function (k) { return k.key + ':' + k.bot; }).join(',');
    showText('AICS_LICENSE_KEYS.txt', [
      '# Edge worker secret: licence keys accepted by edge/worker.js',
      '# ' + active.length + ' active key(s). Run from the edge/ directory:',
      '', 'wrangler secret put AICS_LICENSE_KEYS', '', '# then paste this value:', '',
      value || '(no active keys — issue one first)'
    ].join('\n'));
  }

  /* ═══════════════ INVOICES & PAYOUTS ═══════════════ */
  function invoices() { return S.get('invoices', []); }
  function payouts() { return S.get('payouts', []); }

  function renderPeriods() {
    var sel = $('billPeriod'); if (!sel) return;
    var keep = sel.value;
    var set = {}; set[B.periodOf(Date.now())] = true;
    A.events().forEach(function (e) { if (e.status === 'billed' || e.status === 'blocked') set[B.periodOf(e.ts)] = true; });
    invoices().forEach(function (i) { set[i.period] = true; });
    var list = Object.keys(set).sort().reverse();
    sel.innerHTML = list.map(function (p) { return '<option value="' + p + '">' + B.periodLabel(p) + '</option>'; }).join('');
    if (keep && set[keep]) sel.value = keep;
  }

  function renderBilling() {
    if (!$('invTable')) return;
    renderPeriods();
    var inv = invoices(), po = payouts(), b = B.balance(inv, po);
    $('bDraft').textContent = usd(b.draft);
    $('bOutstanding').textContent = usd(b.outstanding);
    $('bCollected').textContent = usd(b.collected);
    $('bAvailable').textContent = usd(b.available);
    $('invTable').innerHTML = inv.length ? inv.slice().reverse().map(function (i) {
      var pill = { draft: 'pending', sent: 'billed', paid: 'billed', void: 'blocked' }[i.status];
      var acts = '<button class="dl-btn" data-inv="view" data-id="' + i.id + '">View</button>';
      if (i.status === 'draft') acts += '<button class="dl-btn" data-inv="send" data-id="' + i.id + '">Send</button>';
      if (i.status === 'sent') acts += '<button class="dl-btn" data-inv="paid" data-id="' + i.id + '">Mark paid</button>';
      if (i.status === 'draft' || i.status === 'sent') acts += '<button class="dl-btn danger" data-inv="void" data-id="' + i.id + '">Void</button>';
      return '<tr><td><code>' + esc(i.id) + '</code></td><td>' + esc(i.vendor) + '</td><td>' + esc(B.periodLabel(i.period)) +
        '</td><td>' + usd(i.total) + '</td><td>' + usd(i.ownerShare) + '</td><td><span class="status-pill ' + pill + '">' +
        i.status[0].toUpperCase() + i.status.slice(1) + '</span></td><td class="row-acts">' + acts + '</td></tr>';
    }).join('') : '<tr class="empty-row"><td colspan="7">No invoices yet. Pick a period and choose “Generate invoices”.</td></tr>';
    var acct = account() || {};
    $('payoutBtn').disabled = b.available <= 0;
    $('payoutNote').textContent = b.available > 0
      ? usd(b.available) + ' collected and ready. Payouts go to ' + (acct.payout ? payoutLabel(acct) : 'your payout method (set it in Account)') + ' on ' + fmtDate(B.nextPayoutDate()) + '.'
      : 'Your share of paid invoices becomes available here. Payouts are scheduled for the 1st of each month.';
    $('payoutList').innerHTML = po.slice().reverse().map(function (p) {
      return '<div class="list-row"><div class="lr-main"><div><code>' + esc(p.id) + '</code> · ' + usd(p.amount) + '</div><div class="lr-sub">Requested ' +
        fmtDate(p.requestedAt) + ' · to ' + esc(p.method) + ' · scheduled ' + fmtDate(p.scheduledFor) + '</div></div><span class="status-pill pending">' +
        esc(p.status[0].toUpperCase() + p.status.slice(1)) + '</span></div>';
    }).join('');
  }

  function payoutLabel(acct) {
    var m = { stripe: 'Stripe Connect', bank: 'Bank transfer', paypal: 'PayPal' }[acct.payout] || acct.payout;
    return m + (acct.payoutRef ? ' (' + acct.payoutRef + ')' : '');
  }

  function generateInvoices() {
    var period = $('billPeriod').value;
    var fresh = B.buildInvoices(A.events(), period, invoices(), A.config);
    if (!fresh.length) {
      $('payoutNote').textContent = 'No uninvoiced chargeable usage for ' + B.periodLabel(period) + '.';
      return;
    }
    S.update('invoices', [], function (list) { return list.concat(fresh); });
    renderBilling();
    $('payoutNote').textContent = 'Created ' + fresh.length + ' draft invoice' + (fresh.length > 1 ? 's' : '') + ' for ' + B.periodLabel(period) + '. Review and send them.';
  }

  function onInvoiceClick(e) {
    var act = e.target.getAttribute('data-inv'), id = e.target.getAttribute('data-id');
    if (!act) return;
    var inv = invoices().filter(function (i) { return i.id === id; })[0];
    if (!inv) return;
    if (act === 'view') return showText(inv.id + '.txt', B.invoiceText(inv));
    var apply = function (fn) {
      S.update('invoices', [], function (list) { return list.map(function (i) { return i.id === id ? fn(i) : i; }); });
      renderBilling();
    };
    if (act === 'send' || act === 'paid') apply(function (i) { return B.advance(i); });
    if (act === 'void') confirmClick(e.target, 'Click to void', function () { apply(function (i) { return B.voidInvoice(i); }); });
  }

  function requestPayout() {
    var acct = account() || {};
    try {
      var p = B.makePayout(invoices(), payouts(), acct.payout ? payoutLabel(acct) : '');
      S.update('payouts', [], function (list) { return list.concat(p); });
      renderBilling();
    } catch (err) {
      $('payoutNote').textContent = err.message;
      if (!acct.payout) setTimeout(function () { go('account'); }, 900);
    }
  }

  /* ═══════════════ LEGAL DOCUMENTS ═══════════════ */
  function mountLegal(host) {
    var id = host.getAttribute('data-legal');
    host.innerHTML =
      '<p class="panel-lead">Templates filled from your licence settings and crawl logs. Review them with counsel before sending.</p>' +
      '<div class="doc-list">' +
      '<div class="list-row"><div class="lr-main"><div>AI usage addendum to your Terms of Service</div><div class="lr-sub">Reservation of rights, licensing terms, rate and enforcement</div></div>' +
      '<button class="dl-btn" data-doc-act="tos">Generate</button></div>' +
      '<div class="list-row"><div class="lr-main"><div>Notice of unlicensed use</div><div class="lr-sub">Built from a vendor\'s blocked requests this period</div>' +
      '<label class="sr-only" for="' + id + 'Vendor">Vendor</label><select class="mini-select" id="' + id + 'Vendor"></select></div>' +
      '<button class="dl-btn" data-doc-act="notice">Generate</button></div>' +
      '<div class="list-row"><div class="lr-main"><div>Notice to AI systems</div><div class="lr-sub">The text shown in your watermark</div></div>' +
      '<button class="dl-btn" data-doc-act="ainotice">View</button></div>' +
      '<div class="list-row"><div class="lr-main"><div>Policy files</div><div class="lr-sub">robots.txt · ai.txt · llms.txt · tdmrep.json</div></div>' +
      '<div class="lr-actions"><button class="dl-btn" data-file-open="robots.txt">robots</button><button class="dl-btn" data-file-open="ai.txt">ai.txt</button><button class="dl-btn" data-file-open=".well-known/tdmrep.json">tdmrep</button></div></div>' +
      '</div>';
    host.addEventListener('click', function (e) {
      var t = e.target, act = t.getAttribute('data-doc-act'), file = t.getAttribute('data-file-open');
      if (file) return w.downloadFile(file);
      if (act === 'tos') showText('ai-usage-addendum.txt', L.tosAddendum(cfgForDocs()));
      if (act === 'ainotice') showText('ai-notice.txt', A.notice());
      if (act === 'notice') {
        var vendor = $(id + 'Vendor').value;
        if (!vendor) return showText('notice.txt', 'No AI vendor has been logged yet. Notices are built from your crawl events.');
        var period = B.periodOf(Date.now());
        var u = B.usageByVendor(A.events(), period)[vendor] || {};
        u.period = B.periodLabel(period);
        showText('unlicensed-use-notice-' + vendor.toLowerCase().replace(/\W+/g, '-') + '.txt', L.unlicensedNotice(cfgForDocs(), vendor, u));
      }
    });
  }

  function renderLegalVendors() {
    var usage = B.usageByVendor(A.events(), B.periodOf(Date.now()));
    var vendors = Object.keys(usage).sort(function (a, b) {
      return ((usage[b].blocked || {}).amount || 0) - ((usage[a].blocked || {}).amount || 0);
    });
    d.querySelectorAll('[data-legal] select').forEach(function (sel) {
      var keep = sel.value;
      sel.innerHTML = vendors.length ? vendors.map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(v) + ' · ' + ((usage[v].blocked || {}).events || 0) + ' blocked</option>';
      }).join('') : '<option value="">No vendors logged yet</option>';
      if (keep && usage[keep]) sel.value = keep;
    });
  }

  /* ═══════════════ ACCOUNT ═══════════════ */
  function fillAccount() {
    var f = $('accountForm'); if (!f || f.contains(d.activeElement)) return;
    var acct = account() || {};
    $('acctOwner').value = acct.owner || A.config.owner;
    $('acctEmail').value = acct.email || '';
    $('acctPlan').value = acct.plan || 'pro';
    $('acctPayout').value = acct.payout || '';
    $('acctPayoutRef').value = acct.payoutRef || '';
    $('acctEndpoint').value = acct.endpoint || A.config.endpoint || '';
  }

  function saveAccount(e) {
    e.preventDefault();
    var endpoint = $('acctEndpoint').value.trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) return flash($('acctStatus'), 'Event endpoint must start with http:// or https://', false);
    var prev = account() || {};
    var acct = Object.assign({}, prev, {
      owner: $('acctOwner').value.trim() || A.config.owner,
      email: $('acctEmail').value.trim(),
      plan: $('acctPlan').value,
      payout: $('acctPayout').value,
      payoutRef: $('acctPayoutRef').value.trim(),
      endpoint: endpoint,
      domain: prev.domain || location.hostname || 'localhost',
      licenseId: prev.licenseId || A.config.id,
      registeredAt: prev.registeredAt || Date.now()
    });
    S.set('account', acct);
    writeCfg({ owner: acct.owner, share: PLAN[acct.plan].share, endpoint: endpoint });
    flash($('acctStatus'), 'Saved');
    renderBilling();
  }

  /* ═══════════════ ONBOARDING ═══════════════ */
  var pendingPlan = null;

  function wizard(step) {
    d.querySelectorAll('[data-step-panel]').forEach(function (p) { p.hidden = +p.getAttribute('data-step-panel') !== step; });
    d.querySelectorAll('#wizardSteps li').forEach(function (li) {
      var n = +li.getAttribute('data-step');
      li.classList.toggle('on', n === step); li.classList.toggle('done', n < step);
    });
    if (step === 2) { $('obSnippet').textContent = w.currentSnippet(); $('obIdOut').textContent = A.config.id + ' · ' + ((account() || {}).domain || ''); }
    var top = $('view-get-started'); if (top && step > 1) scrollToEl(top.querySelector('.wizard'), true);
  }

  function renderOnboarding() {
    var acct = account();
    if (acct) {
      $('obDomain').value = acct.domain || '';
      $('obOwner').value = acct.owner || '';
      $('obEmail').value = acct.email || '';
      $('obPlan').value = acct.plan || 'pro';
    }
    $('obRate').value = A.config.rate;
    $('obMode').value = A.config.mode;
    $('obLicensed').value = A.config.licensed.join(',');
    if (pendingPlan) { $('obPlan').value = pendingPlan; pendingPlan = null; }
    wizard(1);
  }

  function cleanDomain(raw) {
    var v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : '';
  }

  function submitOnboarding(e) {
    e.preventDefault();
    var domain = cleanDomain($('obDomain').value);
    if (!domain) return flash($('obStatus'), 'Enter a domain like yoursite.com', false);
    var rate = parseFloat($('obRate').value);
    if (isNaN(rate) || rate < 0) return flash($('obStatus'), 'Rate must be a positive number', false);
    var prev = account() || {};
    var id = prev.domain === domain && prev.licenseId ? prev.licenseId
      : 'AICS-' + new Date().getFullYear() + '-' + String(parseInt(S.randomHex(3), 16) % 100000).padStart(5, '0');
    var plan = $('obPlan').value;
    var acct = Object.assign({}, prev, {
      domain: domain, owner: $('obOwner').value.trim() || domain, email: $('obEmail').value.trim(),
      plan: plan, licenseId: id, registeredAt: prev.domain === domain ? prev.registeredAt : Date.now()
    });
    S.set('account', acct);
    writeCfg({
      id: id, owner: acct.owner, rate: rate, mode: $('obMode').value, share: PLAN[plan].share,
      licensed: $('obLicensed').value.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean)
    });
    wizard(2);
  }

  /* ═══════════════ REGISTRY ═══════════════ */
  var REGISTRY_EXAMPLES = [
    { domain: 'lawfirm.com', owner: 'Example Law LLP', licenseId: 'AICS-2026-00112', mode: 'block', rate: 0.002 },
    { domain: 'newsroom.net', owner: 'Newsroom Media', licenseId: 'AICS-2026-00398', mode: 'meter-and-bill', rate: 0.001 },
    { domain: 'publisher.org', owner: 'Open Publisher Co-op', licenseId: 'AICS-2026-00521', mode: 'meter-and-bill', rate: 0.0008 },
    { domain: 'mediaco.com', owner: 'MediaCo Inc.', licenseId: 'AICS-2026-00733', mode: 'allow', rate: 0.0015 },
    { domain: 'techcrunch.io', owner: 'Tech Demo Site', licenseId: 'AICS-2026-00847', mode: 'meter-and-bill', rate: 0.001 }
  ];

  function registryEntries() {
    var acct = account();
    var own = acct ? [{ domain: acct.domain, owner: acct.owner, licenseId: A.config.id, mode: A.config.mode, rate: A.config.rate, registeredAt: acct.registeredAt, own: true }] : [];
    return own.concat(REGISTRY_EXAMPLES.filter(function (x) { return !acct || x.domain !== acct.domain; }).map(function (x) { return Object.assign({ example: true }, x); }));
  }

  function renderRegistry(q) {
    var out = $('registryResults'); if (!out) return;
    q = (q == null ? $('registryQuery').value : q).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    var all = registryEntries();
    var hits = q ? all.filter(function (x) { return x.domain.indexOf(q) !== -1 || x.licenseId.toLowerCase().indexOf(q) !== -1; }) : all;
    var modeLabel = { block: 'All AI crawlers blocked', 'meter-and-bill': 'Licensed crawlers billed, others blocked', allow: 'All AI crawlers metered' };
    out.innerHTML = hits.length ? hits.map(function (x) {
      return '<div class="list-row reg"><div class="lr-main"><div class="reg-domain">' + esc(x.domain) +
        (x.own ? ' <span class="tag">your domain</span>' : '') + (x.example ? ' <span class="tag muted">example entry</span>' : '') + '</div>' +
        '<div class="lr-sub">' + esc(x.owner) + ' · <code>' + esc(x.licenseId) + '</code> · ' + esc(modeLabel[x.mode] || x.mode) + ' · ' + x.rate + ' USD/token' +
        (x.registeredAt ? ' · since ' + fmtDate(x.registeredAt) : '') + '</div></div>' +
        '<div class="lr-actions"><span class="status-pill billed">Protected</span>' +
        (x.own ? '<button class="dl-btn" onclick="go(\'badge\')">Manage</button><button class="dl-btn" data-file-open="ai.txt">Terms</button>' : '') + '</div></div>';
    }).join('') : '<div class="empty">No registry entry for “' + esc(q) + '”. That domain hasn\'t reserved AI rights through AICS. <a href="#get-started">Register it →</a></div>';
  }

  /* ═══════════════ CONTACT ═══════════════ */
  function submitContact(e) {
    e.preventDefault();
    var lead = {
      id: 'lead_' + S.randomHex(4), at: Date.now(),
      name: $('ctName').value.trim(), company: $('ctCompany').value.trim(), email: $('ctEmail').value.trim(),
      pages: $('ctPages').value, message: $('ctMsg').value.trim()
    };
    S.update('leads', [], function (l) { return l.concat(lead); });
    var acct = account();
    if (acct && acct.endpoint) {
      try { fetch(acct.endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ type: 'enterprise_request', lead: lead }) }).catch(function () {}); } catch (err) {}
    }
    $('contactSummary').textContent = [
      'AICS Enterprise request · ' + new Date(lead.at).toISOString().slice(0, 10),
      'Name:     ' + lead.name, 'Company:  ' + lead.company, 'Email:    ' + lead.email,
      'Pages:    ' + lead.pages, '', lead.message || '(no message)'
    ].join('\n');
    $('contactForm').hidden = true; $('contactDone').hidden = false;
  }

  function newContact() { $('contactForm').reset(); $('contactForm').hidden = false; $('contactDone').hidden = true; }

  /* ═══════════════ DOCS ═══════════════ */
  function docsTo(id) { setTimeout(function () { scrollToEl($(id), true); }, 30); }

  /* ═══════════════ WORKSPACE ═══════════════ */
  function exportData() { showText('aics-workspace.json', JSON.stringify(S.exportAll(), null, 2), 'application/json'); }
  function resetAll(btn) {
    confirmClick(btn, 'Click again to erase everything', function () {
      S.clearAll(); A.clear();
      location.hash = 'dashboard';
      location.reload();
    });
  }

  /* ═══════════════ WIRING ═══════════════ */
  var PAGE_RENDER = {
    'get-started': renderOnboarding,
    registry: function () { renderRegistry(); },
    legal: renderLegalVendors
  };

  function refreshDashboardPanels() {
    renderKeys(); renderBilling(); renderLegalVendors(); fillAccount(); paintVerifyBadge(); paintIdentity();
  }

  d.querySelectorAll('[data-verify]').forEach(mountVerify);
  d.querySelectorAll('[data-legal]').forEach(mountLegal);
  $('keyForm').addEventListener('submit', issueKey);
  $('keysList').addEventListener('click', onKeysClick);
  $('invTable').addEventListener('click', onInvoiceClick);
  $('billPeriod').addEventListener('change', renderBilling);
  $('accountForm').addEventListener('submit', saveAccount);
  $('onboardForm').addEventListener('submit', submitOnboarding);
  $('registryForm').addEventListener('submit', function (e) { e.preventDefault(); renderRegistry(); });
  $('registryQuery').addEventListener('input', function () { renderRegistry(); });
  $('contactForm').addEventListener('submit', submitContact);
  d.querySelectorAll('.docs-toc [data-doc]').forEach(function (b) {
    b.addEventListener('click', function () { docsTo(b.getAttribute('data-doc')); });
  });
  d.addEventListener('click', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-file-open');
    if (f && !e.target.closest('[data-legal]')) w.downloadFile(f);
  });

  // Live updates: new events refresh billing periods and vendor lists while the dashboard is open.
  var pending = false;
  A.on(function () {
    if (pending) return; pending = true;
    setTimeout(function () {
      pending = false;
      if (currentView === 'dashboard') { renderPeriods(); renderLegalVendors(); }
    }, 500);
  });
  S.on(function (key) { if (key === 'account') paintIdentity(); });

  w.AICSApp = {
    go: go, wizard: wizard, docsTo: docsTo, copyText: copyText, showText: showText,
    generateInvoices: generateInvoices, requestPayout: requestPayout,
    exportInvoices: function () { showText('aics-invoices.csv', B.invoicesCSV(invoices()), 'text/csv'); },
    showKeysSecret: showKeysSecret, exportData: exportData, resetAll: resetAll, newContact: newContact,
    checkHTML: checkHTML, checkRobots: checkRobots, writeCfg: writeCfg
  };

  render(routeFromHash());
})(window, document);
