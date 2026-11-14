'use strict';

// Minimal WooCommerce REST API (wc/v3) client. Uses the API key from the
// local settings file. Never logs the key or secret.

class WooError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class WooClient {
  constructor({ storeUrl, consumerKey, consumerSecret, fetchImpl, timeoutMs = 20000 }) {
    this.base = storeUrl.replace(/\/+$/, '') + '/wp-json/wc/v3';
    this.key = consumerKey;
    this.secret = consumerSecret;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    // Some hosts strip the Authorization header. If the header is rejected
    // we retry once with the key in the query string (still HTTPS only).
    this.authMode = 'header';
  }

  _url(path, query = {}) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    if (this.authMode === 'query') {
      u.searchParams.set('consumer_key', this.key);
      u.searchParams.set('consumer_secret', this.secret);
    }
    return u;
  }

  async request(method, path, { query, body } = {}) {
    const attempt = async () => {
      const headers = { Accept: 'application/json', 'User-Agent': 'brushbeater-pos/0.1' };
      if (this.authMode === 'header') {
        headers.Authorization = 'Basic ' + Buffer.from(`${this.key}:${this.secret}`).toString('base64');
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(this._url(path, query), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { res, data };
      } finally {
        clearTimeout(timer);
      }
    };

    let res, data;
    try {
      ({ res, data } = await attempt());
    } catch (e) {
      // No answer at all (offline, DNS, timeout): the caller may retry later.
      e.network = true;
      throw e;
    }
    if (res.status === 401 && this.authMode === 'header') {
      this.authMode = 'query';
      try { ({ res, data } = await attempt()); } catch (e) { e.network = true; throw e; }
    }
    if (!res.ok) {
      const msg = (data && data.message) || `HTTP ${res.status}`;
      throw new WooError(`WooCommerce ${method} ${path} failed: ${msg}`, res.status, data);
    }
    return { data, headers: res.headers };
  }

  get(path, query) { return this.request('GET', path, { query }).then((r) => r.data); }
  post(path, body) { return this.request('POST', path, { body }).then((r) => r.data); }
  put(path, body) { return this.request('PUT', path, { body }).then((r) => r.data); }
  del(path, query) { return this.request('DELETE', path, { query }).then((r) => r.data); }

  // Fetch every page of a collection.
  async getAll(path, query = {}) {
    const out = [];
    let page = 1;
    for (;;) {
      const { data, headers } = await this.request('GET', path, { query: { per_page: 100, ...query, page } });
      out.push(...data);
      const totalPages = Number(headers.get('x-wp-totalpages') || 1);
      if (page >= totalPages || data.length === 0) break;
      page += 1;
    }
    return out;
  }
}

module.exports = { WooClient, WooError };
