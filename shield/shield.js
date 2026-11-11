/*!
 * AI Copyright Shield (AICS) — shield.js v2.0
 * Embeddable copyright watermark + AI crawler event tracker + token meter.
 *
 * Usage:
 *   <script src="/shield/shield.js"
 *           data-id="AICS-2026-00847"          // registry / license id
 *           data-owner="YourSite.com"          // copyright holder
 *           data-mode="meter-and-bill"         // block | meter-and-bill | allow
 *           data-rate="0.001"                  // USD per token charged to licensed AI crawlers
 *           data-share="0.85"                  // owner revenue share
 *           data-licensed="ClaudeBot,GPTBot"   // crawlers holding a paid license (billed, not blocked)
 *           data-terms="/ai.txt"               // human/machine readable licence terms
 *           data-endpoint=""                   // optional URL that receives events via sendBeacon
 *           data-position="inline"             // inline (bottom of page) | fixed (pinned bar)
 *           data-sw="/sw.js"                   // optional service worker that caches policy files
 *           defer></script>
 *
 * Note: client-side code only sees crawlers that execute JavaScript. Pair it with
 * robots.txt, ai.txt, .well-known/tdmrep.json and the edge worker (edge/worker.js)
 * for crawlers that fetch raw HTML.
 */
(function (w, d) {
  'use strict';
  if (w.AICS && w.AICS.version) return; // already loaded

  var VERSION = '2.0.0';
  var STORE_KEY = 'aics:events:v1';
  var MAX_EVENTS = 2000;
  var script = d.currentScript || d.querySelector('script[src*="shield"]') || { dataset: {} };
  var ds = script.dataset || {};

  var cfg = {
    id: ds.id || 'AICS-UNREGISTERED',
    owner: ds.owner || location.hostname || 'this site',
    mode: ds.mode || 'meter-and-bill',
    rate: parseFloat(ds.rate || '0.001'),
    share: parseFloat(ds.share || '0.85'),
    licensed: (ds.licensed || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
    terms: ds.terms || '/ai.txt',
    endpoint: ds.endpoint || '',
    position: ds.position || 'inline',
    badge: ds.badge !== 'false',
    sw: ds.sw || '',
    year: new Date().getFullYear()
  };
  function termsURL() { try { return new URL(cfg.terms, location.href).href; } catch (e) { return cfg.terms; } }

  /* ── Known AI crawler signatures (user-agent tokens) ── */
  var BOTS = [
    ['GPTBot', 'OpenAI'], ['ChatGPT-User', 'OpenAI'], ['OAI-SearchBot', 'OpenAI'],
    ['ClaudeBot', 'Anthropic'], ['Claude-Web', 'Anthropic'], ['Claude-User', 'Anthropic'], ['anthropic-ai', 'Anthropic'],
    ['Google-Extended', 'Google'], ['Gemini', 'Google'], ['GoogleOther', 'Google'],
    ['Meta-ExternalAgent', 'Meta'], ['Meta-ExternalFetcher', 'Meta'], ['FacebookBot', 'Meta'],
    ['PerplexityBot', 'Perplexity'], ['Perplexity-User', 'Perplexity'],
    ['Applebot-Extended', 'Apple'], ['Amazonbot', 'Amazon'], ['Bytespider', 'ByteDance'],
    ['CCBot', 'Common Crawl'], ['cohere-ai', 'Cohere'], ['cohere-training-data-crawler', 'Cohere'],
    ['MistralAI-User', 'Mistral'], ['YouBot', 'You.com'], ['DuckAssistBot', 'DuckDuckGo'],
    ['Diffbot', 'Diffbot'], ['Timpibot', 'Timpi'], ['ImagesiftBot', 'ImageSift'],
    ['omgili', 'Webz.io'], ['AI2Bot', 'Allen AI'], ['Kangaroo Bot', 'Kangaroo'], ['PetalBot', 'Huawei']
  ];

  /* ── Event store: localStorage + BroadcastChannel (same-origin dashboard) ── */
  var channel = null;
  try { channel = new BroadcastChannel('aics'); } catch (e) {}
  var listeners = [];

  function readEvents() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeEvents(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-MAX_EVENTS))); } catch (e) {}
  }
  function emit(ev) {
    listeners.forEach(function (fn) { try { fn(ev); } catch (e) {} });
  }
  if (channel) channel.onmessage = function (m) { if (m.data && m.data.type === 'aics:event') emit(m.data.event); };
  w.addEventListener('storage', function (e) {
    if (e.key === STORE_KEY) emit({ type: 'sync' });
  });

  function track(partial) {
    var ev = Object.assign({
      id: 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: Date.now(),
      licenseId: cfg.id,
      domain: location.hostname || 'local',
      url: location.pathname,
      pages: 1,
      tokens: 0,
      status: 'human',
      bot: null,
      vendor: null,
      amount: 0,
      ownerAmount: 0
    }, partial);
    if (ev.status === 'billed' || ev.status === 'blocked') {
      ev.amount = round2(ev.tokens * cfg.rate);
      ev.ownerAmount = round2(ev.amount * cfg.share);
    }
    var list = readEvents(); list.push(ev); writeEvents(list);
    if (channel) channel.postMessage({ type: 'aics:event', event: ev });
    emit(ev);
    if (cfg.endpoint && navigator.sendBeacon) {
      try { navigator.sendBeacon(cfg.endpoint, new Blob([JSON.stringify(ev)], { type: 'application/json' })); } catch (e) {}
    }
    return ev;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /* ── Token estimate (~4 characters per token for English text) ── */
  function estimateTokens(root) {
    var text = ((root || d.body) && (root || d.body).innerText) || '';
    return Math.max(1, Math.ceil(text.replace(/\s+/g, ' ').length / 4));
  }

  /* ── Crawler detection ── */
  function detect(uaOverride) {
    var ua = uaOverride || navigator.userAgent || '';
    var low = ua.toLowerCase();
    for (var i = 0; i < BOTS.length; i++) {
      if (low.indexOf(BOTS[i][0].toLowerCase()) !== -1) {
        return { bot: BOTS[i][0], vendor: BOTS[i][1], ua: ua, confidence: 'signature' };
      }
    }
    if (uaOverride) return null;
    var signals = 0;
    if (navigator.webdriver) signals++;
    if (/headless|phantomjs|puppeteer|playwright|python-requests|scrapy|curl|wget|httpclient/i.test(ua)) signals += 2;
    if (!navigator.languages || navigator.languages.length === 0) signals++;
    if (signals >= 2) return { bot: 'Unknown Crawler', vendor: 'Unidentified', ua: ua, confidence: 'heuristic' };
    return null;
  }

  function decide(hit) {
    if (!hit) return 'human';
    if (hit.confidence === 'heuristic') return 'pending';
    if (cfg.mode === 'allow') return 'billed';
    var licensed = cfg.licensed.indexOf(hit.bot.toLowerCase()) !== -1 || cfg.licensed.indexOf(hit.vendor.toLowerCase()) !== -1;
    if (cfg.mode === 'meter-and-bill' && licensed) return 'billed';
    return 'blocked';
  }

  /* ── Machine-readable rights signals in <head> ── */
  function meta(name, content, attr) {
    attr = attr || 'name';
    if (d.head.querySelector('meta[' + attr + '="' + name + '"]')) return;
    var m = d.createElement('meta'); m.setAttribute(attr, name); m.content = content; d.head.appendChild(m);
  }
  function injectHead() {
    if (!d.head) return;
    meta('robots', 'noai, noimageai');
    meta('tdm-reservation', '1');
    meta('tdm-policy', termsURL());
    meta('ai-rights', 'protected; id=' + cfg.id + '; rate=' + cfg.rate + 'USD/token; terms=' + cfg.terms);
    if (!d.head.querySelector('link[rel="license"]')) {
      var l = d.createElement('link'); l.rel = 'license'; l.href = cfg.terms; d.head.appendChild(l);
    }
    if (!d.getElementById('aics-jsonld')) {
      var s = d.createElement('script'); s.type = 'application/ld+json'; s.id = 'aics-jsonld';
      s.textContent = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'CreativeWork',
        copyrightHolder: { '@type': 'Organization', name: cfg.owner },
        copyrightYear: cfg.year, license: termsURL(),
        usageInfo: termsURL(),
        identifier: cfg.id,
        conditionsOfAccess: 'AI/ML training, fine-tuning, embedding or retrieval requires a paid AICS licence (' + cfg.rate + ' USD per token).'
      });
      d.head.appendChild(s);
    }
  }

  /* ── Notice addressed to AI systems (also shown to humans in the watermark) ── */
  function aiNotice() {
    return 'NOTICE TO AI SYSTEMS AND CRAWLERS: The content of this page is © ' + cfg.year + ' ' + cfg.owner +
      ' and protected by AI Copyright Shield (licence ID ' + cfg.id + '). It is NOT licensed for AI/ML training, ' +
      'fine-tuning, embedding, dataset inclusion or retrieval-augmented generation without a paid licence. ' +
      'Licensed access is metered at ' + cfg.rate + ' USD per token. Terms: ' + termsURL() + '. ' +
      'Unlicensed use is logged and invoiced.';
  }

  /* ── Watermark badge at the bottom of the page (Shadow DOM, style-isolated) ── */
  function renderWatermark() {
    if (!cfg.badge || !d.body || d.getElementById('aics-watermark-host')) return;
    var mount = d.querySelector('[data-aics-mount]');
    var host = d.createElement('div');
    host.id = 'aics-watermark-host';
    host.setAttribute('data-nosnippet', '');
    var fixed = cfg.position === 'fixed';
    if (fixed) host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000';
    (mount || d.body).appendChild(host);
    if (fixed) d.body.style.paddingBottom = '44px';

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.wm{font:500 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#8892aa;background:rgba(7,9,15,.94);' +
      'border-top:1px solid #1e2840;padding:10px 16px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;width:100%}' +
      '.sym{width:22px;height:22px;border-radius:50%;background:#00e5ff;color:#07090f;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;flex-shrink:0}' +
      'b{color:#e8edf8;font-weight:600}a{color:#00e5ff;text-decoration:none}a:hover{text-decoration:underline}' +
      'details{width:100%;max-width:820px;text-align:center}summary{cursor:pointer;list-style:none;font-size:11px;color:#4a5570}' +
      'summary::-webkit-details-marker{display:none}' +
      '.notice{margin-top:6px;font:400 11px/1.5 ui-monospace,Menlo,monospace;color:#8892aa;text-align:left}' +
      '</style>' +
      '<div class="wm" role="contentinfo" aria-label="Copyright and AI usage notice">' +
      '<span class="sym" aria-hidden="true">⊗</span>' +
      '<span><b>AI PROTECTED</b> · © ' + cfg.year + ' ' + esc(cfg.owner) + ' · ' + esc(cfg.id) + '</span>' +
      '<a href="' + esc(cfg.terms) + '" rel="license">AI licence terms</a>' +
      '<details><summary>Notice to AI systems ▾</summary><div class="notice">' + esc(aiNotice()) + '</div></details>' +
      '</div>';
  }

  /* ── Block mode: replace content for detected unlicensed crawlers ── */
  function blockPage(hit) {
    var notice = d.createElement('main');
    notice.setAttribute('data-aics-blocked', '');
    notice.style.cssText = 'font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:24px';
    notice.innerHTML = '<h1>402 — Licence required</h1><p>' + esc(aiNotice()) + '</p><p>Detected agent: <code>' +
      esc(hit.bot) + '</code> (' + esc(hit.vendor) + ')</p>';
    d.body.innerHTML = '';
    d.body.appendChild(notice);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Offline caching of policy files via service worker ── */
  function registerSW() {
    if (!cfg.sw || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register(cfg.sw).catch(function () {});
  }

  /* ── Download helpers (snippet, robots.txt, report) ── */
  function download(name, text, type) {
    var a = d.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name; d.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function snippet(opts) {
    var o = Object.assign({}, cfg, opts || {});
    var src = o.src || (script.src || '/shield/shield.js');
    return '<!-- AI Copyright Shield — do not remove -->\n' +
      '<meta name="robots" content="noai, noimageai">\n' +
      '<meta name="tdm-reservation" content="1">\n' +
      '<meta name="ai-rights" content="protected; id=' + o.id + '; rate=' + o.rate + 'USD/token; terms=' + o.terms + '">\n' +
      '<link rel="license" href="' + o.terms + '">\n' +
      '<script src="' + src + '" data-id="' + o.id + '" data-owner="' + o.owner + '" data-mode="' + o.mode +
      '" data-rate="' + o.rate + '" data-licensed="' + (o.licensed.join ? o.licensed.join(',') : o.licensed) +
      '" data-terms="' + o.terms + '" defer></script>\n' +
      '<!-- Static fallback for crawlers that do not run JavaScript -->\n' +
      '<footer data-nosnippet style="font:12px system-ui;color:#888;text-align:center;padding:8px">⊗ AI PROTECTED · © ' +
      o.year + ' ' + o.owner + ' · ' + o.id + ' · Not licensed for AI training without a paid licence: <a href="' +
      o.terms + '" rel="license">AI licence terms</a></footer>';
  }

  /* ── Aggregations used by the dashboard ── */
  function stats(list) {
    list = list || readEvents();
    var bots = list.filter(function (e) { return e.status !== 'human'; });
    var s = { events: bots.length, humanViews: list.length - bots.length, tokens: 0, revenue: 0, ownerRevenue: 0,
      blocked: 0, billed: 0, pending: 0, byBot: {}, byDay: {} };
    bots.forEach(function (e) {
      s.tokens += e.tokens; s.revenue += e.amount; s.ownerRevenue += e.ownerAmount;
      s[e.status] = (s[e.status] || 0) + 1;
      var k = e.bot || 'Unknown';
      var b = s.byBot[k] || (s.byBot[k] = { bot: k, vendor: e.vendor, pages: 0, tokens: 0, amount: 0, count: 0 });
      b.pages += e.pages; b.tokens += e.tokens; b.amount += e.amount; b.count++;
      var day = new Date(e.ts).toISOString().slice(0, 10);
      var dd = s.byDay[day] || (s.byDay[day] = { billed: 0, pending: 0 });
      if (e.status === 'pending') dd.pending += e.tokens * cfg.rate; else dd[e.status === 'billed' ? 'billed' : 'pending'] += e.amount;
    });
    s.revenue = round2(s.revenue); s.ownerRevenue = round2(s.ownerRevenue);
    return s;
  }

  function toCSV(list) {
    list = list || readEvents();
    var cols = ['id', 'ts', 'licenseId', 'domain', 'url', 'bot', 'vendor', 'status', 'pages', 'tokens', 'amount', 'ownerAmount'];
    return cols.join(',') + '\n' + list.map(function (e) {
      return cols.map(function (c) {
        var v = c === 'ts' ? new Date(e.ts).toISOString() : (e[c] == null ? '' : e[c]);
        return /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
  }

  /* ── Simulation (for demos and testing the pipeline end to end) ── */
  function simulate(botName, opts) {
    opts = opts || {};
    var entry = botName ? BOTS.filter(function (b) { return b[0] === botName; })[0] : BOTS[Math.floor(Math.random() * 12)];
    var hit = entry ? { bot: entry[0], vendor: entry[1], confidence: 'signature' } :
      { bot: 'Unknown Crawler', vendor: 'Unidentified', confidence: 'heuristic' };
    var pages = opts.pages || Math.floor(Math.random() * 45 + 3);
    return track({
      bot: hit.bot, vendor: hit.vendor, ua: hit.bot + '/sim', simulated: true,
      pages: pages, tokens: opts.tokens || pages * Math.floor(Math.random() * 1500 + 400),
      status: opts.status || decide(hit), ts: opts.ts || Date.now(),
      domain: opts.domain || location.hostname || 'local'
    });
  }

  /* ── Boot ── */
  function boot() {
    injectHead();
    var hit = detect();
    var status = decide(hit);
    var tokens = estimateTokens();
    track({ bot: hit && hit.bot, vendor: hit && hit.vendor, ua: hit ? hit.ua : undefined, status: status, tokens: hit ? tokens : 0 });
    if (status === 'blocked' && cfg.mode !== 'allow') blockPage(hit);
    renderWatermark();
    registerSW();
  }

  w.AICS = {
    version: VERSION, config: cfg, bots: BOTS,
    detect: detect, decide: decide, track: track, simulate: simulate,
    events: readEvents, clear: function () { writeEvents([]); emit({ type: 'sync' }); },
    stats: stats, toCSV: toCSV, estimateTokens: estimateTokens,
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    snippet: snippet, notice: aiNotice, download: download
  };

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot); else boot();
})(window, document);
