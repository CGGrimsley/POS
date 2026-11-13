'use strict';

// Local record of what this laptop took off (or put back on) the website
// stock: one JSON line per action, one file per month. Used for the
// "Today" list and for undo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class SalesLog {
  constructor(dir) {
    this.dir = dir;
  }

  _file(date = new Date()) {
    return path.join(this.dir, `sales-${localDate(date).slice(0, 7)}.jsonl`);
  }

  _write(rec) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this._file(), JSON.stringify(rec) + '\n');
    return rec;
  }

  // mode: 'sold' | 'received' | 'set'
  addSale(register, lines, mode = 'sold') {
    return this._write({ type: 'sale', mode, id: crypto.randomUUID(), at: new Date().toISOString(), day: localDate(), register, lines });
  }

  addNewProduct(register, item) {
    return this._write({
      type: 'new', id: crypto.randomUUID(), at: new Date().toISOString(), day: localDate(), register,
      lines: [{ key: item.key, name: item.name, sku: item.sku, qty: item.stockQty, before: null, after: item.stockQty }],
    });
  }

  addUndo(ref, lines) {
    return this._write({ type: 'undo', ref, at: new Date().toISOString(), day: localDate(), lines });
  }

  _records() {
    const file = this._file();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  get(id) {
    const recs = this._records();
    const sale = recs.find((r) => r.type === 'sale' && r.id === id);
    // (new-product entries are listed but not undone here)
    if (!sale) return null;
    return { ...sale, undone: recs.some((r) => r.type === 'undo' && r.ref === id) };
  }

  today() {
    const day = localDate();
    const recs = this._records().filter((r) => r.day === day);
    const undone = new Set(recs.filter((r) => r.type === 'undo').map((r) => r.ref));
    return recs.filter((r) => r.type === 'sale' || r.type === 'new').map((r) => ({ mode: 'sold', ...r, undone: undone.has(r.id) })).reverse();
  }
}

module.exports = { SalesLog, localDate };
