// GM Console → Treasury: grant / seize / set balances, see everyone's purse, audit and reverse entries.
import { api } from '../api.js';
import { esc, toast, busy, getClock, confirmBox } from '../common.js';
import { formatMoney, amountInput, currencyOptions } from '../money.js';
import { gmRow } from '../tx-format.js';

export function init({ $, on, emit, openProfile }) {
  const st = { players: [], companies: [], currencies: [], transactions: [], nextBefore: null, calendar: null, filter: '' };
  const qs = () => {
    if (!st.filter) return '';
    const [type, id] = st.filter.split(':');
    return `?ownerType=${type}&ownerId=${id}`;
  };

  const amount = amountInput({
    select: $('m-cur'), whole: $('m-whole'), sub: $('m-sub'),
    wholeLabel: $('m-whole-label'), subLabel: $('m-sub-label'),
  }, () => st.currencies);

  function apply(r) {
    Object.assign(st, {
      players: r.players, companies: r.companies ?? [], currencies: r.currencies,
      transactions: r.transactions, nextBefore: r.nextBefore,
    });
    renderForm();
    renderMatrix();
    renderLedger();
    emit('players', st.players);
  }

  const load = () => api(`gm/money${qs()}`).then(apply).catch((err) => toast(err.message, true));

  /* ── Issue / collect form ── */
  function keep(select, html) {
    const v = select.value;
    select.innerHTML = html;
    if ([...select.options].some((o) => o.value === v)) select.value = v;
  }

  function renderForm() {
    const action = $('m-action').value;
    const people = st.players.filter((p) => !p.disabled)
      .map((p) => `<option value="user:${p.id}">${esc(p.rpName)}${p.role === 'gm' ? ' (GM)' : ''}</option>`).join('');
    const firms = st.companies.filter((c) => c.active)
      .map((c) => `<option value="company:${c.id}">${esc(c.name)} (${esc(c.ticker)})</option>`).join('');
    keep($('m-user'), (action === 'grant' ? '<option value="all">★ All players</option>' : '')
      + `<optgroup label="Players">${people}</optgroup>` + (firms ? `<optgroup label="Companies">${firms}</optgroup>` : ''));

    const usable = action === 'grant' ? st.currencies.filter((c) => c.active) : st.currencies;
    keep($('m-cur'), currencyOptions(usable));
    amount.refresh();

    $('m-submit').textContent = { grant: 'Grant', seize: 'Seize', set: 'Set Balance' }[action];
  }
  $('m-action').addEventListener('change', renderForm);

  $('m-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = $('m-action').value;
    const cur = amount.currency();
    const minor = amount.read();
    const who = $('m-user').selectedOptions[0];
    if (!who || !cur) return;
    if (action !== 'set' && minor <= 0) return toast('Enter an amount.', true);

    const body = { action, currencyId: cur.id, amount: minor, memo: $('m-memo').value };
    if (action === 'grant') body.accounts = who.value === 'all' ? 'all' : [who.value];
    else {
      const [ownerType, ownerId] = who.value.split(':');
      Object.assign(body, { ownerType, ownerId: Number(ownerId) });
    }

    const verb = { grant: 'Grant', seize: 'Seize', set: 'Set balance to' }[action];
    const target = who.value === 'all' ? 'every player' : who.textContent;
    const msg = action === 'set'
      ? `Set ${target}'s ${cur.name} to ${formatMoney(minor, cur)}?`
      : `${verb} ${formatMoney(minor, cur)} ${action === 'grant' ? 'to' : 'from'} ${target}?`;
    if (!await confirmBox(msg)) return;

    busy(e.submitter, () => api(`gm/money${qs()}`, { method: 'POST', body }))
      .then((r) => { apply(r); amount.clear(); $('m-memo').value = ''; toast('Treasury updated.'); })
      .catch(() => {});
  });

  /* ── Balance matrix ── */
  function renderMatrix() {
    const accounts = [...st.players, ...st.companies];
    const cols = st.currencies.filter((c) => c.active || accounts.some((p) => p.balances[c.id]));
    const cells = (bal) => cols.map((c) => {
      const v = bal[c.id] ?? 0;
      return `<td class="num ${v ? '' : 'zero'}">${esc(formatMoney(v, c, { compact: true }))}</td>`;
    }).join('');
    $('bal-head').innerHTML = `<tr><th>Account</th>${cols.map((c) => `<th class="num">${esc(c.code)}</th>`).join('')}</tr>`;
    $('bal-rows').innerHTML = st.players.map((p) => `
      <tr class="${p.disabled ? 'inactive' : ''}">
        <td><button type="button" class="linkish" data-owner="user:${p.id}">${esc(p.rpName)}</button>${p.role === 'gm' ? ' <span class="tag gm">GM</span>' : ''}</td>${cells(p.balances)}
      </tr>`).join('')
      + (st.companies.length ? `<tr class="cat-row"><td colspan="${cols.length + 1}">Companies</td></tr>` : '')
      + st.companies.map((c) => `
      <tr class="${c.active ? '' : 'inactive'}"><td><button type="button" class="linkish" data-owner="company:${c.id}">${esc(c.name)}</button> <span class="ticker">${esc(c.ticker)}</span></td>${cells(c.balances)}</tr>`).join('');
  }
  $('bal-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-owner]');
    if (!b) return;
    const [t, id] = b.dataset.owner.split(':');
    openProfile(t, Number(id));
  });

  /* ── Ledger ── */
  function renderLedger() {
    keep($('l-filter'), '<option value="">All accounts</option>'
      + `<optgroup label="Players">${st.players.map((p) => `<option value="user:${p.id}">${esc(p.rpName)}</option>`).join('')}</optgroup>`
      + (st.companies.length ? `<optgroup label="Companies">${st.companies.map((c) => `<option value="company:${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>` : ''));
    $('l-rows').innerHTML = st.transactions.map((t) => gmRow(t, st.currencies, st.calendar)).join('')
      || '<tr><td colspan="6" class="muted">No entries yet.</td></tr>';
    $('l-more').classList.toggle('hidden', !st.nextBefore);
  }

  $('l-filter').addEventListener('change', (e) => { st.filter = e.target.value; load(); });

  $('l-more').addEventListener('click', (e) => {
    const sep = st.filter ? '&' : '?';
    busy(e.currentTarget, () => api(`gm/money${qs()}${sep}before=${st.nextBefore}`)).then((r) => {
      st.transactions.push(...r.transactions);
      st.nextBefore = r.nextBefore;
      renderLedger();
    }).catch(() => {});
  });

  $('l-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-reverse]');
    if (!btn) return;
    const t = st.transactions.find((x) => x.id === Number(btn.dataset.reverse));
    const linked = t.groupId ? ' Linked entries (e.g. both sides of an exchange) are reversed together.' : '';
    if (!await confirmBox(`Reverse entry #${t.id}? The money moves back.${linked}`)) return;
    busy(btn, () => api(`gm/money${qs()}`, { method: 'POST', body: { action: 'reverse', transactionId: t.id } }))
      .then((r) => { apply(r); toast(`Entry #${t.id} reversed.`); }).catch(() => {});
  });

  /* ── React to other tabs ── */
  on('currencies', () => load());
  on('companies', () => load());
  on('tab', (name) => { if (name === 'treasury') load(); });
  on('refresh', load);
  on('clock', (s) => { st.calendar = s.calendar; renderLedger(); });

  getClock().then((c) => { st.calendar = c.calendar; }).finally(load);
}
