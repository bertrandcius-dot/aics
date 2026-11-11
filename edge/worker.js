/* ⊗ AI Copyright Shield — edge enforcement + token billing (Cloudflare Workers, module syntax)
 *
 * Crawlers that never run JavaScript are handled here, in front of the origin:
 *   - serves cached robots.txt / ai.txt / llms.txt / tdmrep.json
 *   - identifies AI crawlers by user-agent
 *   - unlicensed AI crawler  → 402 Payment Required + licence notice (logged as "blocked", invoiced)
 *   - licensed AI crawler    → origin response, metered per token (logged as "billed")
 *   - everyone else          → origin response with noai / TDM headers
 *   - POST /aics/events      → ingest events sent by shield.js (sendBeacon)
 *   - GET  /aics/events      → event log for the dashboard (requires AICS_ADMIN_TOKEN)
 *
 * Bindings (wrangler.toml):
 *   [vars]  AICS_ID, AICS_OWNER, AICS_RATE (USD/token), AICS_SHARE
 *   secrets AICS_LICENSE_KEYS (comma separated "key:BotName"), AICS_ADMIN_TOKEN
 *   [[kv_namespaces]] binding = "AICS_EVENTS"   (optional; events are only logged to console without it)
 */
const AI_BOTS = [
  ['GPTBot', 'OpenAI'], ['ChatGPT-User', 'OpenAI'], ['OAI-SearchBot', 'OpenAI'],
  ['ClaudeBot', 'Anthropic'], ['Claude-Web', 'Anthropic'], ['Claude-User', 'Anthropic'], ['anthropic-ai', 'Anthropic'],
  ['Google-Extended', 'Google'], ['GoogleOther', 'Google'],
  ['Meta-ExternalAgent', 'Meta'], ['Meta-ExternalFetcher', 'Meta'], ['FacebookBot', 'Meta'],
  ['PerplexityBot', 'Perplexity'], ['Perplexity-User', 'Perplexity'],
  ['Applebot-Extended', 'Apple'], ['Amazonbot', 'Amazon'], ['Bytespider', 'ByteDance'],
  ['CCBot', 'Common Crawl'], ['cohere-ai', 'Cohere'], ['cohere-training-data-crawler', 'Cohere'],
  ['MistralAI-User', 'Mistral'], ['YouBot', 'You.com'], ['DuckAssistBot', 'DuckDuckGo'],
  ['Diffbot', 'Diffbot'], ['Timpibot', 'Timpi'], ['ImagesiftBot', 'ImageSift'],
  ['omgili', 'Webz.io'], ['AI2Bot', 'Allen AI'], ['Kangaroo Bot', 'Kangaroo'], ['PetalBot', 'Huawei'],
];
const POLICY_FILES = ['/robots.txt', '/ai.txt', '/llms.txt', '/.well-known/tdmrep.json'];
const RIGHTS_HEADERS = {
  'X-Robots-Tag': 'noai, noimageai',
  'tdm-reservation': '1',
  'tdm-policy': '/ai.txt',
  Link: '</ai.txt>; rel="license"',
};

export function detectBot(ua = '') {
  const low = ua.toLowerCase();
  const hit = AI_BOTS.find(([token]) => low.includes(token.toLowerCase()));
  return hit ? { bot: hit[0], vendor: hit[1] } : null;
}

export function estimateTokens(text) {
  const plain = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return Math.max(1, Math.ceil(plain.length / 4));
}

function licenseFor(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^AICS-License\s+(\S+)$/i);
  if (!m) return null;
  const keys = (env.AICS_LICENSE_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const entry = keys.find((k) => k.split(':')[0] === m[1]);
  return entry ? { key: m[1], holder: entry.split(':')[1] || 'licensee' } : null;
}

async function logEvent(env, ctx, ev) {
  const event = { id: 'ev_' + crypto.randomUUID(), ts: Date.now(), ...ev };
  console.log('aics_event', JSON.stringify(event));
  if (env.AICS_EVENTS) {
    ctx.waitUntil(env.AICS_EVENTS.put(`ev:${event.ts}:${event.id}`, JSON.stringify(event), { expirationTtl: 60 * 60 * 24 * 400 }));
  }
  return event;
}

function cfg(env) {
  return {
    id: env.AICS_ID || 'AICS-UNREGISTERED',
    owner: env.AICS_OWNER || 'the copyright holder',
    rate: parseFloat(env.AICS_RATE || '0.001'),
    share: parseFloat(env.AICS_SHARE || '0.85'),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = cfg(env);

    // Event ingest from shield.js and dashboard read-out
    if (url.pathname === '/aics/events') {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return new Response('bad event', { status: 400 });
        await logEvent(env, ctx, { ...body, source: 'shield.js', domain: url.hostname });
        return new Response(null, { status: 204 });
      }
      if (request.headers.get('Authorization') !== `Bearer ${env.AICS_ADMIN_TOKEN}` || !env.AICS_ADMIN_TOKEN) {
        return new Response('unauthorized', { status: 401 });
      }
      if (!env.AICS_EVENTS) return Response.json([]);
      const list = await env.AICS_EVENTS.list({ prefix: 'ev:', limit: 1000 });
      const events = await Promise.all(list.keys.map((k) => env.AICS_EVENTS.get(k.name, 'json')));
      return Response.json(events.filter(Boolean));
    }

    // Policy files: always reachable, edge cached
    if (POLICY_FILES.includes(url.pathname)) {
      const cache = caches.default;
      let res = await cache.match(request);
      if (!res) {
        res = new Response((await fetch(request)).body, {
          headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
            'Content-Type': url.pathname.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8' },
        });
        ctx.waitUntil(cache.put(request, res.clone()));
      }
      return res;
    }

    const hit = detectBot(request.headers.get('User-Agent') || '');

    // Unlicensed AI crawler: refuse with 402 and the licence terms
    const license = hit ? licenseFor(request, env) : null;
    if (hit && !license) {
      await logEvent(env, ctx, { ...hit, status: 'blocked', domain: url.hostname, url: url.pathname,
        pages: 1, tokens: 0, amount: 0, ownerAmount: 0, licenseId: c.id });
      return Response.json({
        error: 'licence_required',
        notice: `Content © ${c.owner} is protected by AI Copyright Shield (${c.id}). AI training, embedding and retrieval require a paid licence.`,
        rate_usd_per_token: c.rate,
        terms: `${url.origin}/ai.txt`,
        authenticate_with: 'Authorization: AICS-License <key>',
      }, { status: 402, headers: { ...RIGHTS_HEADERS, 'Cache-Control': 'no-store' } });
    }

    // Origin fetch (humans, search engines, licensed AI crawlers)
    const originRes = await fetch(request);
    const headers = new Headers(originRes.headers);
    Object.entries(RIGHTS_HEADERS).forEach(([k, v]) => headers.set(k, v));

    if (hit && license) {
      const body = await originRes.text();
      const tokens = (originRes.headers.get('Content-Type') || '').includes('text') ? estimateTokens(body) : Math.ceil(body.length / 4);
      const amount = round2(tokens * c.rate);
      await logEvent(env, ctx, { ...hit, status: 'billed', domain: url.hostname, url: url.pathname, pages: 1,
        tokens, amount, ownerAmount: round2(amount * c.share), licenseId: c.id, licensee: license.holder });
      headers.set('AICS-Tokens-Metered', String(tokens));
      headers.set('AICS-Charge-USD', amount.toFixed(2));
      headers.set('Cache-Control', 'private, no-store');
      return new Response(body, { status: originRes.status, headers });
    }

    return new Response(originRes.body, { status: originRes.status, headers });
  },
};
