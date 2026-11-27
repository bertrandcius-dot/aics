/* ⊗ AICS — owner accounts (Supabase Auth)
 *
 * Email + password sign up, sign in, password reset and sign out. A signed-in owner's domains are stored in
 * public.sites (row-level security: owners see and change only their own rows). Sign-ups, new sites and
 * verifications are queued to public.crm_outbox by database triggers and synced to HubSpot server-side.
 *
 * Depends on: app/config.js (window.AICS_SUPABASE), app/app.js (window.go, AICSApp).
 * Loads @supabase/supabase-js v2 from jsDelivr on demand.
 *
 * Test/dev escape hatch: set window.AICS_AUTH_DISABLED = true before this script runs to use the
 * dashboard without an account (the e2e suite does this). With no config, accounts are disabled too.
 */
(function (w, d) {
  'use strict';
  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js';
  var cfg = w.AICS_SUPABASE || {};
  var enabled = !w.AICS_AUTH_DISABLED && !!(cfg.url && cfg.key);
  var $ = function (id) { return d.getElementById(id); };

  var state = 'loading';          // loading | ready | offline | disabled
  var client = null;
  var session = null;
  var returnTo = null;            // dashboard route to open after sign-in
  var lastSignupEmail = '';
  var readyCbs = [];

  if (!enabled) state = 'disabled';

  /* ───────────── helpers ───────────── */
  function user() { return session ? session.user : null; }
  function flash(el, msg, ok) {
    if (!el) return;
    el.textContent = msg; el.classList.toggle('err', ok === false);
  }
  function busy(form, on) {
    var b = form && form.querySelector('button[type=submit]');
    if (!b) return;
    if (on) { b.dataset.label = b.textContent; b.disabled = true; b.textContent = 'Please wait…'; }
    else { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; }
  }
  function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); }
  function redirectURL() { return location.origin + location.pathname; }
  function friendly(err) {
    var m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
    if (/invalid login credentials/i.test(m)) return 'Email or password is incorrect.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first — check your inbox for the link.';
    if (/already registered|already exists/i.test(m)) return 'An account with this email already exists. Sign in instead.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/password should be|weak password/i.test(m)) return 'Choose a stronger password (at least 8 characters, mix letters and numbers).';
    if (/failed to fetch|network/i.test(m)) return 'Could not reach the sign-in service. Check your connection.';
    return m;
  }

  /** Dashboard routes need a signed-in owner when accounts are enabled. */
  function allows() { return state === 'disabled' || !!user(); }

  /* ───────────── nav + identity ───────────── */
  function paintNav() {
    var u = user();
    if ($('navSignIn')) $('navSignIn').hidden = !!u || state === 'disabled';
    if ($('navUser')) $('navUser').hidden = !u;
    if ($('navUserEmail')) $('navUserEmail').textContent = u ? u.email : '';
    if (u) {
      ['obEmail', 'acctEmail'].forEach(function (id) { var el = $(id); if (el && !el.value) el.value = u.email; });
    }
  }

  /* ───────────── views ───────────── */
  var COPY = {
    signin: ['Account', 'SIGN IN', 'Sign in to manage your protected domains, licence keys, invoices and payouts.'],
    signup: ['Get started', 'CREATE YOUR ACCOUNT', 'One account for all your domains. Free to start — you pick a plan when you register a domain.'],
    'forgot-password': ['Account', 'RESET PASSWORD', 'Forgot your password? We\'ll email you a reset link.'],
    'update-password': ['Account', 'NEW PASSWORD', 'Set a new password to finish resetting your account.'],
    'check-email': ['Almost there', 'CONFIRM YOUR EMAIL', 'One more step before your dashboard is ready.']
  };

  function show(route) {
    var c = COPY[route] || COPY.signin;
    $('authLabel').textContent = c[0]; $('authTitle').textContent = c[1]; $('authSub').textContent = c[2];
    d.querySelectorAll('[data-auth-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-auth-panel') !== route; });
    var off = state === 'offline' || state === 'disabled';
    $('authOffline').hidden = !off;
    if (state === 'disabled') $('authOfflineMsg').textContent = 'Accounts are turned off in this build, so the dashboard works locally without signing in.';
    if (route === 'update-password' && user()) $('upEmail').textContent = user().email;
    if (route === 'check-email') $('ceEmail').textContent = lastSignupEmail || 'your email';
    if ((route === 'signin' || route === 'signup') && user() && state === 'ready') {
      // Already signed in: go straight to where they were heading.
      setTimeout(function () { w.go(returnTo || 'dashboard'); returnTo = null; }, 0);
    }
  }

  /** Called by the router when a dashboard route is blocked. */
  function requireFor(route) { returnTo = route; }

  /* ───────────── actions ───────────── */
  function withClient(form, status, fn) {
    return function (e) {
      e.preventDefault();
      if (!client) return flash($(status), state === 'disabled' ? 'Accounts are turned off in this build.' : 'Sign-in service unavailable. Reload and try again.', false);
      flash($(status), '');
      busy(form, true);
      Promise.resolve().then(fn).catch(function (err) { flash($(status), friendly(err), false); })
        .then(function () { busy(form, false); });
    };
  }

  function onSignIn(form) {
    return withClient(form, 'siStatus', function () {
      var email = $('siEmail').value.trim().toLowerCase(), password = $('siPassword').value;
      if (!validEmail(email)) throw new Error('Enter a valid email address.');
      if (!password) throw new Error('Enter your password.');
      return client.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
        if (r.error) throw r.error;
        $('siPassword').value = '';
        // onAuthStateChange routes to the dashboard.
      });
    });
  }

  function onSignUp(form) {
    return withClient(form, 'suStatus', function () {
      var email = $('suEmail').value.trim().toLowerCase(), p1 = $('suPassword').value, p2 = $('suPassword2').value;
      if (!validEmail(email)) throw new Error('Enter a valid email address.');
      if (p1.length < 8) throw new Error('Password must be at least 8 characters.');
      if (p1 !== p2) throw new Error('Passwords do not match.');
      if (!$('suTerms').checked) throw new Error('Please accept the terms to continue.');
      return client.auth.signUp({ email: email, password: p1, options: { emailRedirectTo: redirectURL() } }).then(function (r) {
        if (r.error) throw r.error;
        $('suPassword').value = ''; $('suPassword2').value = '';
        lastSignupEmail = email;
        // Supabase returns a user with no identities when the email is already registered (no enumeration leak).
        if (r.data && r.data.user && r.data.user.identities && r.data.user.identities.length === 0) {
          throw new Error('An account with this email already exists. Sign in instead.');
        }
        if (!r.data.session) w.go('check-email');
        // With email confirmation off, a session arrives and onAuthStateChange routes to the dashboard.
      });
    });
  }

  function onForgot(form) {
    return withClient(form, 'fpStatus', function () {
      var email = $('fpEmail').value.trim().toLowerCase();
      if (!validEmail(email)) throw new Error('Enter a valid email address.');
      return client.auth.resetPasswordForEmail(email, { redirectTo: redirectURL() }).then(function (r) {
        if (r.error) throw r.error;
        // Same message whether or not the account exists.
        flash($('fpStatus'), 'If that email has an account, a reset link is on its way.');
      });
    });
  }

  function onUpdatePassword(form) {
    return withClient(form, 'upStatus', function () {
      var p1 = $('upPassword').value, p2 = $('upPassword2').value;
      if (!user()) throw new Error('Open the reset link from your email again — it has expired.');
      if (p1.length < 8) throw new Error('Password must be at least 8 characters.');
      if (p1 !== p2) throw new Error('Passwords do not match.');
      return client.auth.updateUser({ password: p1 }).then(function (r) {
        if (r.error) throw r.error;
        $('upPassword').value = ''; $('upPassword2').value = '';
        flash($('upStatus'), 'Password updated.');
        setTimeout(function () { w.go('dashboard'); }, 800);
      });
    });
  }

  function signOut() {
    if (!client) return;
    client.auth.signOut().then(function () { w.go('home'); });
  }

  function resend(btn) {
    if (!client || !lastSignupEmail) return w.go('signup');
    btn.disabled = true;
    client.auth.resend({ type: 'signup', email: lastSignupEmail, options: { emailRedirectTo: redirectURL() } })
      .then(function (r) { flash($('ceStatus'), r.error ? friendly(r.error) : 'Sent again.', !r.error); })
      .then(function () { setTimeout(function () { btn.disabled = false; }, 30000); });
  }

  /* ───────────── sites (database) ───────────── */
  /** Saves a registered domain to the owner's account. Resolves to {ok, message}. Never throws. */
  function registerSite(domain) {
    if (!client || !user()) return Promise.resolve({ ok: false, skipped: true });
    return client.from('sites').insert({ domain: domain }).then(function (r) {
      if (!r.error) return { ok: true, message: 'Saved to your account.' };
      if (r.error.code === '23505') {
        return client.from('sites').select('id').eq('domain', domain).maybeSingle().then(function (q) {
          return q.data ? { ok: true, message: 'Already in your account.' }
            : { ok: false, message: domain + ' is already registered to another account. Contact support to claim it.' };
        });
      }
      return { ok: false, message: 'Could not save the domain to your account: ' + friendly(r.error) };
    }, function (err) { return { ok: false, message: friendly(err) }; });
  }

  function sites() {
    if (!client || !user()) return Promise.resolve([]);
    return client.from('sites').select('id, domain, mode, rate_per_page_micros, verified_at, created_at').order('created_at')
      .then(function (r) { return r.error ? [] : r.data; });
  }

  /* ───────────── boot ───────────── */
  function ready() {
    paintNav();
    readyCbs.splice(0).forEach(function (fn) { try { fn(); } catch (e) {} });
    // Re-render the current route now that we know who is signed in.
    if (w.AICSApp) w.AICSApp.go(decodeURIComponent(location.hash.replace(/^#/, '')) || 'home');
  }

  function cleanAuthParams() {
    // Remove ?code=… / #access_token=… left by email links once supabase-js has consumed them.
    var u = new URL(location.href), dirty = false;
    ['code', 'error', 'error_code', 'error_description', 'type'].forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); dirty = true; } });
    if (/access_token=|error_description=/.test(u.hash)) { u.hash = 'dashboard'; dirty = true; }
    if (dirty) history.replaceState(null, '', u.pathname + u.search + u.hash);
  }

  function start() {
    client = w.supabase.createClient(cfg.url, cfg.key, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'aics:auth' }
    });
    client.auth.onAuthStateChange(function (event, s) {
      session = s;
      paintNav();
      if (event === 'PASSWORD_RECOVERY') { cleanAuthParams(); w.go('update-password'); return; }
      if (event === 'SIGNED_IN' && state === 'ready') {
        cleanAuthParams();
        var route = decodeURIComponent(location.hash.replace(/^#/, ''));
        if (!route || route === 'signin' || route === 'signup' || route === 'check-email' || route === 'home') {
          w.go(returnTo || 'dashboard'); returnTo = null;
        }
      }
      if (event === 'SIGNED_OUT') { session = null; paintNav(); }
    });
    client.auth.getSession().then(function (r) {
      session = r.data.session; state = 'ready'; cleanAuthParams(); ready();
    }, function () { state = 'offline'; ready(); });
  }

  function load() {
    if (w.supabase && w.supabase.createClient) return start();
    var s = d.createElement('script');
    s.src = CDN; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = function () { if (w.supabase && w.supabase.createClient) start(); else { state = 'offline'; ready(); } };
    s.onerror = function () { state = 'offline'; ready(); };
    d.head.appendChild(s);
  }

  /* ───────────── wiring ───────────── */
  [['signinForm', onSignIn], ['signupForm', onSignUp], ['forgotForm', onForgot], ['updatePwForm', onUpdatePassword]]
    .forEach(function (p) { var f = $(p[0]); if (f) f.addEventListener('submit', p[1](f)); });

  w.AICSAuth = {
    enabled: function () { return enabled; },
    state: function () { return state; },
    user: user, allows: allows, requireFor: requireFor, show: show,
    signOut: signOut, resend: resend, registerSite: registerSite, sites: sites,
    onReady: function (fn) { if (state === 'loading') readyCbs.push(fn); else fn(); },
    client: function () { return client; }
  };

  paintNav();
  if (enabled) load(); else ready();
})(window, document);
