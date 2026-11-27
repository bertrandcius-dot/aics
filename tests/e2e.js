/* End-to-end check: every route renders, every button and link does something,
 * and the full workflow (register → install → verify → license → crawl → invoice →
 * get paid) works. Run: node tests/e2e.js  (needs Playwright; serves the repo itself). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✕ ') + msg); if (!ok) failures++; };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
  // The main workflow runs with accounts off (local workspace); the Accounts section below tests sign-in.
  await ctx.addInitScript(() => { window.AICS_AUTH_DISABLED = true; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.AICSApp);

  const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);

  console.log('Routes');
  const routes = {
    home: '#landing', how: '#how', compare: '#compare', pricing: '#pricing', install: '#install',
    dashboard: '#dashTop', events: '#eventsCard', analytics: '#chartsRow', revenue: '#revenueCard', billing: '#billingCard',
    rules: '#rulesCard', badge: '#setupCard', verify: '#verifyCard', 'api-keys': '#keysCard', 'legal-docs': '#legalCard', account: '#accountCard',
    'get-started': '#view-get-started', registry: '#view-registry', docs: '#view-docs', legal: '#view-legal', contact: '#view-contact',
    signin: '#signinForm', signup: '#signupForm', 'forgot-password': '#forgotForm', 'update-password': '#updatePwForm',
    'check-email': '[data-auth-panel="check-email"]',
    'no-such-page': '#view-not-found'
  };
  for (const [r, sel] of Object.entries(routes)) {
    await page.evaluate((x) => { location.hash = x; }, r);
    await page.waitForTimeout(120);
    check(await visible(sel), `#${r} shows ${sel}`);
  }

  console.log('Every link and button');
  await page.evaluate(() => { location.hash = 'home'; });
  const controls = await page.evaluate(() => [...document.querySelectorAll('a, button')].map((el, i) => {
    el.dataset.e2e = i;
    const handled = el.hasAttribute('onclick') || el.type === 'submit' || el.hasAttribute('data-act') || el.hasAttribute('data-doc') ||
      el.hasAttribute('data-file-open') || el.hasAttribute('data-doc-act') || el.hasAttribute('data-inv') ||
      el.hasAttribute('data-key-copy') || el.hasAttribute('data-key-revoke') || (el.getAttribute('href') || '').length > 1;
    return { i, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), handled };
  }));
  const dead = controls.filter((c) => !c.handled);
  check(dead.length === 0, `${controls.length} controls, none without an action` + (dead.length ? ': ' + dead.map((c) => c.text).join(' | ') : ''));
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)));
  const known = new Set(Object.keys(routes).filter((r) => r !== 'no-such-page'));
  const badHrefs = [...new Set(hrefs)].filter((h) => !known.has(h));
  check(badHrefs.length === 0, `${hrefs.length} in-app links all point at known routes` + (badHrefs.length ? ': ' + badHrefs.join(', ') : ''));

  console.log('Workflow');
  await page.evaluate(() => AICSApp.go('home'));
  await page.click('.plan-btn >> text=Get started free');
  await page.waitForTimeout(150);
  check(await page.inputValue('#obPlan') === 'starter', 'Starter pricing button opens onboarding with Starter selected');
  await page.fill('#obDomain', 'https://www.Example-News.com/articles');
  await page.fill('#obOwner', 'Example News LLC');
  await page.fill('#obLicensed', 'ClaudeBot');
  await page.click('#onboardForm button[type=submit]');
  await page.waitForTimeout(150);
  const id = await page.evaluate(() => AICS.config.id);
  check(/^AICS-\d{4}-\d{5}$/.test(id), `registration issues a licence ID (${id})`);
  check((await page.textContent('#obSnippet')).includes(id), 'install step shows a snippet with the new ID');
  await page.click('[data-step-panel="2"] >> text=I\'ve installed it');
  await page.click('[data-verify="wizard"] [data-act="self"]');
  await page.waitForTimeout(300);
  check((await page.textContent('[data-verify="wizard"] .checklist')).includes('passed'), 'install check runs and reports results');

  await page.evaluate(() => AICSApp.go('registry'));
  await page.fill('#registryQuery', 'example-news');
  check((await page.textContent('#registryResults')).includes('your domain'), 'registry finds the newly registered domain');

  await page.evaluate(() => AICSApp.go('api-keys'));
  await page.selectOption('#keyBot', 'GPTBot');
  await page.fill('#keyLabel', 'OpenAI pilot');
  await page.click('#keyForm button[type=submit]');
  check(await page.evaluate(() => AICS.config.licensed.includes('gptbot')), 'issuing a key licenses the crawler');
  check((await page.textContent('#fvBody')).includes('k_live_'), 'new key is shown once in the viewer');
  await page.click('.fv-actions >> text=✕');
  await page.click('text=Edge worker secret');
  check((await page.textContent('#fvBody')).includes(':GPTBot'), 'edge worker secret lists the key');
  await page.keyboard.press('Escape');

  await page.evaluate(() => { AICS.simulate('GPTBot', { tokens: 5000 }); AICS.simulate('Bytespider', { tokens: 3000 }); });
  await page.evaluate(() => AICSApp.go('billing'));
  await page.waitForTimeout(150);
  const before = await page.$$eval('#invTable tr', (r) => r.length);
  await page.click('text=Generate invoices');
  const drafts = await page.$$eval('#invTable [data-inv="send"]', (b) => b.length);
  check(drafts > 0, `generates draft invoices (${drafts})`);
  await page.click('#invTable [data-inv="view"]');
  check((await page.textContent('#fvBody')).includes('TOTAL DUE'), 'invoice opens as a document');
  await page.keyboard.press('Escape');
  await page.click('#invTable [data-inv="send"]');
  await page.click('#invTable [data-inv="paid"]');
  check((await page.textContent('#bCollected')) !== '$0.00', 'paid invoice counts as collected');
  await page.click('#payoutBtn');
  await page.waitForTimeout(1000);
  check(await page.evaluate(() => location.hash) === '#account', 'payout without a method sends you to Account');
  await page.selectOption('#acctPayout', 'stripe');
  await page.fill('#acctPayoutRef', 'acct_test');
  await page.click('#accountForm button[type=submit]');
  await page.evaluate(() => AICSApp.go('billing'));
  await page.click('#payoutBtn');
  check((await page.textContent('#payoutList')).includes('Stripe Connect'), 'payout scheduled to the saved method');
  check(await page.textContent('#bAvailable') === '$0.00', 'available balance drops to zero after payout');

  await page.evaluate(() => AICSApp.go('legal-docs'));
  await page.click('#legalCard [data-doc-act="notice"]');
  check((await page.textContent('#fvBody')).includes('Unlicensed requests'), 'unlicensed-use notice generated from logs');
  await page.keyboard.press('Escape');
  await page.click('#legalCard [data-doc-act="tos"]');
  check((await page.textContent('#fvBody')).includes(id), 'ToS addendum uses the licence ID');
  await page.keyboard.press('Escape');

  await page.evaluate(() => AICSApp.go('contact'));
  await page.fill('#ctName', 'Sam Rivera'); await page.fill('#ctCompany', 'Example Media'); await page.fill('#ctEmail', 'sam@example.com');
  await page.click('#contactForm button[type=submit]');
  check(await visible('#contactDone'), 'enterprise request is recorded');

  await page.evaluate(() => AICSApp.go('docs'));
  await page.click('.docs-toc >> text=Edge enforcement');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => { const r = document.getElementById('doc-edge').getBoundingClientRect(); return r.top >= 0 && r.top < 300; }), 'docs contents jump to the section');

  console.log('Accounts');
  // Fake Supabase client: same API surface the app uses, no network.
  const fakeSupabase = () => {
    const db = { users: {}, sites: [] };
    let session = null; const subs = [];
    const emit = (ev) => subs.forEach((fn) => fn(ev, session));
    window.__fake = db;
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: (fn) => { subs.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
        signUp: async ({ email, password }) => {
          if (db.users[email]) return { data: { user: { email, identities: [] }, session: null }, error: null };
          db.users[email] = { password, confirmed: false };
          return { data: { user: { email, identities: [{}] }, session: null }, error: null };
        },
        signInWithPassword: async ({ email, password }) => {
          const u = db.users[email];
          if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
          if (!u.confirmed) return { data: {}, error: { message: 'Email not confirmed' } };
          session = { user: { id: 'u_' + email, email } }; emit('SIGNED_IN'); return { data: { session }, error: null };
        },
        signOut: async () => { session = null; emit('SIGNED_OUT'); return { error: null }; },
        resetPasswordForEmail: async () => ({ data: {}, error: null }),
        updateUser: async () => ({ data: {}, error: null }),
        resend: async () => ({ data: {}, error: null }),
      },
      from: () => ({
        insert: async (row) => {
          if (db.sites.some((x) => x.domain === row.domain)) return { error: { code: '23505', message: 'duplicate' } };
          db.sites.push({ ...row, owner: session && session.user.id }); return { error: null };
        },
        select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: db.sites.find((x) => x.domain === v && x.owner === (session && session.user.id)) || null }) }),
          order: async () => ({ data: db.sites, error: null }) }),
      }),
    }) };
  };
  const actx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await actx.addInitScript(fakeSupabase);
  const a = await actx.newPage();
  const aErrors = [];
  a.on('pageerror', (e) => aErrors.push(e.message));
  await a.goto(base + '#dashboard');
  await a.waitForFunction(() => window.AICSAuth && AICSAuth.state() === 'ready');
  await a.waitForTimeout(100);
  check(await a.evaluate(() => location.hash) === '#signin' && await a.isVisible('#signinForm'), 'signed-out visitor to #dashboard is sent to sign in');
  check(await a.isVisible('#navSignIn') && !(await a.isVisible('#navUser')), 'nav shows Sign in when signed out');
  await a.evaluate(() => { location.hash = 'get-started'; });
  await a.waitForTimeout(100);
  check(await a.evaluate(() => location.hash) === '#signup', 'signed-out visitor to #get-started is sent to sign up');
  await a.fill('#suEmail', 'owner@example.com'); await a.fill('#suPassword', 'longpassword1'); await a.fill('#suPassword2', 'different1');
  await a.check('#suTerms'); await a.click('#signupForm button[type=submit]'); await a.waitForTimeout(100);
  check((await a.textContent('#suStatus')).includes('do not match'), 'sign up rejects mismatched passwords');
  await a.fill('#suPassword2', 'longpassword1'); await a.click('#signupForm button[type=submit]'); await a.waitForTimeout(150);
  check(await a.evaluate(() => location.hash) === '#check-email' && (await a.textContent('#ceEmail')) === 'owner@example.com', 'sign up asks the owner to confirm their email');
  await a.evaluate(() => AICSApp.go('signin'));
  await a.fill('#siEmail', 'owner@example.com'); await a.fill('#siPassword', 'longpassword1');
  await a.click('#signinForm button[type=submit]'); await a.waitForTimeout(150);
  check((await a.textContent('#siStatus')).includes('Confirm your email'), 'unconfirmed account cannot sign in yet');
  await a.evaluate(() => { window.__fake.users['owner@example.com'].confirmed = true; });
  await a.fill('#siPassword', 'wrong-password'); await a.click('#signinForm button[type=submit]'); await a.waitForTimeout(150);
  check((await a.textContent('#siStatus')).includes('incorrect'), 'wrong password is rejected');
  await a.fill('#siPassword', 'longpassword1'); await a.click('#signinForm button[type=submit]'); await a.waitForTimeout(250);
  check(await a.evaluate(() => location.hash) === '#get-started', 'sign in returns the owner to the page they asked for');
  check(await a.isVisible('#navUser') && (await a.textContent('#navUserEmail')) === 'owner@example.com', 'nav shows the signed-in email');
  check(await a.inputValue('#obEmail') === 'owner@example.com', 'onboarding pre-fills the account email');
  await a.fill('#obDomain', 'owner-site.com'); await a.fill('#obOwner', 'Owner LLC');
  await a.click('#onboardForm button[type=submit]'); await a.waitForTimeout(200);
  check(await a.evaluate(() => window.__fake.sites.some((x) => x.domain === 'owner-site.com')), 'registering a domain saves it to the account (sites table)');
  check((await a.textContent('#obSync')).includes('Saved to your account'), 'onboarding confirms the domain was saved');
  await a.evaluate(() => { window.__fake.sites.push({ domain: 'taken.com', owner: 'someone-else' }); AICSApp.go('get-started'); });
  await a.waitForTimeout(100);
  await a.click('[data-step-panel="2"] >> text=Edit details').catch(() => {});
  await a.fill('#obDomain', 'taken.com'); await a.click('#onboardForm button[type=submit]'); await a.waitForTimeout(200);
  check((await a.textContent('#obSync')).includes('another account'), 'a domain owned by another account is refused');
  await a.evaluate(() => AICSApp.go('dashboard')); await a.waitForTimeout(100);
  check(await a.isVisible('#dashTop'), 'signed-in owner can open the dashboard');
  await a.click('#navUser >> text=Sign out'); await a.waitForTimeout(150);
  check(await a.evaluate(() => location.hash) === '#home' && await a.isVisible('#navSignIn'), 'sign out returns home and shows Sign in');
  await a.evaluate(() => { location.hash = 'billing'; }); await a.waitForTimeout(100);
  check(await a.evaluate(() => location.hash) === '#signin', 'after sign out the dashboard is locked again');
  check(aErrors.length === 0, 'no page errors with accounts on' + (aErrors.length ? ': ' + aErrors.join(' | ') : ''));
  await actx.close();

  console.log('Phone layout');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => { window.AICS_AUTH_DISABLED = true; });
  const m = await phone.newPage();
  for (const r of ['home', 'dashboard', 'billing', 'get-started', 'registry', 'docs', 'legal', 'contact', 'signin', 'signup']) {
    await m.goto(base + '#' + r); await m.waitForTimeout(250);
    const w = await m.evaluate(() => document.documentElement.scrollWidth);
    check(w <= 390, `#${r} fits a 390px screen (${w}px)`);
  }
  check(await m.evaluate(() => { location.hash = 'dashboard'; return true; }) && await m.isVisible('.dash-tabs'), 'dashboard section tabs replace the sidebar on phones');

  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
