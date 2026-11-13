'use strict';

// Uploads product photos to the WordPress media library.
// WooCommerce API keys only work for WooCommerce, so photo uploads use a
// WordPress Application Password (Users > Profile > Application Passwords),
// stored encrypted like the API key.

const TYPES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];
const MAX_BYTES = 8 * 1024 * 1024;

class MediaError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function decodeImage(img, i) {
  const b64 = String((img && img.data) || '').replace(/^data:[^,]*,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw new MediaError(`Photo ${i + 1} is empty.`);
  if (bytes.length > MAX_BYTES) throw new MediaError(`Photo ${i + 1} is too large (8 MB max).`);
  const type = TYPES.find((t) => t.test(bytes));
  if (!type) throw new MediaError(`Photo ${i + 1} is not a JPEG, PNG or WebP image.`);
  return { bytes, type };
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'product';
}

class MediaClient {
  constructor({ storeUrl, wpUser, wpAppPassword, fetchImpl, timeoutMs = 60000 }) {
    this.base = storeUrl.replace(/\/+$/, '') + '/wp-json/wp/v2';
    this.user = wpUser;
    this.pass = String(wpAppPassword || '').replace(/\s+/g, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.user && this.pass); }

  async _req(method, path, { body, headers = {} } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.base + path, {
        method,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64'),
          Accept: 'application/json',
          'User-Agent': 'brushbeater-pos/0.2',
          ...headers,
        },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const msg = (data && data.message) || `HTTP ${res.status}`;
        const e = new Error(res.status === 401 || res.status === 403
          ? `WordPress rejected the photo upload login (${msg}). Check the username and Application Password in Settings.`
          : `Photo upload failed: ${msg}`);
        e.status = res.status === 401 || res.status === 403 ? 400 : 502;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(img, i, productName) {
    const { bytes, type } = decodeImage(img, i);
    const filename = `${slugify(productName)}-${i + 1}.${type.ext}`;
    const media = await this._req('POST', '/media', {
      body: bytes,
      headers: { 'Content-Type': type.mime, 'Content-Disposition': `attachment; filename="${filename}"` },
    });
    // Alt text = product name (helps search engines and screen readers).
    await this._req('POST', `/media/${media.id}`, {
      body: JSON.stringify({ alt_text: productName, title: productName }),
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    return { id: media.id, src: media.source_url };
  }

  async remove(id) {
    await this._req('DELETE', `/media/${id}?force=true`).catch(() => {});
  }

  async check() {
    return this._req('GET', '/users/me?context=edit&_fields=id,name,capabilities').then((u) => {
      if (u.capabilities && u.capabilities.upload_files === false) throw new Error('That WordPress user is not allowed to upload files.');
      return u;
    });
  }
}

module.exports = { MediaClient, MediaError, decodeImage, slugify };
