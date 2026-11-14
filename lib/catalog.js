'use strict';

// Keeps a local copy of the store's products (and variations) so search is
// instant on the counter, and refreshes it in the background.

const fs = require('fs');
const path = require('path');

const PRODUCT_FIELDS = [
  'id', 'name', 'sku', 'type', 'status', 'price', 'regular_price', 'sale_price', 'manage_stock',
  'stock_quantity', 'stock_status', 'images', 'categories', 'variations', 'permalink',
].join(',');

const VARIATION_FIELDS = [
  'id', 'sku', 'price', 'regular_price', 'sale_price', 'status', 'manage_stock', 'stock_quantity',
  'stock_status', 'attributes', 'image',
].join(',');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function normalize(s) {
  return decodeEntities(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ').trim();
}

// Turn a product (and optionally one of its variations) into a sellable item.
function toItem(product, variation) {
  const parentName = decodeEntities(product.name);
  const optionText = variation
    ? (variation.attributes || []).map((a) => a.option).filter(Boolean).join(' / ')
    : '';
  // A variation with manage_stock "parent" uses the parent's stock number.
  let manageStock = product.manage_stock === true;
  let stockQty = product.stock_quantity;
  let stockStatus = product.stock_status;
  let stockOwner = product.id;
  if (variation) {
    stockStatus = variation.stock_status;
    if (variation.manage_stock === true) {
      manageStock = true;
      stockQty = variation.stock_quantity;
      stockOwner = variation.id;
    } else if (variation.manage_stock !== 'parent') {
      manageStock = false;
      stockQty = null;
    }
  }
  const image = variation && variation.image && variation.image.src
    ? variation.image.src
    : (product.images && product.images[0] && product.images[0].src) || null;
  const item = {
    key: variation ? `${product.id}:${variation.id}` : String(product.id),
    productId: product.id,
    variationId: variation ? variation.id : 0,
    name: optionText ? `${parentName} (${optionText})` : parentName,
    parentName,
    option: optionText,
    sku: (variation && variation.sku) || product.sku || '',
    price: Number((variation ? variation.price : product.price) || 0),
    regularPrice: Number((variation ? variation.regular_price : product.regular_price) || 0),
    salePrice: (variation ? variation.sale_price : product.sale_price) ? Number(variation ? variation.sale_price : product.sale_price) : null,
    manageStock,
    stockQty: manageStock ? Number(stockQty || 0) : null,
    stockStatus,
    stockOwner,
    status: product.status,
    categories: (product.categories || []).map((c) => decodeEntities(c.name)),
    image,
    permalink: product.permalink,
  };
  item._search = normalize([item.name, item.sku, item.categories.join(' ')].join(' '));
  item._name = normalize(item.name);
  item._sku = normalize(item.sku);
  return item;
}

function search(items, query, limit = 40) {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(' ').filter(Boolean);
  const rawSku = String(query).trim().toLowerCase();
  const scored = [];
  for (const it of items) {
    if (!tokens.every((t) => it._search.includes(t))) continue;
    let score = 0;
    if (it.sku && it.sku.toLowerCase() === rawSku) score += 1000; // barcode / exact SKU
    if (it._name.startsWith(q)) score += 50;
    for (const t of tokens) {
      if (new RegExp('(^| )' + t.replace(/[.]/g, '\\.')).test(it._name)) score += 10;
    }
    if (it.stockStatus === 'instock') score += 5;
    if (it.status === 'publish') score += 1;
    scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name));
  return scored.slice(0, limit).map((s) => publicItem(s.it));
}

function publicItem(it) {
  const { _search, _name, _sku, ...rest } = it; // eslint-disable-line no-unused-vars
  return rest;
}

class Catalog {
  constructor(woo, { log = () => {}, cacheFile = null } = {}) {
    this.woo = woo;
    this.log = log;
    this.cacheFile = cacheFile;
    this.fromCache = false;
    this.items = [];
    this.byKey = new Map();
    this.loadedAt = null;
    this.loading = null;
    this.lastError = null;
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const started = Date.now();
      const products = await this.woo.getAll('/products', { status: 'any', _fields: PRODUCT_FIELDS });
      const items = [];
      const variable = products.filter((p) => p.type === 'variable' && (p.variations || []).length && String(p.name || '').trim());
      for (const p of products) {
        if (p.type === 'variable' || p.type === 'grouped' || p.type === 'external') continue;
        if (!String(p.name || '').trim()) continue; // unfinished drafts
        items.push(toItem(p));
      }
      // Fetch variations a few products at a time.
      const queue = [...variable];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          const vars = await this.woo.getAll(`/products/${p.id}/variations`, { _fields: VARIATION_FIELDS });
          for (const v of vars) items.push(toItem(p, v));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      this._replace(items);
      this.loadedAt = new Date();
      this.lastError = null;
      this.fromCache = false;
      this.saveCache();
      this.log(`Catalog loaded: ${items.length} items in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return items.length;
    })();
    try {
      return await this.loading;
    } catch (e) {
      this.lastError = e.message;
      throw e;
    } finally {
      this.loading = null;
    }
  }

  // A copy on disk lets search work right away at startup, even offline.
  loadCache() {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      const items = raw.items.map((it) => ({
        ...it,
        _search: normalize([it.name, it.sku, (it.categories || []).join(' ')].join(' ')),
        _name: normalize(it.name),
        _sku: normalize(it.sku),
      }));
      this._replace(items);
      this.loadedAt = new Date(raw.savedAt);
      this.fromCache = true;
      return true;
    } catch (e) {
      this.log('Could not read the product cache: ' + e.message);
      return false;
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), items: this.items.map(publicItem) }));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      this.log('Could not save the product cache: ' + e.message);
    }
  }

  // Change the on-screen count without asking the store (used while offline).
  adjustLocal(key, mode, qty) {
    const it = this.byKey.get(String(key));
    if (!it) return;
    const before = it.manageStock ? Number(it.stockQty) || 0 : 0;
    const after = mode === 'set' ? qty : mode === 'received' ? before + qty : before - qty;
    const owner = it.manageStock ? it.stockOwner : (it.variationId || it.productId);
    for (const other of this.items) {
      if (other === it || (other.manageStock && other.stockOwner === owner)) {
        other.stockQty = after;
        other.manageStock = true;
        other.stockStatus = after > 0 ? 'instock' : 'outofstock';
      }
    }
  }

  // Tracked items at or below a count, for the reorder list.
  lowStock({ max = 0, category = '', includeHidden = false } = {}) {
    return this.items
      .filter((it) => it.manageStock && it.stockQty <= max)
      .filter((it) => includeHidden || it.status === 'publish')
      .filter((it) => !category || it.categories.includes(category))
      .sort((a, b) => a.stockQty - b.stockQty || a.name.localeCompare(b.name))
      .map(publicItem);
  }

  categoryNames() {
    return [...new Set(this.items.flatMap((it) => it.categories))].sort((a, b) => a.localeCompare(b));
  }

  _replace(items) {
    this.items = items;
    this.byKey = new Map(items.map((it) => [it.key, it]));
  }

  get(key) { return this.byKey.get(String(key)); }

  add(item) {
    const existing = this.byKey.get(item.key);
    if (existing) Object.assign(existing, item);
    else { this.items.push(item); this.byKey.set(item.key, item); }
    return this.byKey.get(item.key);
  }

  search(q, limit) { return search(this.items, q, limit); }

  // After a sale, re-read stock for just the sold items so every laptop
  // that refreshes sees the new numbers.
  async refreshItems(keys) {
    for (const key of keys) {
      const it = this.byKey.get(key);
      if (!it) continue;
      try {
        const product = await this.woo.get(`/products/${it.productId}`, { _fields: PRODUCT_FIELDS });
        const variation = it.variationId
          ? await this.woo.get(`/products/${it.productId}/variations/${it.variationId}`, { _fields: VARIATION_FIELDS })
          : null;
        const fresh = toItem(product, variation);
        // Variations sharing parent stock all change together.
        for (const other of this.items) {
          if (other.stockOwner === fresh.stockOwner && other.manageStock) {
            other.stockQty = fresh.stockQty;
            other.stockStatus = fresh.stockStatus;
          }
        }
        Object.assign(it, fresh);
        this.byKey.set(key, it);
      } catch (e) {
        this.log(`Could not refresh ${key}: ${e.message}`);
      }
    }
  }
}

module.exports = { Catalog, toItem, search, normalize, decodeEntities, publicItem };
