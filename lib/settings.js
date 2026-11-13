'use strict';

// Stores this laptop's settings in a JSON file outside the repo (in the
// Windows app that is %APPDATA%\Brushbeater POS\settings.json).
// Secret fields are encrypted with the operating system's key store when a
// cipher is provided (Electron safeStorage uses Windows DPAPI), so the file
// on its own does not reveal the API keys.

const fs = require('fs');
const path = require('path');

const SECRET_FIELDS = ['consumerKey', 'consumerSecret', 'wpAppPassword'];

const DEFAULTS = {
  storeUrl: 'https://brushbeater.store',
  register: 'Counter laptop',
  // Only used to show a total with tax on screen. Yanceyville: 4.75% NC + 2% Caswell County.
  taxRate: 0.0675,
  catalogRefreshMinutes: 10,
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

class SettingsStore {
  // cipher: { encrypt(string) -> base64 string, decrypt(base64) -> string } or null
  constructor(file, cipher = null) {
    this.file = file;
    this.cipher = cipher;
  }

  load() {
    let raw = {};
    if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const secrets = {};
    for (const f of SECRET_FIELDS) {
      if (raw[f] === undefined) continue;
      if (raw[f] && typeof raw[f] === 'object' && raw[f].enc) {
        if (!this.cipher) throw new Error('Settings are encrypted but no decryption is available on this computer.');
        secrets[f] = this.cipher.decrypt(raw[f].enc);
      } else {
        secrets[f] = raw[f];
      }
    }
    const out = merge(DEFAULTS, raw);
    Object.assign(out, secrets);
    out.storeUrl = String(out.storeUrl).replace(/\/+$/, '');
    return out;
  }

  // Saves a partial update. A blank secret leaves the saved one in place.
  save(update) {
    const current = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    const next = merge(current, stripSecrets(update));
    for (const f of SECRET_FIELDS) {
      const v = update[f];
      if (typeof v !== 'string' || v.trim() === '') continue;
      next[f] = this.cipher ? { enc: this.cipher.encrypt(v.trim()) } : v.trim();
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.load();
  }
}

function stripSecrets(obj) {
  const out = { ...obj };
  for (const f of SECRET_FIELDS) delete out[f];
  return out;
}

// What the screen is allowed to see: no secrets, only whether they are set.
function publicSettings(cfg) {
  const out = stripSecrets(cfg);
  for (const f of SECRET_FIELDS) out[f + 'Set'] = Boolean(cfg[f]);
  return out;
}

function validate(cfg) {
  const problems = [];
  if (!(Number(cfg.taxRate) >= 0 && Number(cfg.taxRate) < 0.2)) problems.push('Tax rate should be a decimal like 0.0675');
  if (!/^ck_[a-f0-9]{20,}$/i.test(cfg.consumerKey || '')) problems.push('The WooCommerce consumer key should start with ck_');
  if (!/^cs_[a-f0-9]{20,}$/i.test(cfg.consumerSecret || '')) problems.push('The WooCommerce consumer secret should start with cs_');
  if (!/^https:\/\//.test(cfg.storeUrl || '') && !process.env.POS_ALLOW_HTTP) problems.push('The store address must start with https://');
  return problems;
}

module.exports = { SettingsStore, publicSettings, validate, DEFAULTS, SECRET_FIELDS };
