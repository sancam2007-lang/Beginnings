// GM Console → Shipping: the freight rules and every shipment (deliver now, redirect, send back).
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, attachFilter, getClock } from '../common.js';
import { formatMoney, formatPrice } from '../money.js';
import { formatDay } from '../calendar.js';

export function init({ $, on, openProfile }) {
  let d = null;
  let calendar = null;
  getClock().then((c) => { calendar = c.calendar; if (d) render(); }).catch(() => {});
  const day = (n) => formatDay(n, calendar, { short: true });
  const post = (body) => api('gm/transport', { method: 'POST', body }).then(apply);

  function apply(r) {
    d = r;
    render();
    return r;
  }
  function render() {
    renderRules();
    renderRows();
  }

  /* ── Rules ── */
  function renderRules() {
    const c = d.currency;
    document.querySelectorAll('#tab-shipping .cur-name').forEach((el) => { el.textContent = `${c.name} (${c.symbol})`; });
    $('sh-rate-label').textContent = `Freight per unit, slowest (${c.symbol})`;
    if ($('sh-rules').dataset.dirty) return; // don't overwrite what the GM is typing
    $('sh-rate').value = +(d.rules.ratePerUnit / c.subunitsPerUnit).toFixed(4);
    $('sh-rush').value = d.rules.rushPctPerDay;
    $('sh-min').value = d.rules.minDays;
    $('sh-max').value = d.rules.maxDays;
    example();
  }
  function example() {
    const c = d.currency;
    const rate = (Number($('sh-rate').value) || 0) * c.subunitsPerUnit;
    const rush = Number($('sh-rush').value) || 0;
    const lo = Number($('sh-min').value) || 1;
    const hi = Number($('sh-max').value) || lo;
    const fee = (days) => (rate > 0 ? Math.max(1, Math.ceil(rate * 100 * (1 + (rush / 100) * Math.max(0, hi - days)) - 1e-9)) : 0);
    $('sh-example').textContent = rate > 0
      ? `100 units: ${formatMoney(fee(hi), c)} in ${hi} days · ${formatMoney(fee(lo), c)} in ${lo} days (${formatPrice(rate, c)} per unit at the slowest).`
      : 'Shipping is free. Goods still take the days the sender chooses.';
  }
  $('sh-rules').addEventListener('input', () => { $('sh-rules').dataset.dirty = '1'; example(); });
  $('sh-rules').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = d.currency;
    const rules = {
      ratePerUnit: (Number($('sh-rate').value) || 0) * c.subunitsPerUnit,
      rushPctPerDay: Number($('sh-rush').value) || 0,
      minDays: Number($('sh-min').value), maxDays: Number($('sh-max').value),
    };
    busy(e.submitter, () => post({ action: 'saveRules', rules }))
      .then(() => { delete $('sh-rules').dataset.dirty; renderRules(); toast('Shipping rules saved.'); }).catch(() => {});
  });

  /* ── Shipments ── */
  function renderRows() {
    const open = d.shipments.filter((s) => s.status === 'transit' || s.status === 'waiting');
    const done = d.shipments.filter((s) => s.status === 'delivered' || s.status === 'returned').slice(0, 40);
    $('sh-rows').innerHTML = [...open, ...done].map((s) => {
      const live = s.status === 'transit' || s.status === 'waiting';
      const others = live ? d.stockpiles.filter((p) => p.settlementId === s.toSettlementId && p.id !== s.toStockpileId) : [];
      const goods = s.cargo.map((c) => `${(live ? c.qty : c.loaded).toLocaleString()} ${esc(c.name)}`).join(' · ');
      const when = s.status === 'transit' ? esc(day(s.arriveDay))
        : s.status === 'waiting' ? `<span class="debit">waiting</span><div class="small muted">${esc(s.note ?? '')}</div>`
        : `<span class="muted">${s.status === 'returned' ? 'returned' : 'arrived'} ${esc(day(s.deliveredDay ?? s.arriveDay))}</span>`;
      return `<tr class="${live ? '' : 'inactive'}">
        <td><button type="button" class="linkish" data-owner="${s.ownerType}:${s.ownerId}">${esc(s.ownerName ?? '?')}</button>
          <div class="small">${esc(s.fromPile ?? '—')} <span class="muted">${esc(s.fromTown)}</span> → ${esc(s.toPile ?? '—')} <span class="muted">${esc(s.toTown)}</span>
          ${s.toOwnerName && (s.toOwnerType !== s.ownerType || s.toOwnerId !== s.ownerId) ? `<span class="muted">(${esc(s.toOwnerName)})</span>` : ''}</div>
          <div class="small muted">${s.days} days${s.fee ? ` · freight ${esc(formatMoney(s.fee, d.currency))}` : ''}</div></td>
        <td class="small">${goods}</td>
        <td class="small">${when}</td>
        <td class="num">${live ? `<div class="stack-actions">
          <button class="ghost small" data-arrive="${s.id}">Deliver now</button>
          ${s.fromStockpileId ? `<button class="ghost small" data-return="${s.id}">Send back</button>` : ''}
          ${others.length ? `<select class="small" data-redirect="${s.id}" aria-label="Redirect"><option value="">Redirect to…</option>${others.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.ownerName ?? '?')}</option>`).join('')}</select>` : ''}
          </div>` : ''}</td></tr>`;
    }).join('') || '<tr data-no-filter><td colspan="4" class="muted">No shipments yet.</td></tr>';
  }
  attachFilter($('sh-filter'), $('sh-rows'));
  $('sh-rows').addEventListener('click', async (e) => {
    const o = e.target.closest('button[data-owner]');
    if (o) { const [t, id] = o.dataset.owner.split(':'); openProfile(t, Number(id)); return; }
    const a = e.target.closest('button[data-arrive]');
    if (a) {
      busy(a, () => post({ action: 'arriveNow', shipmentId: Number(a.dataset.arrive) })).then(() => toast('Delivered (as much as fits).')).catch(() => {});
      return;
    }
    const r = e.target.closest('button[data-return]');
    if (r) {
      if (!await confirmBox('Send this shipment back where it came from?', { ok: 'Send back', detail: 'The goods go straight back into the stockpile they left. Freight is not refunded.' })) return;
      busy(r, () => post({ action: 'return', shipmentId: Number(r.dataset.return) })).then(() => toast('Shipment sent back.')).catch(() => {});
    }
  });
  $('sh-rows').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-redirect]');
    if (!sel || !sel.value) return;
    busy(null, () => post({ action: 'redirect', shipmentId: Number(sel.dataset.redirect), stockpileId: Number(sel.value) }))
      .then(() => toast('Shipment redirected.')).catch(() => { sel.value = ''; });
  });

  const reload = () => api('gm/transport').then(apply).catch((err) => toast(err.message, true));
  on('tab', (name) => { if (name === 'shipping') reload(); });
  on('refresh', () => { if (d) reload(); });
}
