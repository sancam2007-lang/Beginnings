// GM Console: the profile panel. Click any player or company and everything about it opens on the
// right, editable in place: names, access, money, company roles, stockpiles, shares, recent activity.
// Changes go through the existing GM endpoints; afterwards we emit 'refresh' so the tabs reload.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, getClock } from '../common.js';
import { formatMoney, formatPrice, currencyOptions } from '../money.js';
import { formatDay } from '../calendar.js';
import { describeForViewer } from '../tx-format.js';
import { policyFields, readPolicy, lastActivity } from './npc-policy.js';

export function createProfile({ emit, me }) {
  const scrim = document.createElement('div');
  scrim.className = 'profile-scrim';
  const panel = document.createElement('aside');
  panel.className = 'profile';
  panel.setAttribute('aria-label', 'Profile');
  panel.innerHTML = `<div class="profile-head"><button type="button" class="ghost small close" aria-label="Close">Close</button>
    <h2 id="pf-title">…</h2><div class="sub" id="pf-sub"></div></div><div class="profile-body" id="pf-body"></div>`;
  document.body.append(scrim, panel);
  const $b = () => panel.querySelector('#pf-body');

  let cur = null; // { type, id }
  let d = null;
  let calendar = null;
  getClock().then((c) => { calendar = c.calendar; }).catch(() => {});
  const day = (n) => (n == null ? '—' : formatDay(n, calendar, { short: true }));
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const money = (v, cid) => formatMoney(v, d.currencies.find((c) => c.id === Number(cid)) ?? d.currencies[0]);
  const base = () => d.currencies.find((c) => c.isBase) ?? d.currencies[0];

  function close() {
    panel.classList.remove('open');
    scrim.classList.remove('open');
    cur = null;
  }
  panel.querySelector('.close').addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur && !document.querySelector('dialog[open]')) close(); });

  async function open(type, id) {
    cur = { type, id: Number(id) };
    panel.classList.add('open');
    scrim.classList.add('open');
    panel.querySelector('#pf-title').textContent = '…';
    panel.querySelector('#pf-sub').textContent = '';
    $b().innerHTML = '<p class="muted">Loading…</p>';
    await reload();
  }

  async function reload() {
    if (!cur) return;
    try {
      d = await api(`gm/profile?type=${cur.type}&id=${cur.id}`);
      if (cur.type === 'user') renderUser(); else renderCompany();
    } catch (err) {
      $b().innerHTML = `<p class="debit">${esc(err.message)}</p>`;
    }
  }

  /** Runs a change, then refreshes the panel and every tab. */
  async function change(button, fn, message) {
    await busy(button, fn);
    if (message) toast(message);
    emit('refresh');
    await reload();
  }

  /* ── Shared sections ── */
  function moneySection(ownerType, ownerId) {
    const bal = Object.entries(d.balances).filter(([, v]) => v !== 0);
    return `<section><h3>Money</h3>
      <ul class="row-list">${bal.map(([cid, v]) => `<li><span>${esc(d.currencies.find((c) => c.id === Number(cid))?.name ?? '?')}</span>
        <span class="mono">${esc(money(v, cid))}</span></li>`).join('') || '<li class="muted small">No money.</li>'}</ul>
      <form class="inline-form" data-money="${ownerType}:${ownerId}">
        <div><label>Currency</label><select class="small" name="cur">${currencyOptions(d.currencies.filter((c) => c.active))}</select></div>
        <div><label>Amount</label><input class="small" name="amt" type="number" min="0" step="any" placeholder="e.g. 25.5"></div>
        <div><label>Memo</label><input class="small" name="memo" maxlength="140" placeholder="optional"></div>
        <button type="submit" class="small" name="grant">Grant</button>
        <button type="submit" class="ghost small" name="seize">Seize</button>
      </form></section>`;
  }

  /** "Assign a built stockpile" — hand an existing, empty stockpile to this owner (stockpiles are built, not created here). */
  function assignPileForm() {
    const list = d.assignable ?? [];
    if (!list.length) {
      return '<p class="small muted" style="margin:.5rem 0 0">No built stockpile is free to assign. Warehouses and depots are built through <strong>Construction</strong>; one must be empty (and not a workplace\'s store) to change owner.</p>';
    }
    return `<form class="inline-form" id="pf-pile">
        <div style="flex:3 1 240px"><label>Assign a built stockpile</label><select class="small" name="pile">${list.map((p) => `
          <option value="${p.id}">${esc(p.name)} — ${esc(p.settlementName ?? '?')} · now ${esc(p.ownerName ?? '?')}${p.builtBy ? '' : ' (placed by GM)'}</option>`).join('')}</select></div>
        <button type="submit" class="small">Assign</button></form>
      <p class="small muted" style="margin:.3rem 0 0">Only empty stockpiles that aren't a workplace's store are listed.</p>`;
  }
  function bindAssignPile(root, ownerType, ownerId, ownerName) {
    root.querySelector('#pf-pile')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const p = d.assignable.find((x) => x.id === Number(e.target.pile.value));
      change(e.submitter, () => api('gm/companies', { method: 'POST', body: {
        action: 'saveStockpile', id: p.id, ownerType, ownerId, name: p.name, kind: p.kind, capacity: p.capacity ?? '', active: p.active,
      } }), `${p.name} now belongs to ${ownerName}.`).catch(() => {});
    });
  }

  function goodsSection() {
    return `<section><h3>Goods</h3>${d.stockpiles.map((p) => `
      <div class="small" style="margin:.2rem 0 .5rem"><strong>${esc(p.kind === 'personal' ? 'Personal pack' : p.name)}</strong>
        <span class="muted">${p.kind === 'personal' ? 'carried' : `${esc(p.settlementName ?? '?')} · ${p.used.toLocaleString()}${p.capacity != null ? ` / ${p.capacity.toLocaleString()}` : ''} units`}</span>
        <div>${p.items.map((i) => `${i.qty.toLocaleString()} ${esc(i.name)}`).join(' · ') || '<span class="muted">empty</span>'}</div></div>`).join('')
      || '<p class="muted small">No stockpiles.</p>'}</section>`;
  }

  function sharesSection() {
    if (!d.shares.length) return '';
    return `<section><h3>Shares held</h3><ul class="row-list">${d.shares.map((s) => `
      <li><button type="button" class="linkish" data-open-company="${s.companyId}">${esc(s.name)}</button>
        <span class="mono">${s.qty.toLocaleString()} <span class="small muted">${s.price != null ? `@ ${esc(formatPrice(s.price, base()))}` : ''}</span></span></li>`).join('')}</ul></section>`;
  }

  function activitySection(ownerType, ownerId) {
    return `<section><h3>Recent activity</h3><ul class="row-list">${d.transactions.map((t) => {
      const incoming = t.to?.type === ownerType && t.to.id === ownerId;
      return `<li><span class="small"><span class="muted">${esc(day(t.worldDay))}</span> ${esc(describeForViewer(t, ownerId, ownerType))}${t.memo ? ` <span class="muted">— ${esc(t.memo)}</span>` : ''}</span>
        <span class="mono small ${incoming ? 'credit' : 'debit'}">${incoming ? '+' : '−'}${esc(money(t.amount, t.currencyId))}</span></li>`;
    }).join('') || '<li class="muted small">Nothing yet.</li>'}</ul></section>`;
  }

  function bindMoney(root) {
    root.querySelectorAll('form[data-money]').forEach((f) => f.addEventListener('submit', (e) => {
      e.preventDefault();
      const [ownerType, ownerId] = f.dataset.money.split(':');
      const c = d.currencies.find((x) => x.id === Number(f.cur.value));
      const amount = Math.round(Number(f.amt.value) * c.subunitsPerUnit);
      if (!(amount > 0)) return toast('Enter an amount.', true);
      const seize = e.submitter?.name === 'seize';
      const body = seize
        ? { action: 'seize', ownerType, ownerId: Number(ownerId), currencyId: c.id, amount, memo: f.memo.value }
        : { action: 'grant', accounts: [`${ownerType}:${ownerId}`], currencyId: c.id, amount, memo: f.memo.value };
      change(e.submitter, () => api('gm/money', { method: 'POST', body }), `${seize ? 'Seized' : 'Granted'} ${formatMoney(amount, c)}.`).catch(() => {});
    }));
    root.querySelectorAll('[data-open-company]').forEach((b) => b.addEventListener('click', () => open('company', b.dataset.openCompany)));
    root.querySelectorAll('[data-open-user]').forEach((b) => b.addEventListener('click', () => open('user', b.dataset.openUser)));
  }

  /* ── Players ── */
  function renderUser() {
    const u = d.user;
    const self = u.id === me.id;
    panel.querySelector('#pf-title').textContent = u.rpName;
    panel.querySelector('#pf-sub').innerHTML = `<span class="mono">@${esc(u.username)}</span> ·
      ${u.role === 'gm' ? '<span class="tag gm">GM</span>' : 'Player'}
      ${u.disabled ? '<span class="tag off">disabled</span>' : ''}${u.locked ? '<span class="tag off">locked out</span>' : ''}
      · last signed in ${esc(when(u.lastLoginAt))}`;
    const joinable = d.companies.filter((c) => c.active && !d.memberships.some((m) => m.companyId === c.id));
    $b().innerHTML = `
      <section><h3>Identity</h3>
        <form class="inline-form" id="pf-rp"><div><label>Roleplay name</label><input class="small" name="v" value="${esc(u.rpName)}" maxlength="40"></div>
          <button type="submit" class="small">Save</button></form>
        <form class="inline-form" id="pf-un"><div><label>Username (for signing in)</label><input class="small mono" name="v" value="${esc(u.username)}" maxlength="24"></div>
          <button type="submit" class="small">Save</button></form>
      </section>

      <section><h3>Access</h3>
        <div class="actions-row">
          <button type="button" class="ghost small" id="pf-pass">Reset password…</button>
          ${u.locked ? '<button type="button" class="ghost small" id="pf-unlock">Unlock</button>' : ''}
          ${self ? '' : `<button type="button" class="ghost small" id="pf-role">${u.role === 'gm' ? 'Make player' : 'Make GM'}</button>
            <button type="button" class="ghost small ${u.disabled ? '' : 'danger'}" id="pf-disable">${u.disabled ? 'Enable account' : 'Disable account'}</button>`}
        </div>
        <div id="pf-temp"></div>
      </section>

      <section><h3>Companies</h3>
        <ul class="row-list">${d.memberships.map((m) => `
          <li><button type="button" class="linkish" data-open-company="${m.companyId}">${esc(m.name)}</button>
            <span class="nowrap"><select class="small" data-role-company="${m.companyId}" aria-label="Role in ${esc(m.name)}">
              <option value="director" ${m.role === 'director' ? 'selected' : ''}>Director</option>
              <option value="officer" ${m.role === 'officer' ? 'selected' : ''}>Officer</option></select>
            <button type="button" class="ghost small" data-remove-company="${m.companyId}" title="Remove from ${esc(m.name)}">✕</button></span></li>`).join('')
          || '<li class="muted small">Not an officer of any company.</li>'}</ul>
        ${joinable.length ? `<form class="inline-form" id="pf-join">
          <div><label>Add to company</label><select class="small" name="company">${joinable.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div style="flex:0 1 110px"><label>Role</label><select class="small" name="role"><option value="officer">Officer</option><option value="director">Director</option></select></div>
          <button type="submit" class="small">Add</button></form>` : ''}
      </section>
      ${moneySection('user', u.id)}
      ${goodsSection().replace('</section>', `${assignPileForm()}</section>`)}
      ${sharesSection()}
      ${activitySection('user', u.id)}
      <p class="small muted">Account created ${esc(when(u.createdAt))}.</p>`;

    const root = $b();
    const users = (body) => api('gm/users', { method: 'POST', body: { userId: u.id, ...body } });
    root.querySelector('#pf-rp').addEventListener('submit', (e) => {
      e.preventDefault();
      change(e.submitter, () => users({ action: 'rename', rpName: e.target.v.value }), 'Roleplay name saved.').catch(() => {});
    });
    root.querySelector('#pf-un').addEventListener('submit', (e) => {
      e.preventDefault();
      change(e.submitter, () => users({ action: 'setUsername', username: e.target.v.value }), `They now sign in as @${e.target.v.value.trim().toLowerCase()}.`).catch(() => {});
    });
    root.querySelector('#pf-pass').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // gone once the confirm box has been awaited
      if (!(await confirmBox(`Reset ${u.rpName}'s password?`, { ok: 'Make a temporary password', detail: 'They are signed out everywhere. Give them the new password; they can change it from their Ledger.' }))) return;
      const r = await busy(btn, () => users({ action: 'resetPassword', generate: true })).catch(() => null);
      if (!r) return;
      root.querySelector('#pf-temp').innerHTML = `<p class="small" style="margin:.6rem 0 .2rem">New temporary password for ${esc(u.rpName)}:</p>
        <span class="temp-pass">${esc(r.tempPassword)}</span> <button type="button" class="ghost small" id="pf-copy">Copy</button>`;
      root.querySelector('#pf-copy').addEventListener('click', () => navigator.clipboard?.writeText(r.tempPassword).then(() => toast('Copied.')).catch(() => {}));
    });
    root.querySelector('#pf-unlock')?.addEventListener('click', (e) => change(e.currentTarget, () => users({ action: 'unlock' }), 'Unlocked.').catch(() => {}));
    root.querySelector('#pf-role')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; // gone once the confirm box has been awaited
      const toGm = u.role !== 'gm';
      if (!(await confirmBox(toGm ? `Give ${u.rpName} full GM powers?` : `Remove GM powers from ${u.rpName}?`, { ok: toGm ? 'Make GM' : 'Make player', danger: toGm }))) return;
      change(btn, () => users({ action: 'setRole', role: toGm ? 'gm' : 'player' }), toGm ? `${u.rpName} is now a GM.` : `${u.rpName} is now a player.`).catch(() => {});
    });
    root.querySelector('#pf-disable')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; // gone once the confirm box has been awaited
      if (!u.disabled && !(await confirmBox(`Disable ${u.rpName}?`, { ok: 'Disable', danger: true, detail: 'They are signed out and cannot sign in until you enable the account again. Nothing they own is touched.' }))) return;
      change(btn, () => users({ action: 'setDisabled', disabled: !u.disabled }), u.disabled ? 'Account enabled.' : 'Account disabled.').catch(() => {});
    });
    root.querySelectorAll('select[data-role-company]').forEach((sel) => sel.addEventListener('change', () => {
      const m = d.memberships.find((x) => x.companyId === Number(sel.dataset.roleCompany));
      change(null, () => api('gm/companies', { method: 'POST', body: { action: 'setMember', companyId: m.companyId, userId: u.id, role: sel.value } }),
        `${u.rpName} is now ${sel.value} of ${m.name}.`).catch(() => reload());
    }));
    root.querySelectorAll('button[data-remove-company]').forEach((b) => b.addEventListener('click', async () => {
      const m = d.memberships.find((x) => x.companyId === Number(b.dataset.removeCompany));
      if (!(await confirmBox(`Remove ${u.rpName} from ${m.name}?`, { ok: 'Remove', danger: true, detail: 'They will no longer be able to act for the company. Their own shares are not affected.' }))) return;
      change(b, () => api('gm/companies', { method: 'POST', body: { action: 'setMember', companyId: m.companyId, userId: u.id, role: null } }), `Removed from ${m.name}.`).catch(() => {});
    }));
    root.querySelector('#pf-join')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const name = f.company.selectedOptions[0].textContent;
      change(e.submitter, () => api('gm/companies', { method: 'POST', body: { action: 'setMember', companyId: Number(f.company.value), userId: u.id, role: f.role.value } }),
        `${u.rpName} is now ${f.role.value} of ${name}.`).catch(() => {});
    });
    bindAssignPile(root, 'user', u.id, u.rpName);
    bindMoney(root);
  }

  /* ── Companies ── */
  function renderCompany() {
    const c = d.company;
    panel.querySelector('#pf-title').textContent = c.name;
    panel.querySelector('#pf-sub').innerHTML = `<span class="ticker">${esc(c.ticker)}</span>
      ${c.kind === 'npc' ? '<span class="tag base">NPC-run</span>' : c.kind === 'house' ? '<span class="tag off">old stock</span>' : 'Player-run'}
      ${c.active ? '' : '<span class="tag off">dissolved</span>'} · home ${esc(c.homeSettlementName ?? '—')}
      ${c.sharePrice != null ? ` · ${esc(formatPrice(c.sharePrice, base()))}/share` : ''}`;
    const addable = d.users.filter((u) => !u.disabled && !d.members.some((m) => m.userId === u.id));
    const placeOpts = (sel) => d.settlements.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    $b().innerHTML = `
      <section><h3>Directors &amp; officers</h3>
        <ul class="row-list">${d.members.map((m) => `
          <li><button type="button" class="linkish" data-open-user="${m.userId}">${esc(m.rpName)}</button>
            <span class="nowrap"><select class="small" data-role-user="${m.userId}" aria-label="Role of ${esc(m.rpName)}">
              <option value="director" ${m.role === 'director' ? 'selected' : ''}>Director</option>
              <option value="officer" ${m.role === 'officer' ? 'selected' : ''}>Officer</option></select>
            <button type="button" class="ghost small" data-remove-user="${m.userId}" title="Remove ${esc(m.rpName)}">✕</button></span></li>`).join('')
          || `<li class="muted small">${c.kind === 'npc' ? 'NPC-run: no player officers needed.' : 'Nobody yet.'}</li>`}</ul>
        ${addable.length ? `<form class="inline-form" id="pf-add">
          <div><label>Add player</label><select class="small" name="user">${addable.map((u) => `<option value="${u.id}">${esc(u.rpName)} (@${esc(u.username)})</option>`).join('')}</select></div>
          <div style="flex:0 1 110px"><label>Role</label><select class="small" name="role"><option value="officer">Officer</option><option value="director">Director</option></select></div>
          <button type="submit" class="small">Add</button></form>` : ''}
        <p class="small muted" style="margin:.4rem 0 0">Officers can spend the treasury, move goods and trade. Directors can also declare dividends.</p>
      </section>

      <section><h3>Details</h3>
        <form id="pf-co">
          <div class="inline-form" style="margin-top:0">
            <div style="flex:2 1 200px"><label>Name</label><input class="small" name="name" value="${esc(c.name)}" maxlength="60"></div>
            <div style="flex:0 1 90px"><label>Ticker</label><input class="small mono" name="ticker" value="${esc(c.ticker)}" maxlength="6"></div>
          </div>
          <div class="inline-form">
            <div><label>Home port</label><select class="small" name="home"><option value="">—</option>${placeOpts(c.homeSettlementId)}</select></div>
            ${c.kind === 'house' ? '' : `<div><label>Run by</label><select class="small" name="kind">
              <option value="player" ${c.kind !== 'npc' ? 'selected' : ''}>Players</option><option value="npc" ${c.kind === 'npc' ? 'selected' : ''}>NPCs</option></select></div>`}
          </div>
          <div class="inline-form"><div><label>Description</label><input class="small" name="desc" value="${esc(c.description ?? '')}" maxlength="500"></div></div>
          <div class="inline-form"><div><label>Charter terms</label><textarea class="small" name="charter" rows="2" maxlength="2000">${esc(c.charter ?? '')}</textarea></div></div>
          <div class="actions-row"><button type="submit" class="small">Save details</button>
            <button type="button" class="ghost small ${c.active ? 'danger' : ''}" id="pf-dissolve">${c.active ? 'Dissolve…' : 'Restore charter'}</button></div>
        </form>
      </section>
      ${moneySection('company', c.id)}

      <section><h3>Stockpiles</h3>
        <ul class="row-list">${d.stockpiles.map((p) => {
          const others = d.stockpiles.filter((o) => o.id !== p.id && o.settlementId === p.settlementId);
          return `<li style="flex-wrap:wrap"><span><strong>${esc(p.name)}</strong> <span class="small muted">${esc(p.settlementName ?? '?')} · ${esc(p.kind)} · ${p.used.toLocaleString()}${p.capacity != null ? ` / ${p.capacity.toLocaleString()}` : ''}</span>
            <div class="small">${p.items.map((i) => `${i.qty.toLocaleString()} ${esc(i.name)}`).join(' · ') || '<span class="muted">empty</span>'}</div></span>
            ${others.length ? `<label class="small nowrap">haul →
              <select class="small" data-haul="${p.id}"><option value="">nowhere</option>${others.map((o) => `<option value="${o.id}" ${o.id === p.haulToId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>` : ''}</li>`;
        }).join('') || '<li class="muted small">No stockpiles.</li>'}</ul>
        ${assignPileForm()}
      </section>

      ${d.npc ? `<section><h3>NPC behaviour</h3>
        <p class="small muted" style="margin:0 0 .4rem">Each time you advance time, this company runs itself with these rules. Hover a setting for what it does.</p>
        <form id="pf-npc">${policyFields(d.npc.policy)}
          <div class="actions-row"><button type="submit" class="small">Save behaviour</button>
            <button type="button" class="ghost small" id="pf-npc-reset">Reset to defaults</button></div></form>
        <h4 class="small" style="margin:.8rem 0 .2rem">Last advance${d.npc.last?.day != null ? ` <span class="muted">(${esc(day(d.npc.last.day))})</span>` : ''}</h4>
        ${lastActivity(d.npc.last)}
      </section>` : ''}

      <section><h3>Operations</h3>
        <div class="small"><strong>Workplaces:</strong> ${d.workplaces.map((w) => `${esc(w.name)} <span class="muted">(${esc(w.place ?? '?')}${w.mode !== 'none' ? `, ${esc(w.mode)}` : ''})</span>`).join(' · ') || '<span class="muted">none</span>'}</div>
      </section>

      ${c.kind === 'house' ? '' : `<section><h3>Shareholders</h3>
        <p class="small muted" style="margin:0 0 .3rem">${c.sharesTotal.toLocaleString()} shares issued${c.bookValue != null ? ` · book value ${esc(formatMoney(c.bookValue, base()))}` : ''}. Manage the register under GM → Exchange.</p>
        <ul class="row-list">${d.holders.map((h) => `<li><span>${esc(h.name)}${h.treasury ? ' <span class="small muted">(treasury)</span>' : ''}</span>
          <span class="mono small">${h.qty.toLocaleString()} · ${c.sharesTotal ? ((h.qty / c.sharesTotal) * 100).toFixed(1) : 0}%</span></li>`).join('')}</ul></section>`}
      ${sharesSection()}
      ${activitySection('company', c.id)}`;

    const root = $b();
    const setMember = (userId, role) => api('gm/companies', { method: 'POST', body: { action: 'setMember', companyId: c.id, userId, role } });
    root.querySelectorAll('select[data-role-user]').forEach((sel) => sel.addEventListener('change', () => {
      const m = d.members.find((x) => x.userId === Number(sel.dataset.roleUser));
      change(null, () => setMember(m.userId, sel.value), `${m.rpName} is now ${sel.value}.`).catch(() => reload());
    }));
    root.querySelectorAll('button[data-remove-user]').forEach((b) => b.addEventListener('click', async () => {
      const m = d.members.find((x) => x.userId === Number(b.dataset.removeUser));
      if (!(await confirmBox(`Remove ${m.rpName} from ${c.name}?`, { ok: 'Remove', danger: true, detail: 'They will no longer be able to act for the company. Their own shares are not affected.' }))) return;
      change(b, () => setMember(m.userId, null), `${m.rpName} removed.`).catch(() => {});
    }));
    root.querySelector('#pf-add')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const name = f.user.selectedOptions[0].textContent.replace(/ \(@.*\)$/, '');
      change(e.submitter, () => setMember(Number(f.user.value), f.role.value), `${name} is now ${f.role.value}.`).catch(() => {});
    });
    const saveCompany = (extra = {}) => {
      const f = root.querySelector('#pf-co');
      return api('gm/companies', { method: 'POST', body: {
        action: 'saveCompany', id: c.id, name: f.name.value, ticker: f.ticker.value, homeSettlementId: Number(f.home.value) || null,
        description: f.desc.value, charter: f.charter.value, active: c.active, kind: f.kind?.value ?? c.kind, ...extra,
      } });
    };
    root.querySelector('#pf-co').addEventListener('submit', (e) => {
      e.preventDefault();
      change(e.submitter, () => saveCompany(), 'Company details saved.').catch(() => {});
    });
    root.querySelector('#pf-dissolve').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // gone once the confirm box has been awaited
      if (c.active && !(await confirmBox(`Dissolve ${c.name}?`, { ok: 'Dissolve', danger: true, detail: 'Its officers can no longer act for it. Its money, goods and shares stay where they are, and you can restore it later.' }))) return;
      change(btn, () => saveCompany({ active: !c.active }), c.active ? `${c.name} dissolved.` : `${c.name} restored.`).catch(() => {});
    });
    root.querySelectorAll('select[data-haul]').forEach((sel) => sel.addEventListener('change', () => {
      change(null, () => api('company', { method: 'POST', body: { action: 'setHaul', companyId: c.id, stockpileId: Number(sel.dataset.haul), toStockpileId: Number(sel.value) || null } }),
        sel.value ? `Auto-haul set to ${sel.selectedOptions[0].textContent}.` : 'Auto-haul off.').catch(() => reload());
    }));
    bindAssignPile(root, 'company', c.id, c.name);
    const savePolicy = (policy) => api('gm/npc', { method: 'POST', body: { action: 'savePolicy', companyId: c.id, policy } });
    root.querySelector('#pf-npc')?.addEventListener('submit', (e) => {
      e.preventDefault();
      change(e.submitter, () => savePolicy(readPolicy(e.target)), 'NPC behaviour saved.').catch(() => {});
    });
    root.querySelector('#pf-npc-reset')?.addEventListener('click', (e) => {
      change(e.currentTarget, () => savePolicy(d.npc.defaults), 'Back to the default behaviour.').catch(() => {});
    });
    bindMoney(root);
  }

  return { open, close, reload };
}
