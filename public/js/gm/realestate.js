// GM Console → Real Estate: put any building on the market, see every listing, and manage leases.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, getClock } from '../common.js';
import { formatMoney } from '../money.js';
import { formatDay } from '../calendar.js';

export function init({ $, on, emit }) {
  let d = null;
  let calendar = null;
  getClock().then((c) => { calendar = c.calendar; }).catch(() => {});
  const day = (n) => formatDay(n, calendar, { short: true });
  const cur = (id) => d.currencies.find((c) => c.id === id) ?? d.currencies[0];
  const money = (v, id) => formatMoney(v, cur(id));
  const post = (body) => api('gm/realestate', { method: 'POST', body }).then((r) => { apply(r); emit('realestate', r); return r; });
  const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; };
  const bName = (id) => d.buildings.find((b) => b.id === id)?.name ?? '?';

  function apply(r) {
    d = r;
    renderForm();
    syncKind();
    renderListings();
    renderLeases();
  }

  /* ── List a building ── */
  function renderForm() {
    const free = d.buildings.filter((b) => !b.lease && !b.listing);
    const towns = [...new Set(free.map((b) => b.town))];
    keep($('re-building'), towns.map((t) => `<optgroup label="${esc(t)}">${free.filter((b) => b.town === t).map((b) => `<option value="${b.id}">${esc(b.name)} — ${esc(b.ownerName)}${b.store?.used ? ' (store not empty)' : ''}</option>`).join('')}</optgroup>`).join('')
      || '<option value="">— every building is already listed or rented —</option>');
    const base = d.currencies.find((c) => c.isBase) ?? d.currencies[0];
    const was = $('re-cur').value;
    keep($('re-cur'), d.currencies.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.code)})</option>`).join(''));
    if (!was) $('re-cur').value = base.id;
  }
  const syncKind = () => {
    if (!d) return;
    const lease = $('re-kind').value === 'lease';
    document.querySelector('#tab-realestate .re-term').classList.toggle('hidden', !lease);
    $('re-price-label').textContent = lease ? `Rent per session (${cur(Number($('re-cur').value)).symbol})` : `Price (${cur(Number($('re-cur').value)).symbol})`;
  };
  $('re-kind').addEventListener('change', syncKind);
  $('re-cur').addEventListener('change', syncKind);
  $('re-list').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = cur(Number($('re-cur').value));
    const lease = $('re-kind').value === 'lease';
    busy(e.submitter, () => post({
      action: 'list', buildingId: Number($('re-building').value), kind: $('re-kind').value, currencyId: c.id,
      price: Math.round(Number($('re-price').value) * c.subunitsPerUnit), termSessions: lease ? $('re-term').value : null, note: $('re-note').value,
    })).then((r) => { $('re-price').value = ''; $('re-note').value = ''; $('re-term').value = ''; toast(r.message); }).catch(() => {});
  });

  /* ── Listings ── */
  function renderListings() {
    const open = d.listings.filter((l) => l.status === 'active');
    const closed = d.listings.filter((l) => l.status !== 'active').slice(0, 30);
    $('re-listings').innerHTML = [...open, ...closed].map((l) => `
      <tr class="${l.status === 'active' ? '' : 'inactive'}">
        <td><strong>${esc(bName(l.buildingId))}</strong>${l.note ? `<div class="small muted">“${esc(l.note)}”</div>` : ''}</td>
        <td>${l.kind === 'sale' ? 'Sale' : 'Rent'} · <strong>${esc(money(l.price, l.currencyId))}</strong>${l.kind === 'lease' ? `<span class="small muted">/session, ${l.termSessions ? `${+l.termSessions} sessions` : 'open-ended'}</span>` : ''}</td>
        <td>${esc(l.sellerName)}</td>
        <td class="small">${l.status === 'active' ? `listed ${esc(day(l.createdDay))}` : `${esc(l.status)}${l.buyerName ? ` to ${esc(l.buyerName)}` : ''} ${l.closedDay != null ? esc(day(l.closedDay)) : ''}`}</td>
        <td class="num">${l.status === 'active' ? `<button class="ghost small" data-cancel="${l.id}">Withdraw</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing listed yet.</td></tr>';
  }
  $('re-listings').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cancel]');
    if (b) busy(b, () => post({ action: 'cancel', listingId: Number(b.dataset.cancel) })).then((r) => toast(r.message)).catch(() => {});
  });

  /* ── Leases ── */
  function renderLeases() {
    const open = d.leases.filter((l) => l.status === 'active');
    const closed = d.leases.filter((l) => l.status !== 'active').slice(0, 30);
    $('re-leases').innerHTML = [...open, ...closed].map((l) => `
      <tr class="${l.status === 'active' ? '' : 'inactive'}">
        <td><strong>${esc(bName(l.buildingId))}</strong></td>
        <td>${esc(l.tenantName ?? '?')}</td>
        <td>${esc(l.landlordName)}</td>
        <td>${esc(money(l.rent, l.currencyId))}<span class="small muted">/session · ${esc(money(l.paidTotal, l.currencyId))} paid</span></td>
        <td class="small">from ${esc(day(l.startDay))}${l.endDay != null ? ` to ${esc(day(l.endDay))}` : ' (open-ended)'}${l.status !== 'active' ? `<div class="muted">ended ${esc(day(l.endedDay))}: ${esc(l.endReason ?? '')}</div>` : ''}</td>
        <td class="num">${l.status === 'active' ? `<button class="ghost small" data-end="${l.id}">End lease</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No leases yet.</td></tr>';
  }
  $('re-leases').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-end]');
    if (!b) return;
    if (!await confirmBox('End this lease now?', { ok: 'End lease', danger: true, detail: 'The building goes back to its owner. Anything left in the store stays with the building.' })) return;
    busy(b, () => post({ action: 'endLease', leaseId: Number(b.dataset.end) })).then((r) => toast(r.message)).catch(() => {});
  });

  const reload = () => api('gm/realestate').then(apply).catch((err) => toast(err.message, true));
  on('tab', (name) => { if (name === 'realestate') reload(); });
  on('realestate', (r) => { if (d) apply(r); });
  on('refresh', () => { if (d) reload(); });
}
