'use strict';

// Local web server for the POS screen. Listens on 127.0.0.1 only.
// Every /api call must carry the per-launch token, so a web page open in
// some other browser tab cannot change stock through it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WooClient } = require('./woo');
const { Catalog } = require('./catalog');
const { StockService } = require('./stock');
const { publicSettings, validate } = require('./settings');
const { SalesLog } = require('./saleslog');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
};

function createPosServer({ store, dataDir, log = console.log, fetchImpl, token = crypto.randomBytes(24).toString('hex') }) {
  const state = { cfg: null, woo: null, catalog: null, stock: null, timer: null, problems: [] };
  const salesLog = new SalesLog(dataDir);

  function configure() {
    if (state.timer) clearInterval(state.timer);
    state.cfg = store.load();
    state.problems = validate(state.cfg);
    state.woo = state.catalog = state.stock = null;
    if (state.problems.length) return;
    state.woo = new WooClient({ ...state.cfg, fetchImpl });
    state.catalog = new Catalog(state.woo, { log });
    state.stock = new StockService(state.woo, state.catalog, { log });
    state.catalog.load().catch((e) => log('Catalog load failed: ' + e.message));
    const mins = Math.max(2, Number(state.cfg.catalogRefreshMinutes) || 10);
    state.timer = setInterval(() => state.catalog.load().catch((e) => log('Catalog refresh failed: ' + e.message)), mins * 60000);
    state.timer.unref();
  }
  configure();

  const need = () => {
    if (!state.stock) {
      const e = new Error('Finish setting up this laptop in Settings first.');
      e.status = 409;
      throw e;
    }
  };

  const routes = {
    'GET /api/status': async () => ({
      configured: !state.problems.length,
      problems: state.problems,
      register: state.cfg.register,
      catalog: state.catalog ? {
        count: state.catalog.items.length,
        loadedAt: state.catalog.loadedAt,
        loading: Boolean(state.catalog.loading),
        error: state.catalog.lastError,
      } : null,
      settings: publicSettings(state.cfg),
    }),
    'POST /api/settings': async (body) => {
      const allowed = ['storeUrl', 'register', 'taxRate', 'consumerKey', 'consumerSecret', 'catalogRefreshMinutes'];
      if (body.taxRate !== undefined) body.taxRate = Number(body.taxRate);
      const update = {};
      for (const k of allowed) if (body[k] !== undefined) update[k] = body[k];
      store.save(update);
      configure();
      if (state.problems.length) return { ok: false, problems: state.problems };
      // Prove the key works before saying it is saved.
      try {
        // A write-capable key is needed; check by reading (writes are checked on first sale).
        await state.woo.get('/products', { per_page: 1, _fields: 'id' });
      } catch (e) {
        return { ok: false, problems: [`Saved, but the store rejected the key: ${e.message}`] };
      }
      return { ok: true };
    },
    'POST /api/catalog/refresh': async () => { need(); return { count: await state.catalog.load() }; },
    'GET /api/search': async (_b, q) => {
      need();
      if (!state.catalog.items.length && state.catalog.loading) await state.catalog.loading;
      return { results: state.catalog.search(q.get('q') || '', 40) };
    },
    'POST /api/sell': async (body) => {
      need();
      const result = await state.stock.adjust(body.lines, -1);
      const entry = result.done.length ? salesLog.addSale(state.cfg.register, result.done) : null;
      return { ...result, id: entry && entry.id };
    },
    'POST /api/undo': async (body) => {
      need();
      const sale = salesLog.get(String(body.id || ''));
      if (!sale) throw Object.assign(new Error('That sale is not in today\'s list on this laptop.'), { status: 404 });
      if (sale.undone) throw Object.assign(new Error('That sale was already undone.'), { status: 409 });
      const result = await state.stock.adjust(sale.lines.map((l) => ({ key: l.key, qty: l.qty })), +1);
      if (result.done.length) salesLog.addUndo(sale.id, result.done);
      return result;
    },
    'GET /api/sales/today': async () => ({ sales: salesLog.today() }),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'Forbidden' });

      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-pos-token'] !== token) return send(res, 403, { error: 'Forbidden' });
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return send(res, 404, { error: 'Not found' });
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = await handler(body, url.searchParams);
        return send(res, 200, out);
      }
      return serveStatic(url.pathname, res, token);
    } catch (e) {
      const status = e.status && e.status < 500 && e.status >= 400 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 500;
      log(`Error: ${e.message}`);
      return send(res, status, { error: friendly(e) });
    }
  });

  server.posToken = token;
  server.posState = state;
  server.on('close', () => { if (state.timer) clearInterval(state.timer); });
  return server;
}

function friendly(e) {
  if (e.name === 'AbortError') return 'The store took too long to answer. Check the internet connection and try again.';
  if (e.cause && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(e.cause.code))) {
    return 'Could not reach the store. Check the internet connection and try again.';
  }
  if (e.status === 401 || e.status === 403) return 'The store rejected the API key. Check Settings.';
  return e.message;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch {
        reject(Object.assign(new Error('Bad request'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res, token) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  let body = fs.readFileSync(file);
  const ext = path.extname(file);
  if (ext === '.html') body = Buffer.from(body.toString('utf8').replace('__POS_TOKEN__', token));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

module.exports = { createPosServer };
