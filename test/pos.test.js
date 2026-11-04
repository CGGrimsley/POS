'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Catalog, toItem, search } = require('../lib/catalog');
const { StockService } = require('../lib/stock');
const { SettingsStore, publicSettings } = require('../lib/settings');
const { SalesLog } = require('../lib/saleslog');
const { createPosServer } = require('../lib/app');

// In-memory stand-in for the WooCommerce API.
function fakeWoo() {
  const products = {
    1: { id: 1, name: 'Radio Contra Decal', sku: 'BSI1', type: 'simple', status: 'publish', price: '2', regular_price: '2', manage_stock: true, stock_quantity: 10, stock_status: 'instock', images: [], categories: [{ name: 'Decals' }] },
    2: { id: 2, name: 'Cowboy Tee', sku: 'TEE', type: 'variable', status: 'publish', price: '25', manage_stock: true, stock_quantity: 5, stock_status: 'instock', images: [], categories: [], variations: [21, 22] },
    3: { id: 3, name: 'Gift Card', sku: 'GIFT', type: 'simple', status: 'publish', price: '50', manage_stock: false, stock_quantity: null, stock_status: 'instock', images: [], categories: [] },
  };
  const variations = {
    21: { id: 21, sku: 'TEE-M', price: '25', manage_stock: 'parent', stock_quantity: 5, stock_status: 'instock', attributes: [{ option: 'M' }] },
    22: { id: 22, sku: 'TEE-L', price: '25', manage_stock: true, stock_quantity: 3, stock_status: 'instock', attributes: [{ option: 'L' }] },
  };
  const writes = [];
  const find = (p) => {
    let m = p.match(/^\/products\/(\d+)\/variations\/(\d+)$/);
    if (m) return variations[m[2]];
    m = p.match(/^\/products\/(\d+)$/);
    if (m) return products[m[1]];
    return null;
  };
  return {
    products, variations, writes,
    async getAll(p) {
      if (p === '/products') return Object.values(products);
      const m = p.match(/^\/products\/(\d+)\/variations$/);
      return products[m[1]].variations.map((id) => variations[id]);
    },
    async get(p) { return { ...find(p) }; },
    async put(p, body) {
      const o = find(p);
      if (o.failNext) { o.failNext = false; throw new Error('boom'); }
      writes.push([p, body]);
      Object.assign(o, body);
      return { ...o };
    },
  };
}

test('variations use parent stock when set to "parent"', () => {
  const w = fakeWoo();
  const m = toItem(w.products[2], w.variations[21]);
  assert.equal(m.name, 'Cowboy Tee (M)');
  assert.equal(m.stockOwner, 2);
  assert.equal(m.stockQty, 5);
  const l = toItem(w.products[2], w.variations[22]);
  assert.equal(l.stockOwner, 22);
  assert.equal(l.stockQty, 3);
});

test('search: exact SKU (barcode) ranks first, all words must match', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  assert.equal(c.items.length, 4); // simple x2 + 2 variations; the variable parent is not sellable
  assert.equal(c.search('tee-l')[0].sku, 'TEE-L');
  assert.equal(c.search('cowboy tee').length, 2);
  assert.equal(c.search('cowboy decal').length, 0);
  assert.equal(c.search('decals')[0].name, 'Radio Contra Decal'); // category match
});

test('selling subtracts from fresh website stock, undo adds it back', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  w.products[1].stock_quantity = 8; // website sold 2 since the last refresh
  const s = new StockService(w, c);
  const r = await s.adjust([{ key: '1', qty: 3 }], -1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.done[0].before, 8);
  assert.equal(r.done[0].after, 5);
  assert.equal(w.products[1].stock_quantity, 5);
  assert.equal(c.get('1').stockQty, 5);
  await s.adjust([{ key: '1', qty: 3 }], +1);
  assert.equal(w.products[1].stock_quantity, 8);
});

test('variations sharing parent stock are combined into one write', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  w.variations[21].manage_stock = 'parent';
  const s = new StockService(w, c);
  const r = await s.adjust([{ key: '2:21', qty: 2 }, { key: '2:22', qty: 1 }], -1);
  assert.equal(r.done.length, 2);
  assert.equal(w.products[2].stock_quantity, 3);
  assert.equal(w.variations[22].stock_quantity, 2);
  assert.equal(w.writes.length, 2);
});

test('one failed item does not block the others', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  w.products[1].failNext = true;
  const r = await new StockService(w, c).adjust([{ key: '1', qty: 1 }, { key: '2:22', qty: 1 }], -1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].key, '1');
  assert.equal(r.done.length, 1);
});

test('rejects untracked items and bad quantities', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const s = new StockService(w, c);
  await assert.rejects(s.adjust([{ key: '3', qty: 1 }]), /does not track stock/);
  await assert.rejects(s.adjust([{ key: '1', qty: 0 }]), /whole number/);
  await assert.rejects(s.adjust([{ key: '1', qty: 1.5 }]), /whole number/);
  await assert.rejects(s.adjust([]), /Nothing to record/);
  assert.equal(w.writes.length, 0);
});

test('settings: secrets are encrypted on disk and never sent to the screen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'));
  const file = path.join(dir, 'settings.json');
  const cipher = { encrypt: (s) => Buffer.from('x' + s).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(1) };
  const store = new SettingsStore(file, cipher);
  const key = 'ck_' + 'a'.repeat(40);
  store.save({ consumerKey: key, consumerSecret: 'cs_' + 'b'.repeat(40), register: 'Front' });
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(key));
  const cfg = store.load();
  assert.equal(cfg.consumerKey, key);
  store.save({ consumerKey: '', register: 'Back' }); // blank keeps the saved key
  assert.equal(store.load().consumerKey, key);
  const pub = publicSettings(store.load());
  assert.equal(pub.consumerKey, undefined);
  assert.equal(pub.consumerKeySet, true);
  assert.equal(pub.register, 'Back');
});

test('sales log: today list and undo marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'));
  const log = new SalesLog(dir);
  const a = log.addSale('Front', [{ key: '1', qty: 1 }]);
  log.addSale('Front', [{ key: '2', qty: 1 }]);
  log.addUndo(a.id, []);
  const today = log.today();
  assert.equal(today.length, 2);
  assert.equal(today[1].undone, true);
  assert.equal(log.get(a.id).undone, true);
});

test('server: API needs the launch token and a local Host header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'));
  const store = new SettingsStore(path.join(dir, 's.json'));
  const server = createPosServer({ store, dataDir: dir, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/status')).status, 403);
    const ok = await fetch(base + '/api/status', { headers: { 'X-POS-Token': server.posToken } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.configured, false);
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes(server.posToken));
    assert.equal((await fetch(base + '/../package.json')).status, 404);
  } finally {
    server.close();
  }
});
