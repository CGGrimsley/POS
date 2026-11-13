'use strict';

// Changes website stock counts. Three modes:
//   sold      subtract the quantity (a sale in the showroom)
//   received  add the quantity (new stock came in, or a return)
//   set       make the count exactly the quantity (a shelf count)
// Each item is updated by reading its current stock from the store first
// and then writing the new number, so the result is based on the latest
// value even if the website sold some in the meantime.

const MODES = ['sold', 'received', 'set'];

class StockError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function validateLines(lines, catalog, mode = 'sold') {
  if (!MODES.includes(mode)) throw new StockError('Unknown stock action.');
  if (!Array.isArray(lines) || lines.length === 0) throw new StockError('Nothing to record. Add items first.');
  if (lines.length > 100) throw new StockError('That is too many lines at once.');
  const min = mode === 'set' ? 0 : 1;
  const out = lines.map((l, i) => {
    const item = catalog.get(l.key);
    if (!item) throw new StockError(`Line ${i + 1}: that product is no longer on the website. Refresh products and try again.`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < min || qty > 9999) {
      throw new StockError(`Line ${i + 1}: quantity must be a whole number from ${min} to 9999.`);
    }
    if (!item.manageStock && mode === 'sold') {
      throw new StockError(`The website does not track stock for "${item.name}", so there is no count to take it off. Remove it from the list.`);
    }
    return { item, qty };
  });

  // Group lines that share one stock number (variations that use their
  // parent's stock). An untracked item gets tracking turned on, on itself.
  const byOwner = new Map();
  for (const l of out) {
    const it = l.item;
    const owner = it.manageStock ? it.stockOwner : (it.variationId || it.productId);
    const k = String(owner);
    const g = byOwner.get(k) || { owner, productId: it.productId, enableTracking: !it.manageStock, lines: [], qty: 0 };
    g.lines.push(l);
    g.qty += l.qty;
    byOwner.set(k, g);
  }
  const groups = [...byOwner.values()];
  if (mode === 'set') {
    const dup = groups.find((g) => g.lines.length > 1);
    if (dup) throw new StockError(`"${dup.lines[0].item.parentName}" options share one stock count. Put that count on one line only.`);
  }
  return groups;
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

  async apply(lines, mode = 'sold') {
    const groups = validateLines(lines, this.catalog, mode);
    const done = [];
    const failed = [];
    for (const g of groups) {
      const path = ownerPath(g);
      try {
        const fresh = await this.woo.get(path, { _fields: 'id,stock_quantity,manage_stock' });
        const tracked = fresh.manage_stock === true || (fresh.manage_stock === 'parent' && !g.enableTracking);
        if (!tracked && mode === 'sold') throw new Error('the website stopped tracking stock for this item');
        const before = tracked ? Number(fresh.stock_quantity || 0) : null;
        let after;
        if (mode === 'set') after = g.qty;
        else if (mode === 'received') after = (before || 0) + g.qty;
        else after = before - g.qty;
        const update = { stock_quantity: after };
        if (!tracked) update.manage_stock = true;
        const saved = await this.woo.put(path, update);
        for (const l of g.lines) {
          done.push({
            key: l.item.key, name: l.item.name, sku: l.item.sku, qty: l.qty, price: l.item.price,
            before, after: Number(saved.stock_quantity), startedTracking: !tracked,
          });
        }
      } catch (e) {
        for (const l of g.lines) {
          failed.push({ key: l.item.key, name: l.item.name, sku: l.item.sku, price: l.item.price, qty: l.qty, error: e.message, network: Boolean(e.network) });
        }
      }
    }
    if (done.length) await this.catalog.refreshItems(done.map((d) => d.key));
    return { done, failed };
  }

  // Reverse an earlier change from the log.
  async undo(entry) {
    const mode = entry.mode || 'sold';
    if (mode === 'sold') return this.apply(entry.lines.map((l) => ({ key: l.key, qty: l.qty })), 'received');
    if (mode === 'received') {
      return this.apply(entry.lines.filter((l) => !l.startedTracking).map((l) => ({ key: l.key, qty: l.qty })), 'sold')
        .catch((e) => { if (/Nothing to record/.test(e.message)) return { done: [], failed: [] }; throw e; })
        .then((r) => this._backToZero(entry, r));
    }
    // set: put each count back to what it was before
    const lines = entry.lines.filter((l) => l.before !== null && l.before !== undefined);
    const r = lines.length ? await this.apply(lines.map((l) => ({ key: l.key, qty: Math.max(0, l.before) })), 'set') : { done: [], failed: [] };
    return this._backToZero(entry, r);
  }

  // Items that had no stock count before get set to 0 on undo (tracking stays on).
  async _backToZero(entry, result) {
    const started = entry.lines.filter((l) => l.startedTracking || l.before === null);
    if (!started.length) return result;
    const r2 = await this.apply(started.map((l) => ({ key: l.key, qty: 0 })), 'set');
    return { done: [...result.done, ...r2.done], failed: [...result.failed, ...r2.failed] };
  }

  // Back-compat for the original sell/undo calls.
  adjust(lines, direction = -1) {
    return this.apply(lines, direction < 0 ? 'sold' : 'received');
  }
}

module.exports = { StockService, StockError, validateLines, MODES };
