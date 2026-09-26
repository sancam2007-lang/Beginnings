// Real Estate: buy or rent buildings, and put your own on the market.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox, attachFilter } from './common.js';
import { formatMoney } from './money.js';
import { formatDay } from './calendar.js';

const $ = (id) => document.getElementById(id);
await requireSession();

let d = null;
let calendar = null;
const day = (n) => formatDay(n, calendar, { short: true });
const cur = (id) => d.currencies.find((c) => c.id === id) ?? d.currencies[0];
const money = (v, id) => formatMoney(v, cur(id));
const SIZE = { small_workshop: 'Small workshop', large_workshop: 'Large workshop', small_facility: 'Small facility',
  medium_facility: 'Medium facility', large_facility: 'Large facility', major_facility: 'Major facility' };

/** What the building is, in a line or two. */
function details(b) {
  const bits = [];
  if (b.workplace) {
    const w = b.workplace;
    const need = [w.required.general && `${w.required.general} general`, w.required.skilled && `${w.required.skilled} skilled`, w.required.specialist && `${w.required.specialist} specialists`].filter(Boolean).join(', ');
    bits.push(`${SIZE[w.size] ?? 'Workplace'}${need ? ` · needs ${need}` : ''}${w.workers ? ` · ${w.workers} at work` : ''}`);
    if (w.mode !== 'none' && w.source) bits.push(`${w.mode === 'extract' ? 'Extracts from' : 'Runs'} ${w.source}`);
  }
  if (b.store) bits.push(`${b.kind === 'workplace' ? 'Store' : b.store.kind === 'depot' ? 'Depot' : 'Warehouse'}: ${b.store.capacity == null ? 'unlimited' : `${b.store.capacity.toLocaleString()} units`}${b.store.used ? ` · holds ${b.store.used.toLocaleString()}` : ''}`);
  if (b.description) bits.push(esc(b.description));
  return bits.map((x) => `<div class="small muted">${x}</div>`).join('');
}
const ownerOptions = () => d.owners.map((o) => `<option value="${o.type}:${o.id}">${esc(o.name)}</option>`).join('');
const termText = (l) => (l.termSessions ? `for ${+l.termSessions} session${l.termSessions === 1 ? '' : 's'}` : 'open-ended');

/* ── Market ── */
function renderMarket() {
  const kind = $('mk-kind').value;
  const list = d.market.filter((b) => !kind || b.listing.kind === kind);
  $('market').innerHTML = list.map((b) => {
    const l = b.listing;
    const mine = d.owners.some((o) => o.type === b.ownerType && o.id === b.ownerId);
    return `<article class="estate ${l.kind}" data-filter-row>
      <h3>${esc(b.name)}</h3>
      <div class="small"><span class="tag">${esc(b.kindLabel)}</span> ${esc(b.town)} · ${b.crown ? 'Crown property' : `owned by ${esc(b.ownerName)}`}</div>
      ${details(b)}
      ${l.note ? `<div class="small">“${esc(l.note)}”</div>` : ''}
      <div class="price">${l.kind === 'sale' ? esc(money(l.price, l.currencyId)) : `${esc(money(l.price, l.currencyId))} <span class="small muted">rent per session, ${termText(l)}</span>`}</div>
      ${mine ? '<div class="small muted">Your listing — manage it under Your Property.</div>'
        : `<form class="deal" data-listing="${l.id}" data-kind="${l.kind}">
          <div style="flex:1 1 10rem"><label class="small">${l.kind === 'sale' ? 'Buy as' : 'Rent as'}</label><select class="small" name="as">${ownerOptions()}</select></div>
          <button type="submit" class="small">${l.kind === 'sale' ? 'Buy' : 'Rent'}</button></form>`}
    </article>`;
  }).join('') || `<p class="muted">Nothing ${kind === 'sale' ? 'for sale' : kind === 'lease' ? 'for rent' : 'on the market'} right now.</p>`;
  applyFilter();
}
function applyFilter() {
  const words = $('mk-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  document.querySelectorAll('#market .estate').forEach((el) => { el.hidden = !words.every((w) => el.textContent.toLowerCase().includes(w)); });
}
$('mk-filter').addEventListener('input', applyFilter);
$('mk-kind').addEventListener('change', renderMarket);
$('market').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.closest('form.deal');
  const b = d.market.find((x) => x.listing.id === Number(f.dataset.listing));
  const l = b.listing;
  const who = f.as.selectedOptions[0].textContent;
  const ok = await confirmBox(l.kind === 'sale' ? `Buy ${b.name} for ${money(l.price, l.currencyId)}?` : `Rent ${b.name} for ${money(l.price, l.currencyId)} a session?`, {
    ok: l.kind === 'sale' ? 'Buy' : 'Rent',
    detail: l.kind === 'sale' ? `${who} pays now and takes over the building and its workers (who are then on ${who}'s payroll).`
      : `${who} takes over the building and its workers and pays rent every time time advances${l.termSessions ? `, for ${+l.termSessions} session(s)` : ''}.`,
  });
  if (!ok) return;
  busy(e.submitter, () => api('realestate', { method: 'POST', body: { action: l.kind === 'sale' ? 'buy' : 'lease', listingId: l.id, as: f.as.value } }))
    .then(async (r) => { toast(r.message); await load(); }).catch(() => {});
});

/* ── Your property ── */
function listForm(b) {
  const base = d.currencies.find((c) => c.isBase) ?? d.currencies[0];
  return `<form class="inline-form list-form" data-building="${b.id}">
    <div style="flex:0 1 8rem"><label class="small">Offer</label><select class="small" name="kind"><option value="sale">For sale</option><option value="lease">For rent</option></select></div>
    <div><label class="small" data-price-label>Price</label><input class="small" name="price" type="number" min="0" step="any" required placeholder="e.g. 250"></div>
    <div style="flex:0 1 8rem"><label class="small">Currency</label><select class="small" name="currency">${d.currencies.map((c) => `<option value="${c.id}" ${c.id === base.id ? 'selected' : ''}>${esc(c.code)}</option>`).join('')}</select></div>
    <div class="term hidden" style="flex:0 1 8rem"><label class="small">Term (sessions)</label><input class="small" name="term" type="number" min="0" step="any" placeholder="open-ended"></div>
    <div style="flex:2 1 12rem"><label class="small">Note</label><input class="small" name="note" maxlength="300" placeholder="optional"></div>
    <button type="submit" class="small">List</button></form>`;
}
function renderOwned() {
  const owned = d.mine.filter((b) => b.owned);
  $('owned').innerHTML = owned.map((b) => {
    const l = b.listing;
    const le = b.lease;
    let status = '';
    if (le) {
      status = `<div class="small">Rented to <strong>${esc(le.tenantName ?? '?')}</strong> for ${esc(money(le.rent, le.currencyId))} a session
        ${le.endDay != null ? `until ${esc(day(le.endDay))}` : '(open-ended)'} · ${esc(money(le.paidTotal, le.currencyId))} paid so far
        ${le.endDay == null ? `<button type="button" class="ghost small" data-end="${le.id}">End lease</button>` : ''}</div>`;
    } else if (l) {
      status = `<div class="small">On the market ${l.kind === 'sale' ? 'for' : 'to rent at'} <strong>${esc(money(l.price, l.currencyId))}</strong>${l.kind === 'lease' ? ` a session, ${termText(l)}` : ''}
        <button type="button" class="ghost small" data-cancel="${l.id}">Withdraw</button></div>`;
    }
    return `<div class="estate-row">
      <div class="head"><strong>${esc(b.name)}</strong> <span class="tag">${esc(b.kindLabel)}</span> <span class="muted small">${esc(b.town)} · ${esc(b.ownerName)}</span></div>
      ${details(b)}${status}
      ${!le && !l ? listForm(b) : ''}
    </div>`;
  }).join('') || '<p class="muted">You don’t own any buildings yet. Build one (Construction) or buy one above.</p>';
}
$('owned').addEventListener('change', (e) => {
  const f = e.target.closest('form.list-form');
  if (!f || e.target.name !== 'kind') return;
  f.querySelector('.term').classList.toggle('hidden', f.kind.value !== 'lease');
  f.querySelector('[data-price-label]').textContent = f.kind.value === 'lease' ? 'Rent per session' : 'Price';
});
$('owned').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.closest('form.list-form');
  const c = cur(Number(f.currency.value));
  const body = {
    action: 'list', buildingId: Number(f.dataset.building), kind: f.kind.value, currencyId: c.id,
    price: Math.round(Number(f.price.value) * c.subunitsPerUnit), termSessions: f.kind.value === 'lease' ? f.term.value : null, note: f.note.value,
  };
  busy(e.submitter, () => api('realestate', { method: 'POST', body })).then(async (r) => { toast(r.message); await load(); }).catch(() => {});
});
$('owned').addEventListener('click', async (e) => {
  const c = e.target.closest('button[data-cancel]');
  if (c) {
    busy(c, () => api('realestate', { method: 'POST', body: { action: 'cancel', listingId: Number(c.dataset.cancel) } }))
      .then(async (r) => { toast(r.message); await load(); }).catch(() => {});
    return;
  }
  const x = e.target.closest('button[data-end]');
  if (x) {
    if (!await confirmBox('End this lease?', { ok: 'End lease', danger: true, detail: 'The building comes back to you now. Anything the tenant left in the store stays with the building.' })) return;
    busy(x, () => api('realestate', { method: 'POST', body: { action: 'endLease', leaseId: Number(x.dataset.end) } }))
      .then(async (r) => { toast(r.message); await load(); }).catch(() => {});
  }
});

/* ── What you rent ── */
function renderRenting() {
  const rented = d.mine.filter((b) => b.renting);
  $('renting').innerHTML = rented.map((b) => {
    const le = b.lease;
    return `<div class="estate-row">
      <div class="head"><strong>${esc(b.name)}</strong> <span class="tag">${esc(b.kindLabel)}</span> <span class="muted small">${esc(b.town)} · landlord ${esc(b.ownerName)}</span></div>
      ${details(b)}
      <div class="small">Rented by <strong>${esc(le.tenantName ?? '?')}</strong> for ${esc(money(le.rent, le.currencyId))} a session since ${esc(day(le.startDay))}
        ${le.endDay != null ? ` · ends ${esc(day(le.endDay))}` : ''}
        <button type="button" class="ghost small" data-leave="${le.id}">Move out</button></div>
    </div>`;
  }).join('') || '<p class="muted">You aren’t renting anything.</p>';
}
$('renting').addEventListener('click', async (e) => {
  const x = e.target.closest('button[data-leave]');
  if (!x) return;
  if (!await confirmBox('Move out and end the lease?', { ok: 'Move out', detail: 'The store must be empty. The building and its workers go back to the landlord.' })) return;
  busy(x, () => api('realestate', { method: 'POST', body: { action: 'endLease', leaseId: Number(x.dataset.leave) } }))
    .then(async (r) => { toast(r.message); await load(); }).catch(() => {});
});

async function load() {
  d = await api('realestate');
  renderMarket();
  renderOwned();
  renderRenting();
}

try {
  calendar = (await getClock()).calendar;
  await load();
} catch (err) {
  toast(err.message, true);
}
