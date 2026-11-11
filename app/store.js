/* ⊗ AICS — app state store
 * Persists account, licence keys, invoices, payouts and requests in localStorage
 * (falls back to memory when storage is blocked) and notifies subscribers.
 */
(function (w) {
  'use strict';
  var PREFIX = 'aics:app:';
  var memory = {};
  var subs = [];

  function get(key, fallback) {
    var raw;
    try { raw = localStorage.getItem(PREFIX + key); } catch (e) { raw = memory[key]; }
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function set(key, value) {
    var raw = JSON.stringify(value);
    try { localStorage.setItem(PREFIX + key, raw); } catch (e) { memory[key] = raw; }
    subs.forEach(function (fn) { try { fn(key, value); } catch (e) {} });
    return value;
  }

  function update(key, fallback, fn) { return set(key, fn(get(key, fallback))); }

  function clearAll() {
    try {
      Object.keys(localStorage).filter(function (k) { return k.indexOf('aics:') === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
    memory = {};
    subs.forEach(function (fn) { try { fn('*', null); } catch (e) {} });
  }

  function exportAll() {
    var out = {};
    try {
      Object.keys(localStorage).filter(function (k) { return k.indexOf('aics:') === 0; })
        .forEach(function (k) { try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { out[k] = localStorage.getItem(k); } });
    } catch (e) {
      Object.keys(memory).forEach(function (k) { out[PREFIX + k] = JSON.parse(memory[k]); });
    }
    return out;
  }

  function on(fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; }

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    if (w.crypto && w.crypto.getRandomValues) w.crypto.getRandomValues(a);
    else for (var i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  w.AICSStore = { get: get, set: set, update: update, on: on, clearAll: clearAll, exportAll: exportAll, randomHex: randomHex };
})(window);
