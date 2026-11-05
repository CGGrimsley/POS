'use strict';

// Takes sold items off the website's stock count, and can put them back
// (undo). Each item is updated by reading its current stock from the store
// first and then writing the new number, so the count is based on the
// latest value even if the website sold some in the meantime.

class StockError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function validateLines(lines, catalog) {
  if (!Array.isArray(lines) || lines.length === 0) throw new StockError('Nothing to record. Add items first.');
  if (lines.length > 100) throw new StockError('That is too many lines at once.');
  const out = lines.map((l, i) => {
    const item = catalog.get(l.key);
    if (!item) throw new StockError(`Line ${i + 1}: that product is no longer on the website. Refresh products and try again.`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new StockError(`Line ${i + 1}: quantity must be a whole number from 1 to 999.`);
    if (!item.manageStock) throw new StockError(`The website does not track stock for "${item.name}", so there is no count to update. Remove it from the list.`);
    return { item, qty };
  });
  // Combine lines that draw on the same stock number (e.g. variations that
  // share their parent's stock).
  const byOwner = new Map();
  for (const l of out) {
    const k = String(l.item.stockOwner);
    const g = byOwner.get(k) || { owner: l.item.stockOwner, productId: l.item.productId, lines: [], qty: 0 };
    g.lines.push(l);
    g.qty += l.qty;
    byOwner.set(k, g);
  }
  return [...byOwner.values()];
}

function ownerPath(g) {
  return g.owner === g.productId
    ? `/products/${g.productId}`
    : `/products/${g.productId}/variations/${g.owner}`;
}

class StockService {
  constructor(woo, catalog, { log = () => {} } = {}) {
    this.woo = woo;
    this.catalog = catalog;
    this.log = log;
  }

  // direction -1 = sold (subtract), +1 = undo (add back)
  async adjust(lines, direction = -1) {
    const groups = validateLines(lines, this.catalog);
    const done = [];
    const failed = [];
    for (const g of groups) {
      const path = ownerPath(g);
      try {
        const fresh = await this.woo.get(path, { _fields: 'id,stock_quantity,manage_stock' });
        if (fresh.manage_stock === false) throw new Error('the website stopped tracking stock for this item');
        const before = Number(fresh.stock_quantity || 0);
        const after = before + direction * g.qty;
        const saved = await this.woo.put(path, { stock_quantity: after });
        for (const l of g.lines) {
          done.push({ key: l.item.key, name: l.item.name, sku: l.item.sku, qty: l.qty, before, after: Number(saved.stock_quantity) });
        }
      } catch (e) {
        for (const l of g.lines) failed.push({ key: l.item.key, name: l.item.name, qty: l.qty, error: e.message });
      }
    }
    await this.catalog.refreshItems([...done, ...failed].map((d) => d.key));
    return { done, failed };
  }
}

module.exports = { StockService, StockError, validateLines };
