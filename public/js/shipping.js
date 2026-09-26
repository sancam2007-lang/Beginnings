// Shipping: send goods from your stockpiles to a depot in another town in 5–10 days (your choice);
// follow what's on the way and what has arrived.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock } from './common.js';
import { formatMoney } from './money.js';
import { formatDay } from './calendar.js';

const $ = (id) => document.getElementById(id);
await requireSession();

let d = null;
let calendar = null;
const day = (n) => formatDay(n, calendar, { short: true });
const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; };
const source = () => d.sources.find((p) => p.id === Number($('f-from').value));
const mineOwner = (type, id) => d.owners.some((o) => o.type === type && o.id === id);

/** Freight, same formula as the server: rate × units × (1 + rush% × days faster than the slowest). */
function freight(units, days) {
  const r = d.rules;
  if (!(r.ratePerUnit > 0) || units <= 0) return 0;
  return Math.max(1, Math.ceil(r.ratePerUnit * units * (1 + (r.rushPctPerDay / 100) * Math.max(0, r.maxDays - days)) - 1e-9));
}

/* ── Send ── */
function cargoLine(pile) {
  const items = pile?.goods ?? [];
  $('f-cargo').insertAdjacentHTML('beforeend', `<div class="row tight cargo-line" style="gap:.4rem;margin:.25rem 0;align-items:center">
    <select aria-label="Good">${items.map((i) => `<option value="${i.goodId}">${esc(i.name)} (${i.qty.toLocaleString()} ${esc(i.unit)})</option>`).join('')
      || '<option value="">— empty —</option>'}</select>
    <input type="number" min="1" value="${items[0]?.qty ?? 1}" aria-label="Quantity">
    <button type="button" class="ghost small" data-rm aria-label="Remove">✕</button></div>`);
}
const readCargo = () => [...$('f-cargo').querySelectorAll('.cargo-line')]
  .map((r) => ({ goodId: Number(r.querySelector('select').value), qty: Number(r.querySelector('input').value) }))
  .filter((c) => c.goodId && c.qty > 0);

function syncForm({ resetCargo = false } = {}) {
  const withGoods = d.sources.filter((p) => p.goods.length);
  const was = $('f-from').value;
  keep($('f-from'), withGoods.map((p) => `<option value="${p.id}">${esc(p.ownerName)} — ${esc(p.name)} (${esc(p.town)})</option>`).join('')
    || '<option value="">— none of your warehouses or depots hold goods —</option>');
  const src = source();
  if (resetCargo || $('f-from').value !== was) $('f-cargo').innerHTML = '';
  if (src && !$('f-cargo').children.length) cargoLine(src);
  $('f-add').disabled = !src;

  // Destinations: any open depot in another town — yours first.
  const dests = src ? d.destinations.filter((p) => p.settlementId !== src.settlementId) : [];
  const towns = [...new Set(dests.map((p) => p.town))];
  keep($('f-to'), towns.map((t) => `<optgroup label="${esc(t)}">${dests.filter((p) => p.town === t)
    .sort((a, b) => (b.mine - a.mine) || a.name.localeCompare(b.name))
    .map((p) => `<option value="${p.id}">${esc(p.name)} — ${p.mine ? `${esc(p.ownerName)} (yours)` : esc(p.ownerName)}</option>`).join('')}</optgroup>`).join('')
    || '<option value="">— no depot in another town —</option>');
  const to = d.destinations.find((p) => p.id === Number($('f-to').value));
  $('f-to-note').textContent = to && !to.mine ? `The goods will belong to ${to.ownerName} when they arrive.` : '';

  const days = Number($('f-days').value);
  $('f-days-out').textContent = `${days} day${days === 1 ? '' : 's'}`;
  const units = readCargo().reduce((s, c) => s + c.qty, 0);
  const fee = freight(units, days);
  $('f-cost').innerHTML = src && to
    ? `${units.toLocaleString()} units · freight <strong>${fee ? esc(formatMoney(fee, d.currency)) : 'free'}</strong>, paid by ${esc(src.ownerName)} · arrives <strong>${esc(day(d.worldDay + days))}</strong>`
    : '';
  $('f-go').disabled = !src || !to || !units;
}
$('f-from').addEventListener('change', () => syncForm({ resetCargo: true }));
$('f-to').addEventListener('change', () => syncForm());
$('f-days').addEventListener('input', () => syncForm());
$('f-cargo').addEventListener('input', () => syncForm());
$('f-cargo').addEventListener('change', () => syncForm());
$('f-cargo').addEventListener('click', (e) => { if (e.target.matches('[data-rm]')) { e.target.closest('.cargo-line').remove(); syncForm(); } });
$('f-add').addEventListener('click', () => { cargoLine(source()); syncForm(); });

$('ship-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = d.destinations.find((p) => p.id === Number($('f-to').value));
  const body = { action: 'send', fromStockpileId: Number($('f-from').value), toStockpileId: to.id, days: Number($('f-days').value), cargo: readCargo() };
  busy(e.submitter, () => api('shipping', { method: 'POST', body }))
    .then(async (r) => {
      toast(`Shipment sent to ${to.name} — arrives ${day(r.sent.arriveDay)}.`);
      await load({ resetCargo: true });
    }).catch(() => {});
});

/* ── Shipments ── */
function card(s) {
  const outgoing = mineOwner(s.ownerType, s.ownerId);
  const incoming = s.toOwnerType && mineOwner(s.toOwnerType, s.toOwnerId);
  const who = outgoing && incoming ? '' : outgoing ? ` → ${esc(s.toOwnerName ?? '?')}` : ` <span class="tag base">from ${esc(s.ownerName)}</span>`;
  const goods = s.cargo.map((c) => {
    const n = s.status === 'delivered' || s.status === 'returned' ? c.loaded : c.qty;
    return `${n.toLocaleString()} ${esc(c.name)}`;
  }).join(' · ');
  const when = s.status === 'transit' ? `arrives <strong>${esc(day(s.arriveDay))}</strong> (${s.days} days)`
    : s.status === 'waiting' ? `<span class="debit">waiting at the destination</span>${s.note ? ` — ${esc(s.note)}` : ''}`
    : s.status === 'returned' ? `returned ${esc(day(s.deliveredDay))}` : `arrived ${esc(day(s.deliveredDay ?? s.arriveDay))}`;
  const others = outgoing && ['transit', 'waiting'].includes(s.status)
    ? d.destinations.filter((p) => p.settlementId === s.toSettlementId && p.id !== s.toStockpileId) : [];
  return `<div class="shipment ${s.status}">
    <div class="shipment-head"><strong>${esc(s.fromPile ?? s.fromTown)}</strong> <span class="muted">${esc(s.fromTown)}</span> →
      <strong>${esc(s.toPile ?? '?')}</strong> <span class="muted">${esc(s.toTown)}</span>${who}</div>
    <div class="small">${goods}</div>
    <div class="small muted">sent ${esc(day(s.departDay))} · ${when}${s.fee ? ` · freight ${esc(formatMoney(s.fee, d.currency))}` : ''}</div>
    ${others.length ? `<form class="row tight redirect" data-ship="${s.id}" style="align-items:flex-end;margin-top:.3rem;gap:.4rem">
      <div style="flex:1"><label class="small">Deliver to another depot in ${esc(s.toTown)}</label>
        <select class="small">${others.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.ownerName)}</option>`).join('')}</select></div>
      <button type="submit" class="ghost small">Redirect</button></form>` : ''}
  </div>`;
}
function renderShipments() {
  const open = d.shipments.filter((s) => s.status === 'transit' || s.status === 'waiting');
  const done = d.shipments.filter((s) => s.status === 'delivered' || s.status === 'returned').slice(0, 20);
  $('open-ships').innerHTML = open.map(card).join('') || '<p class="muted">Nothing on the way.</p>';
  $('done-ships').innerHTML = done.map(card).join('') || '<p class="muted small">Nothing has arrived yet.</p>';
}
$('open-ships').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.closest('form.redirect');
  if (!f) return;
  busy(e.submitter, () => api('shipping', { method: 'POST', body: { action: 'redirect', shipmentId: Number(f.dataset.ship), stockpileId: Number(f.querySelector('select').value) } }))
    .then(async () => { toast('Shipment redirected.'); await load(); }).catch(() => {});
});

async function load(opts = {}) {
  d = await api('shipping');
  const r = d.rules;
  $('f-days').min = r.minDays;
  $('f-days').max = r.maxDays;
  if (!$('f-days').dataset.touched) $('f-days').value = r.maxDays;
  $('lim-days').textContent = r.minDays === r.maxDays ? `${r.minDays}` : `${r.minDays}–${r.maxDays}`;
  $('f-fast').textContent = `${r.minDays} days${r.ratePerUnit > 0 && r.rushPctPerDay > 0 ? ' · dearer' : ''}`;
  $('f-slow').textContent = `${r.maxDays} days${r.ratePerUnit > 0 && r.rushPctPerDay > 0 ? ' · cheaper' : ''}`;
  syncForm(opts);
  renderShipments();
}
$('f-days').addEventListener('input', () => { $('f-days').dataset.touched = '1'; });

try {
  calendar = (await getClock()).calendar;
  await load();
} catch (err) {
  toast(err.message, true);
}
