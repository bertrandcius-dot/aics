'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../app/billing.js');
const L = require('../app/legal.js');

const cfg = { id: 'AICS-2026-00001', owner: 'Example Co', rate: 0.001, share: 0.85, licensed: ['claudebot'] };
const t = new Date(2026, 10, 10, 12).getTime(); // 10 Nov 2026, local time
const ev = (o) => Object.assign({ ts: t, pages: 1, tokens: 1000, amount: 1, ownerAmount: 0.85 }, o);
const events = [
  ev({ bot: 'GPTBot', vendor: 'OpenAI', status: 'blocked', amount: 2.5, tokens: 2500 }),
  ev({ bot: 'ChatGPT-User', vendor: 'OpenAI', status: 'blocked', amount: 1.5, tokens: 1500 }),
  ev({ bot: 'ClaudeBot', vendor: 'Anthropic', status: 'billed', amount: 3, tokens: 3000 }),
  ev({ bot: 'Unknown Crawler', vendor: 'Unidentified', status: 'pending', amount: 0 }),
  ev({ status: 'human', amount: 0 }),
  ev({ bot: 'CCBot', vendor: 'Common Crawl', status: 'blocked', amount: 9, ts: new Date(2026, 9, 3).getTime() })
];

test('periodOf uses local calendar month', () => {
  assert.equal(B.periodOf(t), '2026-11');
});

test('usageByVendor groups chargeable events by vendor and status', () => {
  const u = B.usageByVendor(events, '2026-11');
  assert.deepEqual(Object.keys(u).sort(), ['Anthropic', 'OpenAI']);
  assert.equal(u.OpenAI.blocked.events, 2);
  assert.equal(u.OpenAI.blocked.amount, 4);
  assert.deepEqual(u.OpenAI.bots, ['ChatGPT-User', 'GPTBot']);
  assert.equal(u.Anthropic.billed.amount, 3);
});

test('buildInvoices drafts one invoice per vendor and skips invoiced vendors', () => {
  const first = B.buildInvoices(events, '2026-11', [], cfg, t);
  assert.equal(first.length, 2);
  const openai = first.find((i) => i.vendor === 'OpenAI');
  assert.equal(openai.total, 4);
  assert.equal(openai.ownerShare, 3.4);
  assert.equal(openai.status, 'draft');
  assert.match(openai.id, /^INV-202611-\d{3}$/);
  assert.equal(B.buildInvoices(events, '2026-11', first, cfg, t).length, 0, 'no duplicates');
  assert.equal(B.buildInvoices(events, '2026-10', first, cfg, t)[0].vendor, 'Common Crawl');
});

test('invoice lifecycle and balance', () => {
  let [a, b] = B.buildInvoices(events, '2026-11', [], cfg, t);
  a = B.advance(a); assert.equal(a.status, 'sent');
  a = B.advance(a); assert.equal(a.status, 'paid');
  assert.throws(() => B.advance(a), /already paid/);
  assert.throws(() => B.voidInvoice(a), /cannot be voided/);
  b = B.voidInvoice(b);
  const bal = B.balance([a, b], []);
  assert.equal(bal.collected, a.total);
  assert.equal(bal.available, a.ownerShare);
  assert.equal(bal.draft, 0);
});

test('payouts draw down the available balance', () => {
  let [a] = B.buildInvoices(events, '2026-11', [], cfg, t);
  assert.throws(() => B.makePayout([a], [], 'Stripe'), /No collected earnings/);
  a = B.advance(B.advance(a));
  assert.throws(() => B.makePayout([a], [], ''), /payout method/);
  const p = B.makePayout([a], [], 'Stripe', t);
  assert.equal(p.amount, a.ownerShare);
  assert.equal(new Date(p.scheduledFor).getDate(), 1);
  assert.equal(B.balance([a], [p]).available, 0);
});

test('invoice text and CSV include totals', () => {
  const [a] = B.buildInvoices(events, '2026-11', [], cfg, t);
  assert.match(B.invoiceText(a), /TOTAL DUE\s+\$3\.00|TOTAL DUE\s+\$4\.00/);
  assert.match(B.invoicesCSV([a]), /^id,period,vendor/);
});

test('legal templates are filled from config and usage', () => {
  assert.match(L.tosAddendum(cfg), /AICS-2026-00001/);
  assert.match(L.tosAddendum(cfg), /0\.001 USD per token/);
  const u = B.usageByVendor(events, '2026-11').OpenAI;
  const n = L.unlicensedNotice(cfg, 'OpenAI', u);
  assert.match(n, /Unlicensed requests:\s+2/);
  assert.match(n, /\$4\.00/);
  assert.match(n, /Not legal advice/);
});
