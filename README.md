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
| `app/app.js` | Hash router and workflow features: onboarding, registry, install check, API keys, invoices & payouts, legal docs, account, contact |
| `app/billing.js` | Pure invoicing and payout logic (browser + Node) |
| `app/legal.js` | ToS AI addendum and unlicensed-use notice templates |
| `app/store.js` | Persisted workspace state (account, keys, invoices, payouts, requests) |
| `app/app.css` | Styles for routed pages and dashboard panels |
| `tests/` | Unit tests (`npm test`) and end-to-end workflow check (`npm run e2e`) |

## Pages and routes

Every button and link routes to a page or section, and each has a shareable hash link.

| Area | Routes |
| --- | --- |
| Landing | `#home` `#how` `#compare` `#pricing` `#install` |
| Public pages | `#get-started` `#registry` `#docs` `#legal` `#contact` |
| Dashboard | `#dashboard` `#events` `#analytics` `#revenue` `#billing` `#rules` `#badge` `#verify` `#api-keys` `#legal-docs` `#account` |

## Workflow

1. **Get started**: register a domain, receive a licence ID, pick plan, rate, mode and licensed crawlers.
2. **Install**: copy the generated snippet and policy files.
3. **Verify**: the install check tests page source and robots.txt (paste, URL, or this app).
4. **License**: issue a key per paying crawler in API Keys; export the edge worker secret.
5. **Track**: crawler hits appear in Live Events, Analytics and Revenue.
6. **Bill**: generate monthly invoices per AI vendor, send them, mark them paid.
7. **Get paid**: request a payout of your share to the method saved in Account.
8. **Enforce**: generate a ToS AI addendum or an unlicensed-use notice from your logs.

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

## Review build

```bash
python3 tools/build_review.py dist/review
```

Produces a bundle of the app for sandboxed preview hosts (for example a claude.ai Artifact): the document
skeleton is stripped, the service worker is not registered, and the shield and policy files are copied alongside.
