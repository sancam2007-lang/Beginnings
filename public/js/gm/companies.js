// GM Console → Companies: the register of companies (click one to manage it in its profile),
// new charters, and every located stockpile.
import { api } from '../api.js';
import { esc, toast, busy, attachFilter, getClock } from '../common.js';
import { formatDay } from '../calendar.js';
import { formatMoney, convertMinor } from '../money.js';

export function init({ $, on, emit, openProfile }) {
  const st = { companies: [], stockpiles: [], settlements: [], players: [], currencies: [] };

  function apply(r) {
    st.companies = r.companies;
    st.crown = r.crown;
    st.stockpiles = r.stockpiles;
    renderAll();
    emit('companies', st.companies);
  }
  const post = (body) => api('gm/companies', { method: 'POST', body }).then(apply);

  function renderAll() {
    renderCompanies();
    renderSelects();
    renderPiles();
    renderPick();
  }

  const placeOpts = () => st.settlements.filter((s) => s.active)
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  function keep(select, html) {
    const v = select.value;
    select.innerHTML = html;
    if ([...select.options].some((o) => o.value === v)) select.value = v;
  }

  /* ── Companies ── */
  function treasuryTotal(c) {
    const base = st.currencies.find((x) => x.isBase);
    if (!base) return '—';
    const total = Object.entries(c.balances).reduce((s, [cid, v]) => {
      const cur = st.currencies.find((x) => x.id === Number(cid));
      return s + (cur ? convertMinor(v, cur, base) : 0);
    }, 0);
    return formatMoney(total, base);
  }

  function renderCompanies() {
    const tag = (c) => (c.kind === 'npc' ? ' <span class="tag base">NPC</span>' : c.kind === 'house' ? ' <span class="tag off">old stock</span>' : '');
    $('co-rows').innerHTML = st.companies.map((c) => `
      <tr class="clickable ${c.active ? '' : 'inactive'}" data-id="${c.id}">
        <td><strong>${esc(c.name)}</strong> <span class="ticker">${esc(c.ticker)}</span>${tag(c)}${c.active ? '' : ' <span class="tag off">dissolved</span>'}</td>
        <td>${esc(c.homeSettlementName ?? '—')}</td>
        <td><div class="chips">${c.members.map((m) => `<span class="chip ${m.role}">${esc(m.rpName)}${m.role === 'director' ? ' <span class="role">dir</span>' : ''}</span>`).join('')
          || `<span class="muted small">${c.kind === 'player' ? 'nobody yet' : '—'}</span>`}</div></td>
        <td class="num">${esc(treasuryTotal(c))}</td>
        <td class="num"><button class="ghost small" data-open="${c.id}">Manage</button></td>
      </tr>`).join('') || '<tr data-no-filter><td colspan="5" class="muted">No companies chartered yet.</td></tr>';
  }

  $('co-rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openProfile('company', Number(tr.dataset.id));
  });
  attachFilter($('co-filter'), $('co-rows'));

  /* ── New charter ── */
  function resetCompany() {
    $('co-form').reset();
    $('co-id').value = '';
    $('co-new-panel').classList.add('hidden');
  }
  $('co-cancel').addEventListener('click', resetCompany);
  $('co-new').addEventListener('click', () => {
    $('co-new-panel').classList.remove('hidden');
    $('co-name').focus();
    $('co-new-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('co-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      action: 'saveCompany', name: $('co-name').value, ticker: $('co-ticker').value,
      homeSettlementId: Number($('co-home').value) || null, description: $('co-desc').value,
      charter: $('co-charter').value, active: true, kind: $('co-kind').value,
    };
    busy(e.submitter, () => post(body)).then(() => {
      const made = st.companies.find((c) => c.ticker === body.ticker.trim().toUpperCase());
      resetCompany();
      toast(`${body.name} is chartered. Add its officers here.`);
      if (made) openProfile('company', made.id);
    }).catch(() => {});
  });

  /* ── Stockpiles ── */
  function renderSelects() {
    keep($('co-home'), '<option value="">—</option>' + placeOpts());
    keep($('sp-place'), placeOpts());
    keep($('sp-owner'),
      `<optgroup label="Companies">${st.crown ? `<option value="company:${st.crown.id}">${esc(st.crown.name)} (the Crown)</option>` : ''}${st.companies.map((c) => `<option value="company:${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`
      + `<optgroup label="Players">${st.players.map((p) => `<option value="user:${p.id}">${esc(p.rpName)}</option>`).join('')}</optgroup>`);
  }

  function renderPiles() {
    $('sp-rows').innerHTML = st.stockpiles.map((s) => `
      <tr class="${s.active ? '' : 'inactive'}">
        <td>${esc(s.name)} <span class="small muted">${esc(s.kind)}</span>
          <div class="small muted">${s.builtBy ? `built by “${esc(s.builtBy)}”` : s.storeOf ? `store of ${esc(s.storeOf)}` : 'placed by the GM'}</div></td>
        <td><button type="button" class="linkish" data-owner="${s.ownerType}:${s.ownerId}">${esc(s.ownerName ?? '?')}</button>${s.ownerType === 'user' ? ' <span class="small muted">(player)</span>' : ''}</td>
        <td>${esc(s.settlementName ?? '—')}${s.haulToId ? `<div class="small muted">hauls → ${esc(st.stockpiles.find((x) => x.id === s.haulToId)?.name ?? '?')}</div>` : ''}</td>
        <td class="num">${s.used.toLocaleString()} / ${s.capacity == null ? '∞' : s.capacity.toLocaleString()}</td>
        <td class="num"><button class="ghost small" data-sp="${s.id}">Assign</button></td>
      </tr>`).join('') || '<tr data-no-filter><td colspan="5" class="muted">No warehouses or depots yet.</td></tr>';
  }

  /* Stockpiles are built through Construction; this form assigns an existing one. */
  let calendar = null;
  getClock().then((c) => { calendar = c.calendar; }).catch(() => {});
  function renderPick() {
    const built = st.stockpiles.filter((s) => s.builtBy);
    const stores = st.stockpiles.filter((s) => !s.builtBy && s.storeOf);
    const older = st.stockpiles.filter((s) => !s.builtBy && !s.storeOf);
    const opt = (s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.settlementName ?? '?')} · ${esc(s.ownerName ?? '?')}${s.active ? '' : ' (closed)'}</option>`;
    const group = (label, list) => (list.length ? `<optgroup label="${label}">${list.map(opt).join('')}</optgroup>` : '');
    const sel = $('sp-pick');
    const v = sel.value;
    sel.innerHTML = group('Built through construction', built) + group('Workplace stores', stores) + group('Placed by the GM', older);
    if ([...sel.options].some((o) => o.value === v)) sel.value = v;
    const none = !st.stockpiles.length;
    $('sp-none').classList.toggle('hidden', !none);
    $('sp-form').classList.toggle('hidden', none);
    if (!none) loadPile(Number(sel.value));
  }
  function loadPile(id) {
    const s = st.stockpiles.find((x) => x.id === id);
    if (!s) return;
    $('sp-pick').value = s.id;
    $('sp-id').value = s.id;
    $('sp-owner').value = `${s.ownerType}:${s.ownerId}`;
    $('sp-place').value = s.settlementId;
    $('sp-name').value = s.name;
    $('sp-kind').value = s.kind;
    $('sp-cap').value = s.capacity ?? '';
    $('sp-active').checked = s.active;
    $('sp-form-title').textContent = `Assign ${s.name}`;
    const when = s.builtDay != null ? `, finished ${formatDay(s.builtDay, calendar, { short: true })}` : '';
    $('sp-origin').textContent = (s.builtBy ? `Built by the project “${s.builtBy}”${when}.` : s.storeOf ? `The store of ${s.storeOf}: it changes owner with the workplace (Labor tab).` : 'Placed by the GM (from before construction existed, or by an NPC company import).')
      + (s.used ? ` Holds ${s.used.toLocaleString()} units: empty it before giving it to a new owner.` : '');
  }
  $('sp-pick').addEventListener('change', () => loadPile(Number($('sp-pick').value)));

  attachFilter($('sp-filter'), $('sp-rows'));
  $('sp-rows').addEventListener('click', (e) => {
    const o = e.target.closest('button[data-owner]');
    if (o) { const [t, id] = o.dataset.owner.split(':'); openProfile(t, Number(id)); return; }
    const b = e.target.closest('button[data-sp]');
    if (!b) return;
    loadPile(Number(b.dataset.sp));
    $('sp-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('sp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const [ownerType, ownerId] = $('sp-owner').value.split(':');
    const id = Number($('sp-id').value) || null;
    const body = {
      action: 'saveStockpile', id, ownerType, ownerId: Number(ownerId), settlementId: Number($('sp-place').value),
      name: $('sp-name').value, kind: $('sp-kind').value, capacity: $('sp-cap').value, active: $('sp-active').checked,
    };
    busy(e.submitter, () => post(body))
      .then(() => { loadPile(id); toast(`${body.name} saved.`); }).catch(() => {});
  });

  /* ── React to other tabs ── */
  on('world', (settlements) => { st.settlements = settlements; renderSelects(); });
  on('players', (players) => { st.players = players.filter((p) => !p.disabled); renderSelects(); });
  on('currencies', (list) => { st.currencies = list; renderCompanies(); });
  // Balances and stock change elsewhere (Treasury, Items, players) — refresh whenever this tab opens.
  on('tab', (name) => { if (name === 'companies') api('gm/companies').then(apply).catch(() => {}); });
  on('refresh', () => api('gm/companies').then(apply).catch(() => {}));

  Promise.all([api('gm/companies'), api('currencies')]).then(([r, c]) => {
    st.currencies = c.currencies;
    apply(r);
  }).catch((err) => toast(err.message, true));
}
