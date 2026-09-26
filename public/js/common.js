// Shared page chrome: login guard, top bar, toasts, escaping.
import { api } from './api.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Pages in the order they appear in the nav. `soon` pages arrive in later scripts.
const PAGES = [
  { href: 'ledger.html', label: 'Ledger' },
  { href: 'shop.html', label: 'Goods Shop' },
  { href: 'companies.html', label: 'Companies' },
  { href: 'labor.html', label: 'Labor' },
  { href: 'construction.html', label: 'Construction' },
  { href: 'realestate.html', label: 'Real Estate' },
  { href: 'shipping.html', label: 'Shipping' },
  { href: 'market.html', label: 'Market' },
  { href: 'exchange.html', label: 'Exchange' },
  { href: 'gm.html', label: 'GM Console', gm: true },
];

/** Loads the session; sends visitors to the login page if not logged in. */
export async function requireSession({ gm = false } = {}) {
  let user = null;
  try { ({ user } = await api('me')); } catch { /* treated as logged out */ }
  // While the browser navigates away, pause the page script instead of erroring.
  if (!user) { location.replace('index.html'); return new Promise(() => {}); }
  if (gm && user.role !== 'gm') { location.replace('ledger.html'); return new Promise(() => {}); }
  renderTopbar(user);
  return user;
}

function renderTopbar(user) {
  const here = location.pathname.split('/').pop() || 'ledger.html';
  const links = PAGES.filter((p) => !p.gm || user.role === 'gm').map((p) => (
    p.soon
      ? `<span class="soon" title="Coming in a later script">${esc(p.label)}</span>`
      : `<a href="${p.href}" class="${p.href === here ? 'active' : ''}">${esc(p.label)}</a>`
  )).join('');

  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="brand-block">
      <a class="brand" href="ledger.html" id="brand">Beginnings Exchange</a>
      <div class="world-date" id="world-date" title="Current date in the world">…</div>
    </div>
    <nav class="nav">${links}</nav>
    <div class="who">
      <div class="rp">${esc(user.rpName)}</div>
      <div class="un">@${esc(user.username)} ${user.role === 'gm' ? '<span class="role">· GM</span>' : ''}</div>
    </div>
    <button class="ghost small" id="logout" style="color:var(--paper);border-color:var(--paper-3)">Log out</button>`;
  document.body.prepend(bar);

  bar.querySelector('#logout').addEventListener('click', async () => {
    try { await api('logout', { method: 'POST', body: {} }); } finally { location.replace('index.html'); }
  });

  getClock().then((c) => { setTopbarDate(c.date.text, c.session); }).catch(() => {});

  api('status').then((s) => {
    if (s.siteName) {
      bar.querySelector('#brand').textContent = s.siteName;
      document.title = document.title.replace('Beginnings Exchange', s.siteName);
    }
  }).catch(() => {});
}

let clockPromise = null;
/** The in-world date + calendar (fetched once per page; pass fresh=true after the GM moves time). */
export function getClock(fresh = false) {
  if (!clockPromise || fresh) clockPromise = api('clock');
  return clockPromise;
}

/** Updates the date (and session) shown in the top bar. */
export function setTopbarDate(text, session) {
  const el = document.getElementById('world-date');
  if (el) el.textContent = session ? `${text} · Session ${session.number}, day ${session.day}` : text;
}

let toastTimer;
export function toast(message, bad = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/** Runs an async action with the button disabled; toasts errors. */
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); }
  catch (err) { toast(err.message, true); throw err; }
  finally { if (button) button.disabled = false; }
}

/**
 * A styled confirmation box (replaces the browser's confirm()). Resolves true / false.
 *   confirmBox('Remove Bess as officer?', { ok: 'Remove', danger: true, detail: 'She can no longer…' })
 */
export function confirmBox(message, { ok = 'Confirm', cancel = 'Cancel', danger = false, detail = '' } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'panel confirm-box';
    d.innerHTML = `<p class="confirm-msg" style="white-space:pre-line">${esc(message)}</p>${detail ? `<p class="small muted">${esc(detail)}</p>` : ''}
      <div class="actions"><button type="button" class="${danger ? 'danger-solid' : ''}" data-ok>${esc(ok)}</button>
      <button type="button" class="ghost" data-cancel>${esc(cancel)}</button></div>`;
    document.body.append(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-ok]').addEventListener('click', () => done(true));
    d.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    d.addEventListener('click', (e) => { if (e.target === d) done(false); });
    d.showModal();
    d.querySelector('[data-ok]').focus();
  });
}

/**
 * A small styled prompt (replaces the browser's prompt()). Resolves the text, or null if cancelled.
 */
export function promptBox(message, opts = {}) {
  // Like prompt(message, default): a plain second argument is the starting value.
  const { value = '', ok = 'Save', placeholder = '', detail = '' } = (opts !== null && typeof opts === 'object') ? opts : { value: opts };
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'panel confirm-box';
    d.innerHTML = `<form method="dialog"><label class="confirm-msg" style="white-space:pre-line">${esc(message)}</label>
      <input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      ${detail ? `<p class="small muted">${esc(detail)}</p>` : ''}
      <div class="actions"><button type="submit">${esc(ok)}</button><button type="button" class="ghost" data-cancel>Cancel</button></div></form>`;
    document.body.append(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); done(d.querySelector('input').value); });
    d.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    d.showModal();
    const input = d.querySelector('input');
    input.focus();
    input.select();
  });
}

/**
 * Live text filter for a table: rows whose text doesn't contain every typed word are hidden.
 * Re-applies itself when the table is re-rendered.
 */
export function attachFilter(input, tbody) {
  const apply = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const tr of tbody.rows) {
      if (tr.dataset.noFilter != null) continue;
      const hit = words.every((w) => tr.textContent.toLowerCase().includes(w));
      tr.hidden = !hit;
      if (hit) shown += 1;
    }
    input.dataset.count = words.length ? `${shown} shown` : '';
  };
  input.addEventListener('input', apply);
  new MutationObserver(apply).observe(tbody, { childList: true });
  return apply;
}
