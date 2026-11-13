'use strict';

(() => {
  const TOKEN = document.querySelector('meta[name="pos-token"]').content;
  const $ = (sel) => document.querySelector(sel);
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const fmt = (n) => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let status = null;
  let results = [];
  let active = 0;
  let cart = loadCart(); // [{ key, name, sku, price, qty, stockQty }]
  let busy = false;

  // ---------- helpers ----------
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'X-POS-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
    return n;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 8000 : 2500);
  }

  function saveCart() { try { localStorage.setItem('pos-cart', JSON.stringify(cart)); } catch { /* ignore */ } }
  function loadCart() { try { return JSON.parse(localStorage.getItem('pos-cart')) || []; } catch { return []; } }

  function stockLabel(it) {
    if (!it.manageStock) return el('span', { class: 'muted' }, 'Stock not tracked');
    const q = it.stockQty;
    return el('span', { class: q <= 0 ? 'stock-out' : q <= 3 ? 'stock-low' : 'stock-ok' }, `${q} in stock`);
  }

  function priceLabel(it) {
    if (it.regularPrice && it.regularPrice > it.price) {
      return el('span', {}, el('s', { class: 'muted' }, fmt(it.regularPrice)), ' ', el('strong', {}, fmt(it.price)));
    }
    return el('strong', {}, fmt(it.price));
  }

  // ---------- status ----------
  async function refreshStatus() {
    try {
      status = await api('GET', '/api/status');
    } catch (e) {
      $('#catalog-status').textContent = e.message;
      return;
    }
    const s = $('#catalog-status');
    if (!status.configured) {
      s.textContent = 'Not set up yet. Open Settings.';
      openSettings();
    } else if (status.catalog && status.catalog.loading && !status.catalog.count) {
      s.textContent = 'Loading products from the website...';
      setTimeout(refreshStatus, 1500);
    } else if (status.catalog && status.catalog.error && !status.catalog.count) {
      s.textContent = 'Could not load products: ' + status.catalog.error;
    } else if (status.catalog) {
      const t = status.catalog.loadedAt ? new Date(status.catalog.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      s.textContent = `${status.register} · ${status.catalog.count} products · updated ${t}`;
    }
    renderCart();
  }

  // ---------- search ----------
  let searchSeq = 0;
  async function doSearch() {
    const q = $('#search').value.trim();
    const seq = ++searchSeq;
    if (!q) { results = []; renderResults(); return; }
    try {
      const data = await api('GET', '/api/search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      results = data.results;
      active = 0;
      renderResults();
    } catch (e) {
      if (seq === searchSeq) { results = []; renderResults(e.message); }
    }
  }

  function renderResults(error) {
    const box = $('#results');
    box.replaceChildren();
    const q = $('#search').value.trim();
    if (q.toLowerCase().replace(/\s+/g, ' ') === 'gay dog') {
      box.append(el('div', { class: 'easter' }, el('img', { src: '/img/good-dog.jpg', alt: 'A happy corgi in a rainbow bandana' })));
      return;
    }
    if (error) { box.append(el('div', { class: 'empty' }, error)); return; }
    if (!q) { box.append(el('div', { class: 'empty' }, 'Type to search, or scan a barcode. Use the arrow keys and Enter to add the highlighted item.')); return; }
    if (!results.length) {
      const looksLikeCode = /^[A-Za-z0-9-_.]{4,}$/.test(q) && /\d/.test(q);
      box.append(el('div', { class: 'empty' }, `Nothing matches "${q}". `,
        el('button', { class: 'small', onclick: () => openNewProduct(looksLikeCode ? q : '') }, 'Add a new product')));
      return;
    }
    results.forEach((it, i) => {
      box.append(el('button', { class: 'result' + (i === active ? ' active' : ''), onclick: () => addToCart(it), title: it.name },
        it.image ? el('img', { src: it.image, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg' }),
        el('div', {},
          el('div', { class: 'name' }, it.name),
          el('div', { class: 'meta' }, priceLabel(it), stockLabel(it)),
          it.sku ? el('div', { class: 'muted small' }, it.sku) : null,
          it.status !== 'publish' ? el('div', { class: 'stock-low small' }, 'Hidden on the website') : null)));
    });
  }

  // ---------- modes ----------
  const MODES = {
    sold: { tab: 'Sold', button: 'Take off website stock', title: 'Take these off website stock?', qtyHead: 'Qty', done: 'Website stock updated' },
    received: { tab: 'Received', button: 'Add to website stock', title: 'Add these to website stock?', qtyHead: 'Adding', done: 'Stock added' },
    set: { tab: 'Set count', button: 'Set website counts', title: 'Set these website counts?', qtyHead: 'New count', done: 'Counts set' },
  };
  let mode = (() => { try { return MODES[localStorage.getItem('pos-mode')] ? localStorage.getItem('pos-mode') : 'sold'; } catch { return 'sold'; } })();

  function setMode(m) {
    if (!MODES[m] || m === mode) return;
    mode = m;
    try { localStorage.setItem('pos-mode', m); } catch { /* ignore */ }
    if (m === 'set') for (const l of cart) l.qty = Math.max(0, Number(l.stockQty) || 0);
    else for (const l of cart) if (l.qty < 1) l.qty = 1;
    saveCart();
    renderCart();
  }

  function stockAfter(l) {
    const before = l.manageStock === false ? 0 : Number(l.stockQty) || 0;
    if (mode === 'set') return l.qty;
    if (mode === 'received') return before + l.qty;
    return before - l.qty;
  }

  function addToCart(it) {
    if (!it.manageStock && mode === 'sold') {
      toast(`The website does not keep a stock count for "${it.name}". Switch to Received or Set count to start one.`, true);
      return;
    }
    const existing = cart.find((l) => l.key === it.key);
    if (existing) existing.qty += 1;
    else {
      const qty = mode === 'set' ? Math.max(0, Number(it.stockQty) || 0) : 1;
      cart.push({ key: it.key, name: it.name, sku: it.sku, price: it.price, qty, stockQty: it.stockQty, manageStock: it.manageStock });
    }
    saveCart();
    renderCart();
    $('#search').select();
    toast(`Added ${it.name}`);
  }

  // ---------- list ----------
  function totals() {
    const sub = round2(cart.reduce((s, l) => s + Number(l.price || 0) * l.qty, 0));
    const rate = status && status.settings ? Number(status.settings.taxRate) || 0 : 0;
    const tax = round2(sub * rate);
    return { sub, tax, rate, total: round2(sub + tax) };
  }

  function setQty(l, v) {
    const min = mode === 'set' ? 0 : 1;
    l.qty = Math.min(9999, Math.max(min, Math.floor(Number(v) || 0)));
    saveCart();
    renderCart();
  }

  function renderCart() {
    document.querySelectorAll('#modes button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.mode === mode);
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    document.body.dataset.mode = mode;
    const box = $('#cart-lines');
    box.replaceChildren();
    if (!cart.length) {
      box.append(el('div', { class: 'empty' }, {
        sold: 'Nothing added yet.',
        received: 'Add what came in. Each quantity is added to the website count.',
        set: 'Add items you counted. Each number becomes the new website count.',
      }[mode]));
    }
    cart.forEach((l, i) => {
      const after = stockAfter(l);
      let note = null;
      if (mode === 'sold' && after < 0) note = el('div', { class: 'warn' }, `The website shows ${l.stockQty} in stock. This will take it to ${after}.`);
      else if (mode !== 'sold' && l.manageStock === false) note = el('div', { class: 'info' }, `The website doesn't count stock for this yet. It will start at ${after}.`);
      else if (mode !== 'sold') note = el('div', { class: 'info' }, `Website count: ${l.stockQty} → ${after}`);
      box.append(el('div', { class: 'line' },
        el('div', {}, el('div', { class: 'lname' }, l.name), el('div', { class: 'lsku' }, [l.sku, `${fmt(l.price)} each`].filter(Boolean).join(' · '))),
        el('div', { class: 'ltotal' }, mode === 'sold' ? fmt(l.price * l.qty) : ''),
        el('div', { class: 'controls' },
          el('button', { class: 'small', 'aria-label': 'One fewer', onclick: () => setQty(l, l.qty - 1) }, '−'),
          el('input', { class: 'qty', type: 'number', min: mode === 'set' ? 0 : 1, max: 9999, step: 1, value: l.qty, 'aria-label': MODES[mode].qtyHead, onchange: (e) => setQty(l, e.target.value) }),
          el('button', { class: 'small', 'aria-label': 'One more', onclick: () => setQty(l, l.qty + 1) }, '+'),
          el('button', { class: 'small ghost rm', onclick: () => { cart.splice(i, 1); saveCart(); renderCart(); } }, 'Remove')),
        note));
    });
    const t = totals();
    $('#totals').hidden = mode !== 'sold';
    $('#t-sub').textContent = fmt(t.sub);
    $('#t-tax').textContent = fmt(t.tax);
    $('#t-tax-label').textContent = t.rate ? `Sales tax ${round2(t.rate * 100)}%` : 'Sales tax';
    $('#t-total').textContent = fmt(t.total);
    const btn = $('#btn-sell');
    btn.textContent = MODES[mode].button;
    btn.disabled = busy || !cart.length || !(status && status.configured);
  }

  // ---------- apply ----------
  function openConfirm() {
    if (!cart.length) return;
    $('#confirm-error').hidden = true;
    $('#confirm-title').textContent = MODES[mode].title;
    $('#confirm-body').replaceChildren(
      el('table', { class: 'list' },
        el('tr', {}, el('th', {}, 'Item'), el('th', { class: 'num' }, MODES[mode].qtyHead), el('th', { class: 'num' }, 'Stock after')),
        cart.map((l) => el('tr', {}, el('td', {}, l.name), el('td', { class: 'num' }, l.qty), el('td', { class: 'num' }, stockAfter(l))))),
      el('p', { class: 'muted small' }, mode === 'set'
        ? 'The website count becomes exactly the number shown.'
        : 'Stock after is based on the last refresh. The website count is checked again when you confirm.'));
    $('#confirm-yes').disabled = false;
    $('#dlg-confirm').showModal();
    $('#confirm-yes').focus();
  }

  async function applyStock() {
    if (busy) return;
    busy = true;
    const btn = $('#confirm-yes');
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      const r = await api('POST', '/api/adjust', { mode, lines: cart.map((l) => ({ key: l.key, qty: l.qty })) });
      const doneKeys = new Set(r.done.map((d) => d.key));
      cart = cart.filter((l) => !doneKeys.has(l.key));
      saveCart();
      if (r.failed.length) {
        const e = $('#confirm-error');
        e.textContent = 'These were NOT updated and are still in the list:\n' + r.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
        e.hidden = false;
        if (r.done.length) toast(`Updated ${r.done.length} item(s). Some failed, see the message.`, true);
      } else {
        $('#dlg-confirm').close();
        toast(`${MODES[mode].done} for ${r.done.length} item(s).`);
        $('#search').value = '';
      }
    } catch (e) {
      const box = $('#confirm-error');
      box.textContent = e.message + '\nNothing was changed. You can try again.';
      box.hidden = false;
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Yes, update stock';
      renderCart();
      doSearch();
      refreshStatus();
    }
  }

  // ---------- today ----------
  const ENTRY_LABEL = { sold: 'Sold', received: 'Received', set: 'Count set', new: 'New product' };
  function entryText(s) {
    const kind = s.type === 'new' ? 'new' : (s.mode || 'sold');
    return s.lines.map((l) => {
      if (kind === 'set') return `${l.name}: ${l.before ?? 'untracked'} → ${l.after}`;
      if (kind === 'new') return `${l.name} (${l.after} in stock)`;
      return `${l.qty} x ${l.name} (now ${l.after})`;
    }).join(', ');
  }

  async function openToday() {
    const dlg = $('#dlg-today');
    const body = $('#today-body');
    body.replaceChildren(el('p', { class: 'muted' }, 'Loading...'));
    if (!dlg.open) dlg.showModal();
    try {
      const { sales } = await api('GET', '/api/sales/today');
      if (!sales.length) { body.replaceChildren(el('p', { class: 'muted' }, 'Nothing recorded on this laptop today.')); return; }
      const live = sales.filter((s) => !s.undone && s.type !== 'new' && (s.mode || 'sold') === 'sold');
      const units = live.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.qty, 0), 0);
      body.replaceChildren(
        el('p', {}, `${live.length} sale(s), ${units} item(s) taken off website stock today.`),
        el('table', { class: 'list' },
          el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'What'), el('th', {}, 'Items'), el('th', {}, '')),
          sales.map((s) => el('tr', { class: s.undone ? 'undone' : '' },
            el('td', {}, new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
            el('td', {}, ENTRY_LABEL[s.type === 'new' ? 'new' : (s.mode || 'sold')]),
            el('td', {}, entryText(s)),
            el('td', {}, s.type === 'new' ? null : s.undone ? el('span', { class: 'muted' }, 'Undone')
              : el('button', { class: 'small ghost', onclick: () => undo(s) }, 'Undo'))))),
        el('p', { class: 'muted small' }, 'Undo reverses a stock change, for a return or a mistake. To remove a new product, delete it in WordPress.'));
    } catch (e) {
      body.replaceChildren(el('p', { class: 'error' }, e.message));
    }
  }

  async function undo(s) {
    const kind = s.mode || 'sold';
    const q = { sold: 'Put these items back on website stock?', received: 'Take this stock back off the website?', set: 'Put these counts back to what they were?' }[kind];
    if (!confirm(q + '\n\n' + entryText(s).split(', ').join('\n'))) return;
    try {
      const r = await api('POST', '/api/undo', { id: s.id });
      if (r.failed.length) toast('Some items could not be undone: ' + r.failed.map((f) => f.name).join(', '), true);
      else toast('Undone.');
    } catch (e) {
      toast(e.message, true);
    }
    openToday();
    doSearch();
  }

  // ---------- new product ----------
  let categoriesLoaded = false;
  async function openNewProduct(prefillSku) {
    const f = $('#product-form');
    f.reset();
    $('#product-msg').hidden = true;
    if (prefillSku) f.sku.value = prefillSku;
    $('#dlg-product').showModal();
    f.name.focus();
    if (!categoriesLoaded) {
      try {
        const { categories } = await api('GET', '/api/categories');
        const sel = f.category;
        sel.replaceChildren(el('option', { value: '' }, 'No category'), ...categories.map((c) => el('option', { value: c.id }, c.name)));
        categoriesLoaded = true;
      } catch (e) {
        f.category.replaceChildren(el('option', { value: '' }, 'Could not load categories'));
      }
    }
  }

  async function saveProduct(ev) {
    ev.preventDefault();
    const f = ev.target;
    const msg = $('#product-msg');
    msg.hidden = true;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const out = await api('POST', '/api/products', {
        name: f.name.value, price: f.price.value, sku: f.sku.value, qty: f.qty.value || 0,
        categoryIds: f.category.value ? [Number(f.category.value)] : [],
        description: f.description.value,
        status: f.publish.checked ? 'publish' : 'draft',
      });
      $('#dlg-product').close();
      toast(`${out.item.name} added to the website${out.item.status === 'publish' ? '' : ' as a draft'}.`);
      $('#search').value = out.item.sku || out.item.name;
      doSearch();
      refreshStatus();
    } catch (e) {
      msg.textContent = e.message;
      msg.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- settings ----------
  function openSettings() {
    const dlg = $('#dlg-settings');
    if (dlg.open) return;
    const f = $('#settings-form');
    const s = (status && status.settings) || {};
    f.storeUrl.value = s.storeUrl || 'https://brushbeater.store';
    f.consumerKey.value = '';
    f.consumerSecret.value = '';
    f.consumerKey.placeholder = s.consumerKeySet ? 'Saved (leave blank to keep)' : 'ck_...';
    f.consumerSecret.placeholder = s.consumerSecretSet ? 'Saved (leave blank to keep)' : 'cs_...';
    f.register.value = s.register || '';
    f.taxRate.value = s.taxRate ?? 0.0675;
    $('#settings-msg').hidden = true;
    dlg.showModal();
  }

  async function saveSettings(ev) {
    ev.preventDefault();
    const f = ev.target;
    const msg = $('#settings-msg');
    msg.hidden = true;
    const body = {
      storeUrl: f.storeUrl.value.trim(),
      register: f.register.value.trim() || 'Counter laptop',
      taxRate: Number(f.taxRate.value || 0),
    };
    if (f.consumerKey.value.trim()) body.consumerKey = f.consumerKey.value.trim();
    if (f.consumerSecret.value.trim()) body.consumerSecret = f.consumerSecret.value.trim();
    try {
      const out = await api('POST', '/api/settings', body);
      if (!out.ok) { msg.textContent = out.problems.join('\n'); msg.hidden = false; await refreshStatus(); return; }
      $('#dlg-settings').close();
      toast('Settings saved. Loading products...');
      await refreshStatus();
    } catch (e) {
      msg.textContent = e.message;
      msg.hidden = false;
    }
  }

  // ---------- wiring ----------
  const search = $('#search');
  let debounce;
  search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(doSearch, 120); });
  search.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const keep = active;
      await doSearch(); // a barcode scanner types fast and presses Enter
      active = Math.min(keep, Math.max(0, results.length - 1));
      if (results[active]) addToCart(results[active]);
    } else if (e.key === 'Escape') {
      search.value = '';
      doSearch();
    }
  });

  $('#btn-sell').addEventListener('click', openConfirm);
  $('#confirm-yes').addEventListener('click', applyStock);
  document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-new').addEventListener('click', () => openNewProduct(''));
  $('#product-form').addEventListener('submit', saveProduct);
  $('#confirm-no').addEventListener('click', () => $('#dlg-confirm').close());
  $('#dlg-confirm').addEventListener('close', () => search.focus());
  $('#btn-clear').addEventListener('click', () => { if (cart.length && confirm('Clear the list?')) { cart = []; saveCart(); renderCart(); } });
  $('#btn-today').addEventListener('click', openToday);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#btn-refresh').addEventListener('click', async () => {
    toast('Reloading products from the website...');
    try { const r = await api('POST', '/api/catalog/refresh'); toast(`${r.count} products loaded.`); } catch (e) { toast(e.message, true); }
    refreshStatus();
    doSearch();
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  renderResults();
  refreshStatus();
  setInterval(refreshStatus, 60000);
  search.focus();
})();
