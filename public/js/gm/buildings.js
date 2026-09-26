// GM Console → Buildings: every building in the world; rename, transfer, and place prebuilt Crown property.
import { api } from '../api.js';
import { esc, toast, busy, attachFilter, getClock, confirmBox } from '../common.js';
import { formatMoney } from '../money.js';
import { formatDay } from '../calendar.js';

const ORIGIN = { construction: 'built', placed: 'placed by the GM', import: 'NPC import', legacy: 'from before the registry' };

export function init({ $, on, emit, openProfile }) {
  let d = null;
  let calendar = null;
  let current = null;
  getClock().then((c) => { calendar = c.calendar; }).catch(() => {});
  const day = (n) => formatDay(n, calendar, { short: true });
  const post = (body) => api('gm/realestate', { method: 'POST', body }).then((r) => { apply(r); emit('realestate', r); return r; });
  const money = (v, id) => formatMoney(v, d.currencies.find((c) => c.id === id) ?? d.currencies[0]);
  const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; };
  const ownerOpts = () => `<optgroup label="Companies">${d.owners.filter((o) => o.type === 'company').map((o) => `<option value="company:${o.id}">${esc(o.name)}${o.crown ? ' (the Crown)' : ''}</option>`).join('')}</optgroup>`
    + `<optgroup label="Players">${d.owners.filter((o) => o.type === 'user').map((o) => `<option value="user:${o.id}">${esc(o.name)}</option>`).join('')}</optgroup>`;

  function apply(r) {
    d = r;
    renderRows();
    renderPlace();
    if (current) manage(current);
  }

  function status(b) {
    if (b.lease) return `<span class="tag base">rented</span> <span class="small">to ${esc(b.lease.tenantName ?? '?')}, ${esc(money(b.lease.rent, b.lease.currencyId))}/session</span>`;
    if (b.listing) return `<span class="tag">${b.listing.kind === 'sale' ? 'for sale' : 'for rent'}</span> <span class="small">${esc(money(b.listing.price, b.listing.currencyId))}${b.listing.kind === 'lease' ? '/session' : ''}</span>`;
    return '<span class="muted small">—</span>';
  }
  function renderRows() {
    const kind = $('bd-kind').value;
    $('bd-rows').innerHTML = d.buildings.filter((b) => !kind || b.kind === kind).map((b) => `
      <tr class="${b.active ? '' : 'inactive'}">
        <td><strong>${esc(b.name)}</strong> <span class="tag">${esc(b.kindLabel)}</span>
          <div class="small muted">${b.origin === 'construction' ? `built${b.projectName && b.projectName !== b.name ? ` as “${esc(b.projectName)}”` : ''}` : esc(ORIGIN[b.origin] ?? b.origin)}${b.blueprintName ? ` · ${esc(b.blueprintName)}` : ''}${b.builtDay != null ? ` · ${esc(day(b.builtDay))}` : ''}</div>
          <div class="small muted">${b.workplace ? `${b.workplace.workers} workers` : ''}${b.workplace && b.store ? ' · ' : ''}${b.store ? `store ${b.store.used.toLocaleString()} / ${b.store.capacity == null ? '∞' : b.store.capacity.toLocaleString()}` : ''}</div></td>
        <td>${esc(b.town)}</td>
        <td><button type="button" class="linkish" data-owner="${b.ownerType}:${b.ownerId}">${esc(b.ownerName ?? '?')}</button>${b.crown ? ' <span class="tag">Crown</span>' : ''}</td>
        <td>${status(b)}</td>
        <td class="num"><button class="ghost small" data-manage="${b.id}">Manage</button></td>
      </tr>`).join('') || '<tr data-no-filter><td colspan="5" class="muted">No buildings yet. Finish a construction project, or place one below.</td></tr>';
  }
  attachFilter($('bd-filter'), $('bd-rows'));
  $('bd-kind').addEventListener('change', renderRows);
  $('bd-rows').addEventListener('click', (e) => {
    const o = e.target.closest('button[data-owner]');
    if (o) { const [t, id] = o.dataset.owner.split(':'); openProfile(t, Number(id)); return; }
    const m = e.target.closest('button[data-manage]');
    if (m) { manage(Number(m.dataset.manage)); $('bd-manage').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  /* ── Manage one ── */
  function manage(id) {
    const b = d.buildings.find((x) => x.id === id);
    if (!b) { current = null; $('bd-manage').classList.add('hidden'); return; }
    current = id;
    $('bd-manage').classList.remove('hidden');
    $('bd-manage-title').textContent = b.name;
    $('bd-manage-info').textContent = `${b.kindLabel} in ${b.town} · owned by ${b.ownerName}${b.lease ? ` · rented to ${b.lease.tenantName}` : ''}${b.listing ? ` · on the market` : ''}`;
    $('bd-name').value = b.name;
    $('bd-desc').value = b.description ?? '';
    keep($('bd-owner'), ownerOpts());
    $('bd-owner').value = `${b.ownerType}:${b.ownerId}`;
  }
  $('bd-close').addEventListener('click', () => { current = null; $('bd-manage').classList.add('hidden'); });
  $('bd-edit').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => post({ action: 'rename', buildingId: current, name: $('bd-name').value, description: $('bd-desc').value }))
      .then((r) => toast(r.message)).catch(() => {});
  });
  $('bd-transfer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const b = d.buildings.find((x) => x.id === current);
    const [ownerType, ownerId] = $('bd-owner').value.split(':');
    const to = $('bd-owner').selectedOptions[0].textContent;
    if (!await confirmBox(`Give ${b.name} to ${to}?`, { ok: 'Transfer', detail: 'No money changes hands. Any open listing is withdrawn.' })) return;
    busy(btn, () => post({ action: 'transfer', buildingId: current, ownerType, ownerId: Number(ownerId) })).then((r) => toast(r.message)).catch(() => {});
  });

  /* ── Place prebuilt ── */
  function renderPlace() {
    keep($('bd-bp'), d.blueprints.filter((b) => b.active).map((b) => `<option value="${b.id}">${esc(b.name)} (${b.resultType === 'workplace' ? 'workplace' : b.resultType === 'stockpile' ? 'warehouse / depot' : 'building'})</option>`).join('')
      || '<option value="">— make a blueprint in Construction first —</option>');
    keep($('bd-town'), d.settlements.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
    const was = $('bd-powner').value;
    keep($('bd-powner'), ownerOpts());
    if (!was) $('bd-powner').value = `company:${d.crownId}`;
  }
  $('bd-place').addEventListener('submit', (e) => {
    e.preventDefault();
    const [ownerType, ownerId] = $('bd-powner').value.split(':');
    busy(e.submitter, () => post({ action: 'place', blueprintId: Number($('bd-bp').value), settlementId: Number($('bd-town').value), name: $('bd-pname').value, ownerType, ownerId: Number(ownerId) }))
      .then((r) => { $('bd-pname').value = ''; toast(r.message); }).catch(() => {});
  });

  const reload = () => api('gm/realestate').then(apply).catch((err) => toast(err.message, true));
  on('tab', (name) => { if (name === 'buildings') reload(); });
  on('realestate', (r) => { if (d) apply(r); });
  on('refresh', () => { if (d) reload(); });
}
