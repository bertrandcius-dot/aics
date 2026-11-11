# aics — ⊗ AI Copyright Shield

Detect AI crawlers, block or meter them per token, and show a copyright watermark at the bottom of every page.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page + live dashboard (KPIs, charts, events, revenue, bot rules, snippet generator, downloads) |
| `shield/shield.js` | Embeddable script: watermark badge, `noai`/TDM meta tags, JSON-LD licence, AI-crawler detection, token metering, event tracker |
| `robots.txt` | Blocks ~30 AI training/retrieval crawlers, allows search engines and the policy files |
| `ai.txt`, `llms.txt` | Licence terms written for AI systems (what is reserved, rate, how to authenticate) |
| `.well-known/tdmrep.json` | W3C TDMRep / EU DSM Art. 4 text-and-data-mining reservation |
| `sw.js` | Service worker that caches the shield and policy files (stale-while-revalidate) |
| `_headers` | `X-Robots-Tag: noai`, TDM and cache headers for Netlify / Cloudflare Pages |
| `edge/worker.js` | Cloudflare Worker: 402 for unlicensed AI crawlers, per-token billing for licensed ones, event ingest |

## Embed

```html
<script src="https://YOUR-HOST/shield/shield.js"
        data-id="AICS-2026-00847" data-owner="YourSite.com"
        data-mode="meter-and-bill" data-rate="0.001"
        data-licensed="ClaudeBot,Google-Extended"
        data-terms="/ai.txt" defer></script>
```

Upload `robots.txt`, `ai.txt`, `llms.txt` and `.well-known/tdmrep.json` to your site root. The dashboard's
**Shield Setup** panel generates the snippet (including a static footer fallback) for your own licence ID and rate.

Modes: `block` (all AI crawlers blocked), `meter-and-bill` (crawlers in `data-licensed` are billed, others blocked
and invoiced), `allow` (everything metered and billed).

## Event tracking and billing

Every page view and crawler hit becomes an event `{bot, vendor, status, pages, tokens, amount, ownerAmount, …}`.
Tokens are estimated as characters / 4; `amount = tokens × rate`, `ownerAmount = amount × share` (default 85%).
Events are stored in `localStorage`, broadcast to open dashboards via `BroadcastChannel`, and sent with
`sendBeacon` to `data-endpoint` if set (e.g. the edge worker's `POST /aics/events`).

JS API: `AICS.events()`, `AICS.stats()`, `AICS.toCSV()`, `AICS.simulate(bot)`, `AICS.on(fn)`, `AICS.snippet()`.

## Limits

robots.txt, ai.txt and meta tags are signals that compliant crawlers honour; they do not technically stop
crawlers that ignore them. `shield.js` only sees crawlers that execute JavaScript. Use `edge/worker.js` (or
equivalent server middleware) to enforce blocking and billing on raw HTML requests. Dashboard data in this
repo is local to the browser and includes simulated demo traffic (toggle with **Demo traffic**).
