/* ⊗ AICS — billing core (pure functions, no DOM)
 * Turns metered crawler events into per-vendor monthly invoices and
 * computes the owner's payout balance. Loads in the browser as
 * window.AICSBilling and in Node via require().
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AICSBilling = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function r2(n) { return Math.round(n * 100) / 100; }

  /** Local-time billing period key, e.g. "2026-11". */
  function periodOf(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function periodLabel(period) {
    var p = period.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  var LINE_TYPES = {
    billed: 'Licensed access (metered)',
    blocked: 'Unlicensed access attempt (blocked)'
  };

  /** Usage per vendor for a period: { vendor: { billed:{events,pages,tokens,amount}, blocked:{...}, total } } */
  function usageByVendor(events, period) {
    var out = {};
    events.forEach(function (e) {
      if (!LINE_TYPES[e.status] || !e.vendor || periodOf(e.ts) !== period) return;
      var v = out[e.vendor] || (out[e.vendor] = { vendor: e.vendor, total: 0, bots: {} });
      var l = v[e.status] || (v[e.status] = { events: 0, pages: 0, tokens: 0, amount: 0 });
      l.events++; l.pages += e.pages || 0; l.tokens += e.tokens || 0; l.amount += e.amount || 0;
      v.total += e.amount || 0;
      if (e.bot) v.bots[e.bot] = true;
    });
    Object.keys(out).forEach(function (k) {
      var v = out[k];
      v.total = r2(v.total);
      v.bots = Object.keys(v.bots).sort();
      ['billed', 'blocked'].forEach(function (s) { if (v[s]) v[s].amount = r2(v[s].amount); });
    });
    return out;
  }

  /**
   * Draft one invoice per vendor that has chargeable usage in `period`
   * and has not been invoiced for that period yet.
   */
  function buildInvoices(events, period, existing, cfg, now) {
    existing = existing || [];
    var already = {};
    existing.forEach(function (i) { if (i.period === period) already[i.vendor] = true; });
    var seq = existing.filter(function (i) { return i.period === period; }).length;
    var usage = usageByVendor(events, period);
    return Object.keys(usage).sort().filter(function (v) {
      return !already[v] && usage[v].total > 0;
    }).map(function (vendor) {
      var u = usage[vendor];
      var lines = ['billed', 'blocked'].filter(function (s) { return u[s] && u[s].amount > 0; }).map(function (s) {
        return { type: s, label: LINE_TYPES[s], events: u[s].events, pages: u[s].pages, tokens: u[s].tokens, amount: u[s].amount };
      });
      seq++;
      return {
        id: 'INV-' + period.replace('-', '') + '-' + String(seq).padStart(3, '0'),
        period: period, vendor: vendor, bots: u.bots, lines: lines,
        total: u.total, ownerShare: r2(u.total * cfg.share), share: cfg.share,
        rate: cfg.rate, licenseId: cfg.id, owner: cfg.owner,
        status: 'draft', createdAt: now || Date.now(), history: [{ status: 'draft', at: now || Date.now() }]
      };
    });
  }

  var FLOW = { draft: 'sent', sent: 'paid' };

  /** Move an invoice to its next status (draft → sent → paid). Returns a new object. */
  function advance(inv, now) {
    var next = FLOW[inv.status];
    if (!next) throw new Error('Invoice ' + inv.id + ' is already ' + inv.status);
    return Object.assign({}, inv, { status: next, history: (inv.history || []).concat({ status: next, at: now || Date.now() }) });
  }

  function voidInvoice(inv, now) {
    if (inv.status === 'paid') throw new Error('Paid invoices cannot be voided');
    return Object.assign({}, inv, { status: 'void', history: (inv.history || []).concat({ status: 'void', at: now || Date.now() }) });
  }

  /** Owner balance from invoices and payouts. */
  function balance(invoices, payouts) {
    var b = { draft: 0, outstanding: 0, collected: 0, earned: 0, paidOut: 0, available: 0 };
    (invoices || []).forEach(function (i) {
      if (i.status === 'draft') b.draft += i.total;
      if (i.status === 'sent') b.outstanding += i.total;
      if (i.status === 'paid') { b.collected += i.total; b.earned += i.ownerShare; }
    });
    (payouts || []).forEach(function (p) { if (p.status !== 'failed') b.paidOut += p.amount; });
    Object.keys(b).forEach(function (k) { b[k] = r2(b[k]); });
    b.available = r2(Math.max(0, b.earned - b.paidOut));
    return b;
  }

  /** First day of the next month, the scheduled payout date. */
  function nextPayoutDate(now) {
    var d = new Date(now || Date.now());
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }

  function makePayout(invoices, payouts, method, now) {
    var b = balance(invoices, payouts);
    if (b.available <= 0) throw new Error('No collected earnings are available to pay out yet.');
    if (!method) throw new Error('Add a payout method in Account first.');
    return {
      id: 'PO-' + new Date(now || Date.now()).toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      amount: b.available, method: method, status: 'scheduled',
      requestedAt: now || Date.now(), scheduledFor: nextPayoutDate(now)
    };
  }

  function usd(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function invoiceText(inv) {
    var pad = function (s, n) { s = String(s); return s.length >= n ? s : s + Array(n - s.length + 1).join(' '); };
    var lines = [
      'INVOICE ' + inv.id,
      '='.repeat(64),
      'From:     ' + inv.owner + ' (licence ' + inv.licenseId + ')',
      '          billed through AI Copyright Shield',
      'To:       ' + inv.vendor + ' — crawler(s): ' + (inv.bots || []).join(', '),
      'Period:   ' + periodLabel(inv.period),
      'Issued:   ' + new Date(inv.createdAt).toISOString().slice(0, 10),
      'Status:   ' + inv.status.toUpperCase(),
      'Rate:     ' + inv.rate + ' USD per token (tokens ≈ characters / 4)',
      '',
      pad('Item', 38) + pad('Events', 8) + pad('Tokens', 10) + 'Amount',
      '-'.repeat(64)
    ];
    inv.lines.forEach(function (l) {
      lines.push(pad(l.label, 38) + pad(l.events, 8) + pad(l.tokens.toLocaleString('en-US'), 10) + usd(l.amount));
    });
    lines.push('-'.repeat(64));
    lines.push(pad('TOTAL DUE', 56) + usd(inv.total));
    lines.push('');
    lines.push('Terms: licence fees are due within 30 days. Unlicensed access is charged at the');
    lines.push('published rate under the site\'s AI usage policy (ai.txt) and TDM reservation.');
    lines.push('Pay or obtain a licence key: Authorization: AICS-License <key>.');
    return lines.join('\n');
  }

  function invoicesCSV(invoices) {
    var cols = ['id', 'period', 'vendor', 'status', 'total', 'ownerShare', 'createdAt'];
    return cols.join(',') + '\n' + invoices.map(function (i) {
      return cols.map(function (c) { return c === 'createdAt' ? new Date(i[c]).toISOString() : '"' + String(i[c]).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
  }

  return {
    periodOf: periodOf, periodLabel: periodLabel, usageByVendor: usageByVendor,
    buildInvoices: buildInvoices, advance: advance, voidInvoice: voidInvoice,
    balance: balance, nextPayoutDate: nextPayoutDate, makePayout: makePayout,
    invoiceText: invoiceText, invoicesCSV: invoicesCSV, usd: usd
  };
});
