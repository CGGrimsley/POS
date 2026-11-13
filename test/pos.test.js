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
const { ProductService } = require('../lib/products');
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
    base: 'https://example.test/wp-json/wc/v3',
    async getAll(p) {
      if (p === '/products') return Object.values(products);
      if (p === '/products/categories') return [{ id: 5, name: 'Optics', parent: 0 }, { id: 6, name: 'Thermal', parent: 5 }];
      const m = p.match(/^\/products\/(\d+)\/variations$/);
      return products[m[1]].variations.map((id) => variations[id]);
    },
    async get(p) { return { ...find(p) }; },
    async post(p, body) {
      if (p !== '/products') throw new Error('unexpected post ' + p);
      const id = 100 + Object.keys(products).length;
      products[id] = { id, type: 'simple', price: body.regular_price, images: [], categories: [], stock_status: 'instock', ...body };
      writes.push([p, body]);
      return { ...products[id] };
    },
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

test('received adds, set makes the count exact, and undo reverses each', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const s = new StockService(w, c);
  const r = await s.apply([{ key: '1', qty: 4 }], 'received');
  assert.equal(w.products[1].stock_quantity, 14);
  await s.undo({ mode: 'received', lines: r.done });
  assert.equal(w.products[1].stock_quantity, 10);

  const r2 = await s.apply([{ key: '2:22', qty: 0 }], 'set');
  assert.equal(w.variations[22].stock_quantity, 0);
  assert.equal(r2.done[0].before, 3);
  await s.undo({ mode: 'set', lines: r2.done });
  assert.equal(w.variations[22].stock_quantity, 3);
  await assert.rejects(s.apply([{ key: '1', qty: 0 }], 'received'), /whole number from 1/);
});

test('receiving an untracked item turns tracking on; undo sets it back to 0', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const s = new StockService(w, c);
  const r = await s.apply([{ key: '3', qty: 2 }], 'received');
  assert.equal(w.products[3].manage_stock, true);
  assert.equal(w.products[3].stock_quantity, 2);
  assert.equal(r.done[0].startedTracking, true);
  assert.equal(c.get('3').manageStock, true);
  await s.undo({ mode: 'received', lines: r.done });
  assert.equal(w.products[3].stock_quantity, 0);
});

test('set count refuses two lines that share one parent stock number', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  w.variations[22].manage_stock = 'parent';
  await c.load();
  await assert.rejects(new StockService(w, c).apply([{ key: '2:21', qty: 1 }, { key: '2:22', qty: 1 }], 'set'), /share one stock count/);
});

test('new product: created as draft with stock, added to search, duplicate SKU refused', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const ps = new ProductService(w, c);
  const cats = await ps.listCategories();
  assert.deepEqual(cats.map((x) => x.name), ['Optics', 'Optics › Thermal']);
  const out = await ps.create({ name: 'Peak Refuel Beef Stroganoff', price: '13.99', qty: 41, sku: 'PR-BS', categoryIds: [6] });
  const sent = w.writes.at(-1)[1];
  assert.equal(sent.status, 'draft');
  assert.equal(sent.regular_price, '13.99');
  assert.equal(sent.stock_quantity, 41);
  assert.equal(sent.manage_stock, true);
  assert.deepEqual(sent.categories, [{ id: 6 }]);
  assert.equal(out.item.stockQty, 41);
  assert.equal(c.search('stroganoff')[0].sku, 'PR-BS');
  await assert.rejects(ps.create({ name: 'Other', price: 1, sku: 'pr-bs' }), /already uses SKU/);
  await assert.rejects(ps.create({ name: 'Ok name', price: -1 }), /price/);
});

test('photos: uploaded to the media library with the WordPress login, then attached', async () => {
  const { MediaClient } = require('../lib/media');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: 900 + calls.length, source_url: 'https://x/img.jpg' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const media = new MediaClient({ storeUrl: 'https://example.test', wpUser: 'chris', wpAppPassword: 'abcd efgh ijkl', fetchImpl });
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const ps = new ProductService(w, c, media);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  await ps.create({ name: 'Peak Refuel Chicken Pesto', price: 14, qty: 3, images: [{ data: jpeg }], imageUrls: ['https://cdn.example/p.jpg'] });
  const up = calls[0];
  assert.match(up.url, /\/wp-json\/wp\/v2\/media$/);
  assert.equal(up.opts.headers['Content-Type'], 'image/jpeg');
  assert.match(up.opts.headers['Content-Disposition'], /peak-refuel-chicken-pesto-1\.jpg/);
  assert.equal(up.opts.headers.Authorization, 'Basic ' + Buffer.from('chris:abcdefghijkl').toString('base64'));
  const sent = w.writes.at(-1)[1];
  assert.deepEqual(sent.images, [{ id: 901 }, { src: 'https://cdn.example/p.jpg', alt: 'Peak Refuel Chicken Pesto' }]);

  // Not an image -> refused before anything is created
  const before = w.writes.length;
  await assert.rejects(ps.create({ name: 'Bad photo', price: 1, images: [{ data: 'data:image/jpeg;base64,' + Buffer.from('hello').toString('base64') }] }), /not a JPEG/);
  assert.equal(w.writes.length, before);
});

test('photos: file uploads without a WordPress login are refused with a clear message', async () => {
  const { MediaClient } = require('../lib/media');
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const ps = new ProductService(w, c, new MediaClient({ storeUrl: 'https://example.test' }));
  await assert.rejects(ps.create({ name: 'Needs login', price: 1, images: [{ data: 'x' }] }), /Application Password/);
  await assert.rejects(ps.create({ name: 'Bad link', price: 1, imageUrls: ['http://insecure/x.jpg'] }), /https/);
});

test('offline: changes that cannot reach the store wait on disk and go out in order', async () => {
  const { OfflineQueue } = require('../lib/queue');
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const s = new StockService(w, c);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'));
  const file = path.join(dir, 'q.json');
  const realGet = w.get;
  w.get = async () => { throw Object.assign(new Error('offline'), { network: true }); };
  const r = await s.apply([{ key: '1', qty: 2 }], 'sold');
  assert.equal(r.failed[0].network, true);
  const q = new OfflineQueue(file);
  q.add('sold', [{ key: '1', qty: 2 }], 'Front');
  q.add('received', [{ key: '1', qty: 5 }], 'Front');
  c.adjustLocal('1', 'sold', 2);
  assert.equal(c.get('1').stockQty, 8);
  // Still offline: nothing is sent, nothing is lost, and it survives a restart.
  assert.equal(await q.flush(s, () => {}), 0);
  assert.equal(new OfflineQueue(file).count, 2);
  // Back online: both go out, in the order they were made.
  w.get = realGet;
  const sent = [];
  assert.equal(await new OfflineQueue(file).flush(s, (e) => sent.push(e.mode)), 2);
  assert.deepEqual(sent, ['sold', 'received']);
  assert.equal(w.products[1].stock_quantity, 13);
  assert.equal(new OfflineQueue(file).count, 0);
});

test('offline: a change the store refuses is set aside, not retried forever', async () => {
  const { OfflineQueue } = require('../lib/queue');
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const s = new StockService(w, c);
  const q = new OfflineQueue(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), 'q.json'));
  w.products[1].failNext = true;
  q.add('sold', [{ key: '1', qty: 1 }], 'Front');
  q.add('sold', [{ key: '3', qty: 1 }], 'Front'); // gift card, stock not tracked
  await q.flush(s, () => {});
  assert.equal(q.count, 0);
  assert.equal(q.problems.length, 2);
  assert.match(q.problems[0].error, /boom/);
  assert.equal(q.cancel(q.problems[0].id), true);
  assert.equal(q.problems.length, 1);
});

test('catalog cache: the saved product list loads without the internet', async () => {
  const w = fakeWoo();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), 'cache.json');
  await new Catalog(w, { cacheFile: file }).load();
  const c = new Catalog({ getAll: async () => { throw new Error('offline'); } }, { cacheFile: file });
  assert.equal(c.loadCache(), true);
  assert.equal(c.fromCache, true);
  assert.equal(c.items.length, 4);
  assert.equal(c.search('tee-l')[0].sku, 'TEE-L');
});

test('low stock: tracked items at or below the limit, lowest first', async () => {
  const w = fakeWoo();
  w.products[1].stock_quantity = 1;
  const c = new Catalog(w);
  await c.load();
  const low = c.lowStock({ max: 3 });
  assert.deepEqual(low.map((i) => i.sku), ['BSI1', 'TEE-L']); // gift card is untracked
  assert.deepEqual(c.lowStock({ max: 3, category: 'Decals' }).map((i) => i.sku), ['BSI1']);
  assert.equal(c.lowStock({ max: 0 }).length, 0);
  assert.ok(c.categoryNames().includes('Decals'));
});

test('price: regular and sale price saved on the website, bad prices refused', async () => {
  const w = fakeWoo();
  const c = new Catalog(w);
  await c.load();
  const p = new ProductService(w, c, null);
  await p.updatePrice({ key: '1', regularPrice: '3.5', salePrice: '2.75' });
  assert.equal(w.products[1].regular_price, '3.50');
  assert.equal(w.products[1].sale_price, '2.75');
  await p.updatePrice({ key: '1', regularPrice: '3.5', salePrice: '' });
  assert.equal(w.products[1].sale_price, '');
  await assert.rejects(p.updatePrice({ key: '1', regularPrice: '3', salePrice: '4' }), /lower than the regular/);
  await assert.rejects(p.updatePrice({ key: '1', regularPrice: 'abc' }), /regular price/);
});

test('sales log: any day can be read back, with new products and undo marks', () => {
  const { localDate } = require('../lib/saleslog');
  const log = new SalesLog(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')));
  const a = log.addSale('Front', [{ key: '1', qty: 1, price: '2' }], 'sold');
  log.addSale('Front', [{ key: '1', qty: 4 }], 'received');
  log.addNewProduct('Front', { key: '9', name: 'New thing', sku: 'N1', price: '5', stockQty: 2 });
  log.addUndo(a.id, []);
  const d = log.day(localDate());
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((e) => (e.type === 'new' ? 'new' : e.mode)), ['new', 'received', 'sold']);
  assert.equal(d.find((e) => e.id === a.id).undone, true);
  assert.equal(log.day('2001-01-01').length, 0);
  assert.equal(log.day('nonsense').length, 0);
});

test('website orders: one local day is asked for in UTC, refunds listed but not counted', async () => {
  const { ordersForDay, dayRange } = require('../lib/orders');
  const r = dayRange('2026-11-13');
  assert.equal(new Date(r.after + 'Z').getTime(), new Date(2026, 10, 13).getTime());
  assert.equal(new Date(r.before + 'Z').getTime(), new Date(2026, 10, 14).getTime());
  let asked;
  const woo = {
    async getAll(p, q) {
      asked = [p, q];
      return [
        { id: 7, number: '7', status: 'processing', date_created_gmt: '2026-11-13T15:00:00', total: '27.68', total_tax: '1.69', shipping_total: '0', line_items: [{ product_id: 2, variation_id: 22, name: 'Cowboy Tee - L', sku: 'TEE-L', quantity: 1, total: '25.00' }] },
        { id: 8, number: '8', status: 'refunded', date_created_gmt: '2026-11-13T16:00:00', total: '2.14', line_items: [{ product_id: 1, variation_id: 0, name: 'Radio Contra Decal', quantity: 1, total: '2.00' }] },
      ];
    },
  };
  const orders = await ordersForDay(woo, '2026-11-13');
  assert.equal(asked[0], '/orders');
  assert.equal(asked[1].dates_are_gmt, 'true');
  assert.match(asked[1].status, /processing/);
  assert.equal(orders[0].lines[0].key, '2:22'); // same key as the product list, so counts line up
  assert.equal(orders[0].counted, true);
  assert.equal(orders[1].counted, false);
  assert.equal(orders[1].lines[0].key, '1');
  assert.throws(() => dayRange('nope'), /Pick a date/);
});
