'use strict';

// Creates new simple products on the website from the counter.

const { toItem } = require('./catalog');

class ProductError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function validateNew(input) {
  const name = String(input.name || '').trim();
  if (name.length < 3) throw new ProductError('Give the product a name.');
  if (name.length > 200) throw new ProductError('That name is too long.');
  const price = Number(input.price);
  if (!Number.isFinite(price) || price < 0 || price > 1e6) throw new ProductError('Enter a price, like 24.99.');
  const qty = input.qty === '' || input.qty === undefined ? 0 : Number(input.qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > 9999) throw new ProductError('Quantity must be a whole number from 0 to 9999.');
  const sku = String(input.sku || '').trim();
  if (sku.length > 100) throw new ProductError('That SKU is too long.');
  const status = input.status === 'publish' ? 'publish' : 'draft';
  const categoryIds = (Array.isArray(input.categoryIds) ? input.categoryIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10);
  const description = String(input.description || '').trim().slice(0, 2000);
  return { name, price, qty, sku, status, categoryIds, description };
}

class ProductService {
  constructor(woo, catalog) {
    this.woo = woo;
    this.catalog = catalog;
    this.categories = null;
  }

  async listCategories() {
    if (!this.categories) {
      const cats = await this.woo.getAll('/products/categories', { _fields: 'id,name,parent,count' });
      const byId = new Map(cats.map((c) => [c.id, c]));
      const label = (c) => {
        const parts = [];
        for (let x = c, n = 0; x && n < 5; x = byId.get(x.parent), n++) parts.unshift(x.name);
        return parts.join(' › ');
      };
      this.categories = cats
        .map((c) => ({ id: c.id, name: label(c).replace(/&amp;/g, '&') }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return this.categories;
  }

  async create(input) {
    const p = validateNew(input);
    if (p.sku && this.catalog.items.some((it) => it.sku && it.sku.toLowerCase() === p.sku.toLowerCase())) {
      throw new ProductError(`Another product already uses SKU ${p.sku}. Search for it instead.`);
    }
    const body = {
      name: p.name,
      type: 'simple',
      status: p.status,
      regular_price: p.price.toFixed(2),
      manage_stock: true,
      stock_quantity: p.qty,
    };
    if (p.sku) body.sku = p.sku;
    if (p.categoryIds.length) body.categories = p.categoryIds.map((id) => ({ id }));
    if (p.description) body.short_description = p.description;
    const created = await this.woo.post('/products', body);
    const item = this.catalog.add(toItem(created));
    return { item: publicItemOf(item), editUrl: `${this.woo.base.replace(/\/wp-json\/wc\/v3$/, '')}/wp-admin/post.php?post=${created.id}&action=edit` };
  }
}

function publicItemOf(it) {
  const { _search, _name, _sku, ...rest } = it; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { ProductService, ProductError, validateNew };
