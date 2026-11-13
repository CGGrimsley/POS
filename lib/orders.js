'use strict';

// Website orders for one day, so the Today screen can show online sales
// next to what was sold in the showroom. Read only: nothing here changes
// an order.

// Orders that took stock and count as sales. Refunded orders are listed
// but not counted.
const SALE_STATUSES = ['processing', 'completed', 'on-hold'];
const LISTED_STATUSES = [...SALE_STATUSES, 'refunded'];

// Start and end of a laptop-local day, as UTC times for the store.
function dayRange(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  if (!y || !m || !d) throw Object.assign(new Error('Pick a date.'), { status: 400 });
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { after: start.toISOString().slice(0, 19), before: end.toISOString().slice(0, 19) };
}

function toOrder(o) {
  const lines = (o.line_items || []).map((l) => ({
    key: l.variation_id ? `${l.product_id}:${l.variation_id}` : String(l.product_id),
    name: l.name,
    sku: l.sku || '',
    qty: Number(l.quantity) || 0,
    total: Number(l.total) || 0, // after discounts, before tax
  }));
  return {
    id: o.id,
    number: String(o.number || o.id),
    status: o.status,
    counted: SALE_STATUSES.includes(o.status),
    at: o.date_created_gmt ? o.date_created_gmt + 'Z' : o.date_created,
    total: Number(o.total) || 0,
    tax: Number(o.total_tax) || 0,
    shipping: Number(o.shipping_total) || 0,
    lines,
  };
}

async function ordersForDay(woo, dayStr) {
  const { after, before } = dayRange(dayStr);
  const raw = await woo.getAll('/orders', {
    after, before, dates_are_gmt: 'true',
    status: LISTED_STATUSES.join(','),
    orderby: 'date', order: 'asc',
    _fields: 'id,number,status,date_created,date_created_gmt,total,total_tax,shipping_total,line_items',
  });
  return raw.map(toOrder);
}

module.exports = { ordersForDay, dayRange, toOrder, SALE_STATUSES };
