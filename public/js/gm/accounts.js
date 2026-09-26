// GM Console → Accounts: every player at a glance. Click a row to open their profile, where names,
// passwords, GM rights, company roles, money and goods are all managed in place.
import { api } from '../api.js';
import { esc, toast, attachFilter } from '../common.js';
import { formatMoney, convertMinor } from '../money.js';

export function init({ $, me, on, openProfile }) {
  let users = [];
  let currencies = [];
  const when = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const purse = (u) => {
    const base = currencies.find((c) => c.isBase);
    if (!base) return '—';
    const total = Object.entries(u.balances).reduce((s, [cid, v]) => {
      const c = currencies.find((x) => x.id === Number(cid));
      return s + (c ? convertMinor(v, c, base) : 0);
    }, 0);
    return total ? formatMoney(total, base) : '<span class="muted">—</span>';
  };

  function render() {
    const showDisabled = $('acct-show-disabled').checked;
    const list = users.filter((u) => showDisabled || !u.disabled);
    $('user-rows').innerHTML = list.map((u) => `
      <tr class="clickable ${u.disabled ? 'inactive' : ''}" data-id="${u.id}">
        <td><strong>${esc(u.rpName)}</strong> ${u.id === me.id ? '<span class="muted small">(you)</span>' : ''}
          <div class="small muted mono">@${esc(u.username)}</div></td>
        <td>${u.role === 'gm' ? '<span class="tag gm">GM</span>' : '<span class="small">Player</span>'}
          ${u.disabled ? '<span class="tag off">disabled</span>' : ''}${u.locked ? '<span class="tag off">locked out</span>' : ''}</td>
        <td><div class="chips">${u.companies.map((c) => `<span class="chip ${c.role}">${esc(c.name)}${c.role === 'director' ? ' <span class="role">dir</span>' : ''}</span>`).join('')
          || '<span class="muted small">—</span>'}</div></td>
        <td class="num">${purse(u)}</td>
        <td class="small">${esc(when(u.lastLoginAt))}</td>
        <td class="num"><button class="ghost small" data-open="${u.id}">Manage</button></td>
      </tr>`).join('') || '<tr data-no-filter><td colspan="6" class="muted">No accounts.</td></tr>';
    const hidden = users.length - list.length;
    $('acct-count').textContent = hidden ? `${hidden} disabled hidden` : '';
  }

  $('user-rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openProfile('user', Number(tr.dataset.id));
  });
  $('acct-show-disabled').addEventListener('change', render);
  attachFilter($('acct-filter'), $('user-rows'));

  const load = () => Promise.all([api('gm/users'), api('currencies')])
    .then(([r, c]) => { users = r.users; currencies = c.currencies; render(); })
    .catch((err) => toast(err.message, true));
  on('refresh', load);
  on('currencies', (list) => { currencies = list; render(); });
  on('tab', (name) => { if (name === 'accounts') load(); });
  load();
}
