const API_BASE = '/api';

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function money(x) {
  return x == null ? '—' : `${Number(x).toFixed(2)} €`;
}

function fmtDt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString();
}

function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function auth() {
  try { return JSON.parse(localStorage.getItem('auth') || 'null'); } catch { return null; }
}

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const a = auth();
  const headers = {};
  if (a) headers.Authorization = `Token ${a.token}`;
  let payload;
  if (body !== undefined) {
    if (isForm) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const bodyText = res.status === 204 ? null : await res.text();
  let data = null;
  if (bodyText) {
    try { data = JSON.parse(bodyText); } catch { data = bodyText; }
  }
  if (!res.ok) throw Object.assign(new Error('api error'), { status: res.status, body: data });
  return data;
}

function apiErrorText(err) {
  if (!err.body) return err.message;
  if (typeof err.body === 'string') return err.body;
  if (err.body.errors) {
    return Object.entries(err.body.errors).map(([f, m]) => `${f}: ${m}`).join('; ');
  }
  if (err.body.detail) return err.body.detail;
  return err.message;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('adm-toast');
  el.textContent = msg;
  el.className = isError ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

const state = { categories: [], products: [], coupons: [], orders: [], reviews: [], users: [] };
let editingProductId = null;
let editingCouponId = null;

// ---------- boot / auth gate ----------

async function boot() {
  const a = auth();
  const gate = document.getElementById('adm-gate');
  const appEl = document.getElementById('adm-app');
  if (!a || !a.token) { gate.hidden = false; appEl.hidden = true; return; }
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    gate.hidden = false; appEl.hidden = true; return;
  }
  if (!me || !me.is_staff) { gate.hidden = false; appEl.hidden = true; return; }
  document.getElementById('adm-who').textContent = me.email;
  gate.hidden = true;
  appEl.hidden = false;
  bindAll();
  switchPanel('products');
}

document.getElementById('adm-logout').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem('auth');
  location.reload();
});

const loaders = {
  products: loadProducts,
  categories: loadCategories,
  coupons: loadCoupons,
  orders: loadOrders,
  reviews: loadReviews,
  users: loadUsers,
};

function switchPanel(name) {
  document.querySelectorAll('.adm-nav button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.adm-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  loaders[name]();
}

function bindAll() {
  document.querySelectorAll('.adm-nav button').forEach((btn) => {
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
  });
  bindProductsPanel();
  bindCategoriesPanel();
  bindCouponsPanel();
  bindOrdersPanel();
  bindReviewsPanel();
  bindUsersPanel();
}

// ---------- products ----------

function categoryIdOf(p) {
  if (p.category && typeof p.category === 'object') return p.category.id;
  if (typeof p.category === 'number') return p.category;
  return p.category_id ?? null;
}

function categoryNameOf(p) {
  if (p.category && typeof p.category === 'object') return p.category.name;
  const id = categoryIdOf(p);
  const c = state.categories.find((c) => c.id === id);
  return c ? c.name : '';
}

async function loadProducts() {
  try {
    const [products, categories] = await Promise.all([
      api('/admin/products'),
      api('/admin/categories'),
    ]);
    state.products = products;
    state.categories = categories;
    renderProductCategoryFilter();
    renderProductsTable();
  } catch (e) {
    toast(`failed to load products: ${apiErrorText(e)}`, true);
  }
}

function renderProductCategoryFilter() {
  const sel = document.getElementById('prod-cat-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">all categories</option>' +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = cur;
}

function renderProductsTable() {
  const q = document.getElementById('prod-search').value.trim().toLowerCase();
  const catFilter = document.getElementById('prod-cat-filter').value;
  const rows = state.products.filter((p) => {
    if (q && !`${p.name} ${p.slug}`.toLowerCase().includes(q)) return false;
    if (catFilter && String(categoryIdOf(p)) !== catFilter) return false;
    return true;
  });
  const tbody = document.getElementById('prod-tbody');
  tbody.innerHTML = rows.map((p) => `
    <tr data-id="${p.id}">
      <td>${esc(p.name)}</td>
      <td class="muted">${esc(p.slug)}</td>
      <td>${esc(categoryNameOf(p) || '—')}</td>
      <td class="num"><input class="cell" type="number" step="0.01" min="0" data-field="price" value="${esc(p.price)}"></td>
      <td class="num"><input class="cell" type="number" step="1" min="0" data-field="stock" value="${esc(p.stock)}"></td>
      <td class="center"><input type="checkbox" data-field="is_active" ${p.is_active ? 'checked' : ''}></td>
      <td class="actions">
        <button type="button" class="secondary small" data-act="edit">edit</button>
        <button type="button" class="danger small" data-act="del">delete</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="muted">no products</td></tr>`;

  tbody.querySelectorAll('input[data-field]').forEach((input) => {
    const evt = input.type === 'checkbox' ? 'change' : 'blur';
    input.addEventListener(evt, () => patchProductCell(input));
  });
  tbody.querySelectorAll('[data-act="edit"]').forEach((btn) => btn.addEventListener('click', (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    openProductForm(state.products.find((p) => p.id === id));
  }));
  tbody.querySelectorAll('[data-act="del"]').forEach((btn) => btn.addEventListener('click', async (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    if (!confirm('delete this product?')) return;
    try {
      await api(`/admin/products/${id}`, { method: 'DELETE' });
      toast('product deleted');
      loadProducts();
    } catch (err) { toast(apiErrorText(err), true); }
  }));
}

async function patchProductCell(input) {
  const id = Number(input.closest('tr').dataset.id);
  const field = input.dataset.field;
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (field === 'stock') value = Number(input.value);
  else value = input.value.trim();
  try {
    const updated = await api(`/admin/products/${id}`, { method: 'PATCH', body: { [field]: value } });
    const idx = state.products.findIndex((p) => p.id === id);
    if (idx >= 0) state.products[idx] = updated ?? Object.assign({}, state.products[idx], { [field]: value });
    toast('saved');
  } catch (err) {
    toast(`save failed: ${apiErrorText(err)}`, true);
  }
}

function renderProductCategoryOptions(select, selectedId) {
  select.innerHTML = '<option value="">—</option>' +
    state.categories.map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderProductImages(images) {
  const grid = document.getElementById('product-images-grid');
  grid.innerHTML = (images || []).map((img) => `
    <div class="thumb" data-id="${img.id}">
      <img src="${esc(img.url)}" alt="${esc(img.alt_text || '')}">
      <button type="button" class="danger" data-act="del-img" title="delete image">×</button>
    </div>
  `).join('') || '<p class="muted">no images yet</p>';
  grid.querySelectorAll('[data-act="del-img"]').forEach((btn) => btn.addEventListener('click', async (e) => {
    const thumb = e.target.closest('.thumb');
    const imgId = thumb.dataset.id;
    if (!confirm('delete this image?')) return;
    try {
      await api(`/admin/products/${editingProductId}/images/${imgId}`, { method: 'DELETE' });
      thumb.remove();
      const p = state.products.find((p) => p.id === editingProductId);
      if (p) p.images = (p.images || []).filter((i) => String(i.id) !== String(imgId));
      toast('image deleted');
    } catch (err) { toast(apiErrorText(err), true); }
  }));
}

function openProductForm(product) {
  editingProductId = product ? product.id : null;
  document.getElementById('product-modal-title').textContent = product ? `edit: ${product.name}` : 'new product';
  const form = document.getElementById('product-form');
  form.reset();
  renderProductCategoryOptions(form.category_id, product ? categoryIdOf(product) : '');
  if (product) {
    form.name.value = product.name || '';
    form.slug.value = product.slug || '';
    form.description.value = product.description || '';
    form.price.value = product.price ?? '';
    form.stock.value = product.stock ?? 0;
    form.is_active.checked = !!product.is_active;
  } else {
    form.is_active.checked = true;
  }
  const imgSection = document.getElementById('product-images-section');
  imgSection.hidden = !product;
  if (product) renderProductImages(product.images);
  document.getElementById('product-modal').hidden = false;
}

function bindProductsPanel() {
  document.getElementById('prod-search').addEventListener('input', renderProductsTable);
  document.getElementById('prod-cat-filter').addEventListener('change', renderProductsTable);
  document.getElementById('prod-new-btn').addEventListener('click', () => openProductForm(null));
  document.getElementById('product-modal-close').addEventListener('click', () => {
    document.getElementById('product-modal').hidden = true;
    loadProducts();
  });

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim(),
      description: form.description.value,
      price: form.price.value,
      stock: Number(form.stock.value),
      is_active: form.is_active.checked,
      category_id: form.category_id.value ? Number(form.category_id.value) : null,
    };
    if (form.slug.value.trim()) payload.slug = form.slug.value.trim();
    try {
      if (editingProductId) {
        await api(`/admin/products/${editingProductId}`, { method: 'PATCH', body: payload });
        toast('product saved');
        await loadProducts();
      } else {
        const created = await api('/admin/products', { method: 'POST', body: payload });
        toast('product created');
        editingProductId = created.id;
        document.getElementById('product-modal-title').textContent = `edit: ${created.name}`;
        document.getElementById('product-images-section').hidden = false;
        renderProductImages(created.images);
        await loadProducts();
      }
    } catch (err) {
      toast(`save failed: ${apiErrorText(err)}`, true);
    }
  });

  document.getElementById('product-image-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editingProductId) return;
    const form = e.target;
    const file = form.image.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    if (form.alt_text.value) fd.append('alt_text', form.alt_text.value);
    try {
      const img = await api(`/admin/products/${editingProductId}/images`, { method: 'POST', body: fd, isForm: true });
      form.reset();
      const p = state.products.find((p) => p.id === editingProductId);
      const images = ((p && p.images) || []).concat(img);
      if (p) p.images = images;
      renderProductImages(images);
      toast('image uploaded');
    } catch (err) {
      toast(`upload failed: ${apiErrorText(err)}`, true);
    }
  });
}

// ---------- categories ----------

async function loadCategories() {
  try {
    state.categories = await api('/admin/categories');
    renderCategoriesTable();
  } catch (e) {
    toast(`failed to load categories: ${apiErrorText(e)}`, true);
  }
}

function renderCategoriesTable() {
  const tbody = document.getElementById('cat-tbody');
  tbody.innerHTML = state.categories.map((c) => `
    <tr data-id="${c.id}">
      <td>${esc(c.name)}</td>
      <td class="muted">${esc(c.slug)}</td>
      <td class="actions"><button type="button" class="danger small" data-act="del">delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="3" class="muted">no categories</td></tr>';

  tbody.querySelectorAll('[data-act="del"]').forEach((btn) => btn.addEventListener('click', async (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    if (!confirm('delete this category?')) return;
    try {
      await api(`/admin/categories/${id}`, { method: 'DELETE' });
      toast('category deleted');
      loadCategories();
    } catch (err) { toast(apiErrorText(err), true); }
  }));
}

function bindCategoriesPanel() {
  document.getElementById('cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = { name: form.name.value.trim() };
    if (form.slug.value.trim()) payload.slug = form.slug.value.trim();
    try {
      await api('/admin/categories', { method: 'POST', body: payload });
      form.reset();
      toast('category created');
      loadCategories();
    } catch (err) { toast(`create failed: ${apiErrorText(err)}`, true); }
  });
}

// ---------- coupons ----------

async function loadCoupons() {
  try {
    state.coupons = await api('/admin/coupons');
    renderCouponsTable();
  } catch (e) {
    toast(`failed to load coupons: ${apiErrorText(e)}`, true);
  }
}

function renderCouponsTable() {
  const tbody = document.getElementById('coupon-tbody');
  tbody.innerHTML = state.coupons.map((c) => `
    <tr data-id="${c.id}">
      <td>${esc(c.code)}</td>
      <td>${esc(c.discount_type)}</td>
      <td class="num">${c.discount_type === 'percent' ? `${esc(c.value)}%` : money(c.value)}</td>
      <td class="center">${c.is_active ? 'yes' : 'no'}</td>
      <td class="muted">${fmtDt(c.valid_from)} → ${fmtDt(c.valid_to)}</td>
      <td class="actions">
        <button type="button" class="secondary small" data-act="edit">edit</button>
        <button type="button" class="danger small" data-act="del">delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="muted">no coupons</td></tr>';

  tbody.querySelectorAll('[data-act="edit"]').forEach((btn) => btn.addEventListener('click', (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    openCouponForm(state.coupons.find((c) => c.id === id));
  }));
  tbody.querySelectorAll('[data-act="del"]').forEach((btn) => btn.addEventListener('click', async (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    if (!confirm('delete this coupon?')) return;
    try {
      await api(`/admin/coupons/${id}`, { method: 'DELETE' });
      toast('coupon deleted');
      loadCoupons();
    } catch (err) { toast(apiErrorText(err), true); }
  }));
}

function openCouponForm(coupon) {
  editingCouponId = coupon ? coupon.id : null;
  document.getElementById('coupon-modal-title').textContent = coupon ? `edit: ${coupon.code}` : 'new coupon';
  const form = document.getElementById('coupon-form');
  form.reset();
  if (coupon) {
    form.code.value = coupon.code;
    form.discount_type.value = coupon.discount_type;
    form.value.value = coupon.value;
    form.is_active.checked = !!coupon.is_active;
    form.valid_from.value = toDatetimeLocal(coupon.valid_from);
    form.valid_to.value = toDatetimeLocal(coupon.valid_to);
  } else {
    form.is_active.checked = true;
  }
  document.getElementById('coupon-modal').hidden = false;
}

function bindCouponsPanel() {
  document.getElementById('coupon-new-btn').addEventListener('click', () => openCouponForm(null));
  document.getElementById('coupon-modal-close').addEventListener('click', () => {
    document.getElementById('coupon-modal').hidden = true;
  });
  document.getElementById('coupon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      code: form.code.value.trim(),
      discount_type: form.discount_type.value,
      value: form.value.value,
      is_active: form.is_active.checked,
      valid_from: form.valid_from.value ? new Date(form.valid_from.value).toISOString() : null,
      valid_to: form.valid_to.value ? new Date(form.valid_to.value).toISOString() : null,
    };
    try {
      if (editingCouponId) {
        await api(`/admin/coupons/${editingCouponId}`, { method: 'PATCH', body: payload });
      } else {
        await api('/admin/coupons', { method: 'POST', body: payload });
      }
      toast('coupon saved');
      document.getElementById('coupon-modal').hidden = true;
      loadCoupons();
    } catch (err) {
      toast(`save failed: ${apiErrorText(err)}`, true);
    }
  });
}

// ---------- orders ----------

async function loadOrders() {
  try {
    state.orders = await api('/admin/orders');
    renderOrdersTable();
  } catch (e) {
    toast(`failed to load orders: ${apiErrorText(e)}`, true);
  }
}

function renderOrdersTable() {
  const statusF = document.getElementById('order-status-filter').value;
  const q = document.getElementById('order-search').value.trim().toLowerCase();
  const rows = state.orders.filter((o) => {
    if (statusF && o.status !== statusF) return false;
    if (q && !`${o.id} ${o.email} ${o.user_email || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const tbody = document.getElementById('order-tbody');
  tbody.innerHTML = rows.map((o) => `
    <tr data-id="${esc(o.id)}" class="clickable">
      <td class="center"><input type="checkbox" class="order-check"></td>
      <td class="muted">${esc(o.id)}</td>
      <td><span class="status-pill status-${esc(o.status)}">${esc(o.status)}</span></td>
      <td>${esc(o.email)}</td>
      <td>${esc(o.user_email || '—')}</td>
      <td class="num">${money(o.total)}</td>
      <td class="muted">${fmtDt(o.created_at)}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="muted">no orders</td></tr>';

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      openOrderDetail(state.orders.find((o) => String(o.id) === tr.dataset.id));
    });
    tr.querySelector('.order-check').addEventListener('change', updateBulkShipButton);
  });
  updateBulkShipButton();
}

function updateBulkShipButton() {
  document.getElementById('order-bulk-ship-btn').disabled = !document.querySelector('.order-check:checked');
}

function openOrderDetail(order) {
  if (!order) return;
  const items = (order.items || []).map((it) => {
    const lt = it.line_total != null ? it.line_total : (Number(it.price) * it.quantity).toFixed(2);
    return `<tr><td>${esc(it.product_name)}</td><td class="num">${money(it.price)}</td><td class="num">${it.quantity}</td><td class="num">${money(lt)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">no items</td></tr>';

  const payment = order.payment
    ? `${esc(order.payment.provider)} · ${esc(order.payment.transaction_id)} · ${money(order.payment.amount)}`
    : '—';

  document.getElementById('order-detail-body').innerHTML = `
    <h3>order ${esc(order.id)} <span class="status-pill status-${esc(order.status)}">${esc(order.status)}</span></h3>
    <div class="row" style="margin-top:1rem">
      <div>
        <h3>contact</h3>
        <p>${esc(order.email)}${order.user_email ? `<br><span class="muted">user: ${esc(order.user_email)}</span>` : ''}</p>
        <h3>shipping</h3>
        <p>${esc(order.full_name || '')}<br>${esc(order.street || '')}<br>${esc(order.city || '')} ${esc(order.zip_code || '')}<br>${esc(order.country || '')}</p>
      </div>
      <div>
        <h3>payment</h3>
        <p>${payment}</p>
        <h3>totals</h3>
        <div class="totals">
          <div><span>subtotal</span><span>${money(order.subtotal)}</span></div>
          <div><span>discount${order.coupon_code ? ` (${esc(order.coupon_code)})` : ''}</span><span>-${money(order.discount_amount || 0)}</span></div>
          <div class="grand"><span>total</span><span>${money(order.total)}</span></div>
        </div>
      </div>
    </div>
    <h3 style="margin-top:1rem">items</h3>
    <table><thead><tr><th>product</th><th class="num">price</th><th class="num">qty</th><th class="num">line total</th></tr></thead><tbody>${items}</tbody></table>
  `;
  document.getElementById('order-detail-modal').hidden = false;
}

function bindOrdersPanel() {
  document.getElementById('order-search').addEventListener('input', renderOrdersTable);
  document.getElementById('order-status-filter').addEventListener('change', renderOrdersTable);
  document.getElementById('order-detail-close').addEventListener('click', () => {
    document.getElementById('order-detail-modal').hidden = true;
  });
  document.getElementById('order-bulk-ship-btn').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('#order-tbody tr[data-id]')]
      .filter((tr) => tr.querySelector('.order-check').checked)
      .map((tr) => tr.dataset.id);
    if (!ids.length) return;
    if (!confirm(`mark ${ids.length} order(s) as shipped?`)) return;
    try {
      await api('/admin/orders/bulk-ship', { method: 'POST', body: { ids } });
      toast('orders marked shipped');
      loadOrders();
    } catch (err) {
      toast(`bulk-ship failed: ${apiErrorText(err)}`, true);
    }
  });
}

// ---------- reviews ----------

function productIdOfReview(r) {
  if (r.product && typeof r.product === 'object') return r.product.id;
  if (typeof r.product === 'number') return r.product;
  return r.product_id ?? null;
}

function productNameOfReview(r) {
  if (r.product && typeof r.product === 'object') return r.product.name;
  const id = productIdOfReview(r);
  const p = state.products.find((p) => p.id === id);
  return p ? p.name : `#${id}`;
}

async function loadReviews() {
  try {
    const [reviews, products] = await Promise.all([api('/admin/reviews'), api('/admin/products')]);
    state.reviews = reviews;
    state.products = products;
    renderReviewProductFilter();
    renderReviewsTable();
  } catch (e) {
    toast(`failed to load reviews: ${apiErrorText(e)}`, true);
  }
}

function renderReviewProductFilter() {
  const sel = document.getElementById('review-product-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">all products</option>' +
    state.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = cur;
}

function renderReviewsTable() {
  const prodF = document.getElementById('review-product-filter').value;
  const ratingF = document.getElementById('review-rating-filter').value;
  const rows = state.reviews.filter((r) => {
    if (prodF && String(productIdOfReview(r)) !== prodF) return false;
    if (ratingF && String(r.rating) !== ratingF) return false;
    return true;
  });
  const tbody = document.getElementById('review-tbody');
  tbody.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>${esc(productNameOfReview(r))}</td>
      <td>${esc(r.author_name)}</td>
      <td class="center">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td>
      <td class="truncate" title="${esc(r.text)}">${esc(r.text)}</td>
      <td class="muted">${fmtDt(r.created_at)}</td>
      <td class="actions"><button type="button" class="danger small" data-act="del">delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="muted">no reviews</td></tr>';

  tbody.querySelectorAll('[data-act="del"]').forEach((btn) => btn.addEventListener('click', async (e) => {
    const id = Number(e.target.closest('tr').dataset.id);
    if (!confirm('delete this review?')) return;
    try {
      await api(`/admin/reviews/${id}`, { method: 'DELETE' });
      toast('review deleted');
      loadReviews();
    } catch (err) { toast(apiErrorText(err), true); }
  }));
}

function bindReviewsPanel() {
  document.getElementById('review-product-filter').addEventListener('change', renderReviewsTable);
  document.getElementById('review-rating-filter').addEventListener('change', renderReviewsTable);
}

// ---------- users ----------

async function loadUsers() {
  try {
    state.users = await api('/admin/users');
    renderUsersTable();
  } catch (e) {
    toast(`failed to load users: ${apiErrorText(e)}`, true);
  }
}

function renderUsersTable() {
  const q = document.getElementById('user-search').value.trim().toLowerCase();
  const rows = state.users.filter((u) => !q || `${u.email} ${u.first_name} ${u.last_name}`.toLowerCase().includes(q));
  const tbody = document.getElementById('user-tbody');
  tbody.innerHTML = rows.map((u) => `
    <tr data-id="${u.id}">
      <td>${esc(u.email)}</td>
      <td>${esc(u.first_name)}</td>
      <td>${esc(u.last_name)}</td>
      <td class="center"><label class="switch"><input type="checkbox" data-field="is_staff" ${u.is_staff ? 'checked' : ''}><span></span></label></td>
      <td class="center"><label class="switch"><input type="checkbox" data-field="is_active" ${u.is_active ? 'checked' : ''}><span></span></label></td>
      <td class="muted">${fmtDt(u.date_joined)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="muted">no users</td></tr>';

  tbody.querySelectorAll('input[data-field]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = Number(input.closest('tr').dataset.id);
      const field = input.dataset.field;
      try {
        await api(`/admin/users/${id}`, { method: 'PATCH', body: { [field]: input.checked } });
        toast('saved');
      } catch (err) {
        input.checked = !input.checked;
        toast(`save failed: ${apiErrorText(err)}`, true);
      }
    });
  });
}

function bindUsersPanel() {
  document.getElementById('user-search').addEventListener('input', renderUsersTable);
}

boot();
