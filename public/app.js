const API_BASE = '/api';

const app = document.getElementById('app');

// ---------- helpers ----------

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function money(x) {
  return `${Number(x).toFixed(2)} €`;
}

function stars(rating) {
  if (rating == null) return '';
  const n = Math.round(rating);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function auth() {
  return JSON.parse(localStorage.getItem('auth') || 'null');
}

async function api(path, options = {}) {
  const a = auth();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(a ? { Authorization: `Token ${a.token}` } : {}),
    },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw Object.assign(new Error('api error'), { status: res.status, body });
  return body;
}

function apiErrorText(err) {
  if (!err.body) return err.message;
  if (typeof err.body === 'string') return err.body;
  if (err.body.errors) {
    return Object.entries(err.body.errors)
      .map(([field, msg]) => `${field}: ${msg}`)
      .join('; ');
  }
  if (err.body.detail) return err.body.detail;
  return err.message;
}

// ---------- cart (localStorage: {productId: quantity}) ----------

const cart = {
  read() { return JSON.parse(localStorage.getItem('cart') || '{}'); },
  write(c) { localStorage.setItem('cart', JSON.stringify(c)); updateCartBadge(); },
  add(id, qty = 1) {
    const c = cart.read();
    c[id] = (c[id] || 0) + qty;
    cart.write(c);
  },
  setQty(id, qty) {
    const c = cart.read();
    if (qty > 0) c[id] = qty; else delete c[id];
    cart.write(c);
  },
  clear() { localStorage.removeItem('cart'); localStorage.removeItem('coupon'); updateCartBadge(); },
  count() { return Object.values(cart.read()).reduce((a, b) => a + b, 0); },
};

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  const n = cart.count();
  badge.textContent = n;
  badge.hidden = n === 0;
}

// ---------- auth state ----------

function setAuth(token, user) {
  localStorage.setItem('auth', JSON.stringify({ token, email: user.email, is_staff: !!user.is_staff }));
  updateNav();
}

function clearAuth() {
  localStorage.removeItem('auth');
  updateNav();
}

function updateNav() {
  const a = auth();
  document.getElementById('nav-account').textContent = a ? a.email : 'login';
  document.getElementById('nav-admin').hidden = !(a && a.is_staff);
}

// refreshes the cached is_staff flag from a fresh /auth/me response, so the
// admin nav link stays correct without forcing every page to re-fetch it
function syncAuthFromMe(me) {
  const a = auth();
  if (!a) return;
  localStorage.setItem('auth', JSON.stringify({ token: a.token, email: me.email, is_staff: !!me.is_staff }));
  updateNav();
}

// ---------- views ----------

async function homeView(categorySlug) {
  const [categories, products] = await Promise.all([
    api('/categories'),
    api(`/products${categorySlug ? `?category=${encodeURIComponent(categorySlug)}` : ''}`),
  ]);

  const chips = [
    `<a class="chip ${!categorySlug ? 'active' : ''}" href="#/">all</a>`,
    ...categories.map(c =>
      `<a class="chip ${c.slug === categorySlug ? 'active' : ''}" href="#/?category=${esc(c.slug)}">${esc(c.name)}</a>`),
  ].join('');

  app.innerHTML = `
    <h1>catalog</h1>
    <div class="chips">${chips}</div>
    <div class="grid">
      ${products.map(p => `
        <div class="card">
          ${p.images[0] ? `<a href="#/product/${esc(p.slug)}"><img src="${esc(p.images[0].url)}" alt="${esc(p.images[0].alt_text)}"></a>` : ''}
          <div class="body">
            <h2><a href="#/product/${esc(p.slug)}">${esc(p.name)}</a></h2>
            ${p.review_count ? `<span class="rating">${stars(p.avg_rating)} (${p.review_count})</span>` : ''}
            <span class="stock ${p.stock ? '' : 'out'}">${p.stock ? `${p.stock} in stock` : 'out of stock'}</span>
            <span class="price">${money(p.price)}</span>
            <button data-add="${p.id}" ${p.stock ? '' : 'disabled'}>add to cart</button>
          </div>
        </div>`).join('')}
    </div>`;

  app.querySelectorAll('[data-add]').forEach(btn =>
    btn.addEventListener('click', () => cart.add(Number(btn.dataset.add))));
}

async function productView(slug) {
  const p = await api(`/products/${encodeURIComponent(slug)}`);
  const reviews = await api(`/reviews?product=${p.id}`);

  app.innerHTML = `
    <div class="detail">
      <div>${p.images.map(img => `<img src="${esc(img.url)}" alt="${esc(img.alt_text)}">`).join('')}</div>
      <div>
        <h1>${esc(p.name)}</h1>
        ${p.category ? `<a class="chip" href="#/?category=${esc(p.category.slug)}">${esc(p.category.name)}</a>` : ''}
        <p class="price">${money(p.price)}</p>
        <span class="stock ${p.stock ? '' : 'out'}">${p.stock ? `${p.stock} in stock` : 'out of stock'}</span>
        <p class="desc">${esc(p.description)}</p>
        <div class="qty-row">
          <input type="number" id="qty" value="1" min="1" max="${p.stock || 1}">
          <button id="add" ${p.stock ? '' : 'disabled'}>add to cart</button>
        </div>
      </div>
    </div>

    <h2>reviews ${p.review_count ? `<span class="rating">${stars(p.avg_rating)}</span>` : ''}</h2>
    <div id="reviews">
      ${reviews.length ? reviews.map(r => `
        <div class="review">
          <div class="head">
            <span><strong>${esc(r.author_name)}</strong> <span class="stars">${stars(r.rating)}</span></span>
            <span>${new Date(r.created_at).toLocaleDateString()}</span>
          </div>
          ${esc(r.text)}
        </div>`).join('') : '<p class="muted">no reviews yet — be the first</p>'}
    </div>

    <h2>write a review</h2>
    <form class="review-form" id="review-form">
      <div class="row">
        <input name="author_name" placeholder="your name" required>
        <select name="rating">
          ${[5, 4, 3, 2, 1].map(n => `<option value="${n}">${'★'.repeat(n)}</option>`).join('')}
        </select>
      </div>
      <textarea name="text" rows="3" placeholder="what did you think?"></textarea>
      <div><button type="submit">post review</button></div>
      <p class="error" id="review-error"></p>
    </form>`;

  document.getElementById('add').addEventListener('click', () => {
    cart.add(p.id, Number(document.getElementById('qty').value) || 1);
  });

  document.getElementById('review-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api('/reviews', {
        method: 'POST',
        body: JSON.stringify({ ...data, product: p.id, rating: Number(data.rating) }),
      });
      productView(slug); // re-render with the new review
    } catch (err) {
      document.getElementById('review-error').textContent = apiErrorText(err);
    }
  });
}

async function cartView() {
  const items = cart.read();
  const ids = Object.keys(items);
  if (!ids.length) {
    app.innerHTML = '<h1>cart</h1><p class="muted">your cart is empty — <a href="#/">go shopping</a></p>';
    return;
  }

  const products = await api('/products');
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  const rows = ids.filter(id => byId[id]).map(id => ({ product: byId[id], qty: items[id] }));
  const subtotal = rows.reduce((sum, r) => sum + Number(r.product.price) * r.qty, 0);

  // coupon preview: server recomputes authoritatively at order creation
  let coupon = JSON.parse(localStorage.getItem('coupon') || 'null');
  const discountFor = (c) => !c ? 0
    : c.discount_type === 'percent' ? subtotal * Number(c.value) / 100
    : Math.min(Number(c.value), subtotal);
  const discount = discountFor(coupon);

  app.innerHTML = `
    <h1>cart</h1>
    <table>
      <tr><th>product</th><th class="num">price</th><th>qty</th><th class="num">total</th><th></th></tr>
      ${rows.map(({ product: p, qty }) => `
        <tr>
          <td><a href="#/product/${esc(p.slug)}">${esc(p.name)}</a></td>
          <td class="num">${money(p.price)}</td>
          <td><input type="number" data-qty="${p.id}" value="${qty}" min="0" max="${p.stock}" style="width:4.5rem"></td>
          <td class="num">${money(Number(p.price) * qty)}</td>
          <td><button class="small secondary" data-remove="${p.id}">×</button></td>
        </tr>`).join('')}
    </table>

    <div class="coupon-row">
      <input id="coupon-code" placeholder="coupon code" value="${coupon ? esc(coupon.code) : ''}">
      <button class="secondary" id="coupon-apply">apply</button>
    </div>
    <p class="error" id="coupon-error" style="text-align:right"></p>

    <div class="totals">
      <div><span>subtotal</span><span>${money(subtotal)}</span></div>
      ${coupon ? `<div><span>coupon ${esc(coupon.code)}</span><span>−${money(discount)}</span></div>` : ''}
      <div class="grand"><span>total</span><span>${money(subtotal - discount)}</span></div>
    </div>

    <h2>checkout</h2>
    <form class="checkout" id="checkout">
      <input name="full_name" placeholder="full name" required>
      <input name="email" type="email" placeholder="email" required>
      <input name="street" placeholder="street" required>
      <div class="row">
        <input name="city" placeholder="city" required>
        <input name="zip_code" placeholder="zip" required>
      </div>
      <input name="country" value="CZ" maxlength="2" required>
      <div><button type="submit">place order</button></div>
      <p class="error" id="checkout-error"></p>
    </form>`;

  if (auth()) {
    // prefill checkout from the account, but never clobber typed values
    Promise.all([api('/auth/me'), api('/addresses')]).then(([me, addrs]) => {
      syncAuthFromMe(me);
      const form = document.getElementById('checkout');
      if (!form) return;
      form.full_name.value ||= `${me.first_name} ${me.last_name}`.trim();
      form.email.value ||= me.email;
      const a = addrs[0];
      if (a) {
        form.street.value ||= a.street;
        form.city.value ||= a.city;
        form.zip_code.value ||= a.zip_code;
        form.country.value = a.country;
      }
    }).catch(() => {});
  }

  app.querySelectorAll('[data-qty]').forEach(input =>
    input.addEventListener('change', () => {
      cart.setQty(Number(input.dataset.qty), Number(input.value) || 0);
      cartView();
    }));
  app.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', () => { cart.setQty(Number(btn.dataset.remove), 0); cartView(); }));

  document.getElementById('coupon-apply').addEventListener('click', async () => {
    const code = document.getElementById('coupon-code').value.trim();
    if (!code) { localStorage.removeItem('coupon'); cartView(); return; }
    try {
      const c = await api('/coupons/validate', { method: 'POST', body: JSON.stringify({ code }) });
      localStorage.setItem('coupon', JSON.stringify(c));
      cartView();
    } catch {
      document.getElementById('coupon-error').textContent = 'invalid or expired coupon';
    }
  });

  document.getElementById('checkout').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      const order = await api('/orders', {
        method: 'POST',
        body: JSON.stringify({
          ...data,
          coupon_code: coupon ? coupon.code : '',
          items: rows.map(r => ({ product: r.product.id, quantity: r.qty })),
        }),
      });
      cart.clear();
      location.hash = `#/order/${order.id}`;
    } catch (err) {
      document.getElementById('checkout-error').textContent = apiErrorText(err);
    }
  });
}

function authView() {
  app.innerHTML = `
    <h1>account</h1>
    <div class="auth-grid">
      <form id="login-form" class="review-form">
        <h2>log in</h2>
        <input name="email" type="email" placeholder="email" required>
        <input name="password" type="password" placeholder="password" required>
        <div><button type="submit">log in</button></div>
        <p class="error" id="login-error"></p>
      </form>
      <form id="register-form" class="review-form">
        <h2>register</h2>
        <div class="row">
          <input name="first_name" placeholder="first name">
          <input name="last_name" placeholder="last name">
        </div>
        <input name="email" type="email" placeholder="email" required>
        <input name="password" type="password" placeholder="password" required>
        <div><button type="submit" class="secondary">create account</button></div>
        <p class="error" id="register-error"></p>
      </form>
    </div>`;

  const wire = (formId, path, errorId) =>
    document.getElementById(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api(path, {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        setAuth(res.token, res.user);
        route();
      } catch (err) {
        document.getElementById(errorId).textContent = apiErrorText(err);
      }
    });
  wire('login-form', '/auth/login', 'login-error');
  wire('register-form', '/auth/register', 'register-error');
}

async function accountView() {
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    clearAuth(); // stale token
    authView();
    return;
  }
  syncAuthFromMe(me);
  const [orders, addresses] = await Promise.all([api('/orders'), api('/addresses')]);

  app.innerHTML = `
    <h1>hi, ${esc(me.first_name || me.email)}</h1>
    <p class="muted">${esc(me.email)} · <button class="small secondary" id="logout">log out</button></p>

    <h2>my orders</h2>
    ${orders.length ? `<table>
      <tr><th>placed</th><th>status</th><th class="num">total</th><th></th></tr>
      ${orders.map(o => `
        <tr>
          <td>${new Date(o.created_at).toLocaleString()}</td>
          <td><span class="status-pill status-${esc(o.status)}">${esc(o.status)}</span></td>
          <td class="num">${money(o.total)}</td>
          <td><a href="#/order/${esc(o.id)}">view</a></td>
        </tr>`).join('')}
    </table>` : '<p class="muted">no orders yet</p>'}

    <h2>addresses</h2>
    ${addresses.length ? addresses.map(a => `
      <div class="review">
        <div class="head">
          <strong>${esc(a.label)}</strong>
          <button class="small secondary" data-del-addr="${a.id}">delete</button>
        </div>
        ${esc(a.street)}, ${esc(a.zip_code)} ${esc(a.city)}, ${esc(a.country)}
      </div>`).join('') : '<p class="muted">no saved addresses</p>'}

    <h2>add address</h2>
    <form class="review-form" id="address-form">
      <input name="label" placeholder="label (home, office…)" required>
      <input name="street" placeholder="street" required>
      <div class="row">
        <input name="city" placeholder="city" required>
        <input name="zip_code" placeholder="zip" required>
      </div>
      <input name="country" value="CZ" maxlength="2" required>
      <div><button type="submit">save address</button></div>
      <p class="error" id="address-error"></p>
    </form>`;

  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* token already dead */ }
    clearAuth();
    route();
  });

  app.querySelectorAll('[data-del-addr]').forEach(btn =>
    btn.addEventListener('click', async () => {
      await api(`/addresses/${btn.dataset.delAddr}`, { method: 'DELETE' });
      accountView();
    }));

  document.getElementById('address-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/addresses', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      accountView();
    } catch (err) {
      document.getElementById('address-error').textContent = apiErrorText(err);
    }
  });
}

async function orderView(id) {
  const o = await api(`/orders/${encodeURIComponent(id)}`);

  app.innerHTML = `
    <h1>order <span class="muted" style="font-size:.6em">${esc(o.id)}</span></h1>
    <p><span class="status-pill status-${esc(o.status)}">${esc(o.status)}</span></p>

    <h2>items</h2>
    <table>
      <tr><th>product</th><th class="num">price</th><th class="num">qty</th><th class="num">total</th></tr>
      ${o.items.map(i => `
        <tr>
          <td>${esc(i.product_name)}</td>
          <td class="num">${money(i.price)}</td>
          <td class="num">${i.quantity}</td>
          <td class="num">${money(i.line_total)}</td>
        </tr>`).join('')}
    </table>

    <div class="totals">
      <div><span>subtotal</span><span>${money(o.subtotal)}</span></div>
      ${Number(o.discount_amount) ? `<div><span>coupon ${esc(o.coupon_code)}</span><span>−${money(o.discount_amount)}</span></div>` : ''}
      <div class="grand"><span>total</span><span>${money(o.total)}</span></div>
    </div>

    <p class="muted">ships to: ${esc(o.full_name)}, ${esc(o.street)}, ${esc(o.zip_code)} ${esc(o.city)}, ${esc(o.country)}</p>
    ${o.payment ? `<p class="muted">paid via ${esc(o.payment.provider)} — tx ${esc(o.payment.transaction_id)}</p>` : ''}

    <div id="payment-ui"></div>

    <div class="actions">
      ${o.status === 'pending' ? '<button id="pay">pay now</button>' : ''}
      ${['pending', 'paid'].includes(o.status) ? '<button class="secondary" id="cancel">cancel order</button>' : ''}
    </div>
    <p class="error" id="order-error"></p>`;

  const act = (path) => async () => {
    try {
      await api(`/orders/${o.id}/${path}`, { method: 'POST' });
      orderView(id);
    } catch (err) {
      document.getElementById('order-error').textContent = apiErrorText(err);
    }
  };
  document.getElementById('pay')?.addEventListener('click', async () => {
    try {
      const res = await api(`/orders/${o.id}/pay`, { method: 'POST' });
      if (res.client_secret) mountPaymentElement(o, res);
      else orderView(id); // fake provider: paid instantly
    } catch (err) {
      document.getElementById('order-error').textContent = apiErrorText(err);
    }
  });
  document.getElementById('cancel')?.addEventListener('click', act('cancel'));
}

function mountPaymentElement(o, { client_secret, publishable_key }) {
  const stripe = Stripe(publishable_key);
  const elements = stripe.elements({ clientSecret: client_secret });

  document.getElementById('pay').hidden = true;
  const box = document.getElementById('payment-ui');
  box.innerHTML = `
    <div class="payment-box">
      <div id="payment-element"></div>
      <button id="pay-submit">pay ${money(o.total)}</button>
    </div>`;
  elements.create('payment').mount('#payment-element');

  document.getElementById('pay-submit').addEventListener('click', async () => {
    const btn = document.getElementById('pay-submit');
    const errBox = document.getElementById('order-error');
    btn.disabled = true;
    errBox.textContent = '';
    // card payments settle in-page; redirect methods bounce back to this url
    const { error } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: location.href },
    });
    if (error) {
      errBox.textContent = error.message;
      btn.disabled = false;
      return;
    }
    try {
      // webhook is the source of truth; this is the sync fallback for dev
      await api(`/orders/${o.id}/confirm-payment`, { method: 'POST' });
    } catch (err) {
      errBox.textContent = apiErrorText(err);
    }
    orderView(o.id);
  });
}

// ---------- router ----------

async function route() {
  const hash = location.hash.slice(2) || ''; // strip '#/'
  const [path, query] = hash.split('?');
  const segments = path.split('/').filter(Boolean);

  try {
    if (segments[0] === 'product' && segments[1]) await productView(segments[1]);
    else if (segments[0] === 'cart') await cartView();
    else if (segments[0] === 'order' && segments[1]) await orderView(segments[1]);
    else if (segments[0] === 'account') await (auth() ? accountView() : authView());
    else await homeView(new URLSearchParams(query).get('category'));
  } catch (err) {
    app.innerHTML = `<p class="error">something broke: ${esc(err.body?.detail || err.message)} — is the API running?</p>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
updateCartBadge();
updateNav();
if (auth()) api('/auth/me').then(syncAuthFromMe).catch(() => {});

// ---------- support chat widget ----------

const chat = {
  read() { return JSON.parse(localStorage.getItem('support_chat') || '[]'); },
  write(h) { localStorage.setItem('support_chat', JSON.stringify(h)); },
};

function renderChat(pending = false) {
  const box = document.getElementById('chat-messages');
  const msgs = chat.read();
  box.innerHTML = msgs.length
    ? msgs.map(m => `<div class="chat-msg ${esc(m.role)}">${esc(m.content)}</div>`).join('')
    : '<div class="chat-msg assistant">hi! ask me about products, orders or coupons.</div>';
  if (pending) box.innerHTML += '<div class="chat-msg assistant pending">thinking…</div>';
  box.scrollTop = box.scrollHeight;
}

document.getElementById('chat-toggle').addEventListener('click', () => {
  const panel = document.getElementById('chat-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { renderChat(); document.getElementById('chat-input').focus(); }
});
document.getElementById('chat-close').addEventListener('click', () => {
  document.getElementById('chat-panel').hidden = true;
});
document.getElementById('chat-clear').addEventListener('click', () => {
  chat.write([]);
  renderChat();
});

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  const history = chat.read();
  chat.write([...history, { role: 'user', content: message }]);
  input.value = '';
  input.disabled = true;
  renderChat(true);
  try {
    const res = await api('/support/chat', {
      method: 'POST',
      body: JSON.stringify({ message, history }),
    });
    chat.write(res.history);
  } catch (err) {
    chat.write([...chat.read(), {
      role: 'assistant',
      content: `sorry, something went wrong (${apiErrorText(err)}) — try again.`,
    }]);
  }
  input.disabled = false;
  renderChat();
  input.focus();
});
route();
