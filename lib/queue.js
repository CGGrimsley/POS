'use strict';

// Stock changes that couldn't reach the website (no internet) wait here,
// on disk, and are sent in order when the connection comes back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class OfflineQueue {
  constructor(file) {
    this.file = file;
    this.entries = [];   // waiting to send: { id, mode, lines, at, register }
    this.problems = [];  // reached the store but were refused: { ...entry, error }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.entries = raw.entries || [];
        this.problems = raw.problems || [];
      }
    } catch { /* start empty if the file is unreadable */ }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries, problems: this.problems }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  add(mode, lines, register) {
    const entry = { id: crypto.randomUUID(), mode, lines, at: new Date().toISOString(), register };
    this.entries.push(entry);
    this._save();
    return entry;
  }

  cancel(id) {
    const before = this.entries.length + this.problems.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.problems = this.problems.filter((e) => e.id !== id);
    this._save();
    return before !== this.entries.length + this.problems.length;
  }

  get count() { return this.entries.length; }

  // Send waiting changes in order. Stops at the first one that still can't
  // reach the store, so later changes never jump ahead of earlier ones.
  async flush(stock, onSent) {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let sent = 0;
      while (this.entries.length) {
        const entry = this.entries[0];
        let r;
        try {
          r = await stock.apply(entry.lines.map((l) => ({ key: l.key, qty: l.qty })), entry.mode);
        } catch (e) {
          if (e.network) break;
          this.problems.push({ ...entry, error: e.message });
          this.entries.shift();
          this._save();
          continue;
        }
        if (r.done.length) onSent(entry, r.done);
        const net = r.failed.filter((f) => f.network);
        const refused = r.failed.filter((f) => !f.network);
        if (refused.length) this.problems.push({ ...entry, lines: refused, error: refused.map((f) => `${f.name}: ${f.error}`).join('; ') });
        if (net.length) {
          entry.lines = entry.lines.filter((l) => net.some((n) => n.key === l.key));
          this._save();
          break;
        }
        this.entries.shift();
        this._save();
        sent += 1;
      }
      return sent;
    })();
    try { return await this.flushing; } finally { this.flushing = null; }
  }
}

module.exports = { OfflineQueue };
