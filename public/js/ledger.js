// Ledger (home) page: purse, sending money, money-changer, history.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox } from './common.js';
import {
  formatMoney, convertMinor, describeRate, exchangeQuote, amountInput, currencyOptions,
} from './money.js';
import { viewerRow, itemRow, stockpileBlock } from './tx-format.js';

const $ = (id) => document.getElementById(id);
const user = await requireSession();
$('greeting').textContent = `Ledger of ${user.rpName}`;

const state = { currencies: [], balances: [], transactions: [], nextBefore: null, feePct: 0, calendar: null };
const active = () => state.currencies.filter((c) => c.active);
const base = () => state.currencies.find((c) => c.isBase);
const balanceOf = (id) => state.balances.find((b) => b.currencyId === id)?.balance ?? 0;

/* ── Purse ─────────────────────────────────────────────── */
function renderPurse() {
  $('purse').innerHTML = state.currencies.map((c) => {
    const bal = balanceOf(c.id);
    return `<li class="${bal ? '' : 'zero'}">
      <span class="cname">${esc(c.name)}${c.active ? '' : ' <span class="tag off">retired</span>'}</span>
      <span class="amt">${esc(formatMoney(bal, c))}</span></li>`;
  }).join('') || '<li class="muted">No currencies yet.</li>';

  const b = base();
  const total = state.currencies.reduce((sum, c) => sum + (b ? convertMinor(balanceOf(c.id), c, b) : 0), 0);
  $('purse-total').textContent = b ? formatMoney(total, b) : '—';
}

/* ── Send money ────────────────────────────────────────── */
const send = amountInput({
  select: $('send-cur'), whole: $('send-whole'), sub: $('send-sub'),
  wholeLabel: $('send-whole-label'), subLabel: $('send-sub-label'),
}, active);

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = send.currency();
  const amount = send.read();
  const to = $('send-to').selectedOptions[0];
  if (!to?.value) return toast('Choose who to pay.', true);
  if (amount <= 0) return toast('Enter an amount.', true);
  if (!await confirmBox(`Send ${formatMoney(amount, cur)} to ${to.textContent}?`)) return;
  const [kind, id] = to.value.split(':');
  busy(e.submitter, async () => {
    await api('transfer', {
      method: 'POST',
      body: { [kind === 'company' ? 'toCompanyId' : 'toUserId']: Number(id), currencyId: cur.id, amount, memo: $('send-memo').value },
    });
    send.clear();
    $('send-memo').value = '';
    toast(`Sent ${formatMoney(amount, cur)} to ${to.textContent}.`);
    await loadWallet();
  }).catch(() => {});
});

/* ── Money-changer ─────────────────────────────────────── */
const ex = amountInput({
  select: $('ex-from'), whole: $('ex-whole'), sub: $('ex-sub'),
  wholeLabel: $('ex-whole-label'), subLabel: $('ex-sub-label'),
}, active);
const exTo = () => active().find((c) => c.id === Number($('ex-to').value));

function renderQuote() {
  const from = ex.currency();
  const to = exTo();
  const amount = ex.read();
  if (!from || !to || from.id === to.id) {
    $('ex-quote').textContent = 'Pick two different currencies.';
    $('ex-submit').disabled = true;
    return;
  }
  const received = exchangeQuote(amount, from, to, state.feePct);
  $('ex-quote').textContent = amount > 0 ? `${formatMoney(amount, from)}  →  ${formatMoney(received, to)}` : '—';
  $('ex-submit').disabled = amount <= 0 || received < 1;
}
['ex-from', 'ex-to', 'ex-whole', 'ex-sub'].forEach((id) => $(id).addEventListener('input', renderQuote));

$('ex-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const from = ex.currency();
  const to = exTo();
  const amount = ex.read();
  busy(e.submitter, async () => {
    const r = await api('exchange', {
      method: 'POST', body: { fromCurrencyId: from.id, toCurrencyId: to.id, amount },
    });
    ex.clear();
    toast(`Exchanged ${formatMoney(amount, from)} for ${formatMoney(r.received, to)}.`);
    await loadWallet();
  }).catch(() => {}).finally(renderQuote); // re-check the button after busy() re-enables it
});

/* ── History ───────────────────────────────────────────── */
function renderHistory() {
  $('tx-rows').innerHTML = state.transactions
    .map((t) => viewerRow(t, user.id, state.currencies, state.calendar)).join('')
    || '<tr><td colspan="3" class="muted">No entries yet.</td></tr>';
  $('tx-more').classList.toggle('hidden', !state.nextBefore);
}

$('tx-more').addEventListener('click', (e) => {
  busy(e.currentTarget, async () => {
    const r = await api(`wallet?before=${state.nextBefore}`);
    state.transactions.push(...r.transactions);
    state.nextBefore = r.nextBefore;
    renderHistory();
  }).catch(() => {});
});

/* ── Holdings & goods log ─────────────────────────────── */
const items = { list: [], piles: [], entries: [], nextBefore: null };

function renderItems() {
  $('holdings').innerHTML = items.piles.map(stockpileBlock).join('') || '<p class="muted">You hold no goods.</p>';
  const keep = $('give-good').value;
  $('give-good').innerHTML = items.list.map((i) => `<option value="${i.goodId}">${esc(i.name)} (${i.qty})</option>`).join('');
  if ([...$('give-good').options].some((o) => o.value === keep)) $('give-good').value = keep;
  $('give-form').querySelector('button').disabled = !items.list.length;
  $('item-rows').innerHTML = items.entries.map((e) => itemRow(e, user.id, state.calendar)).join('')
    || '<tr><td colspan="3" class="muted">No goods have changed hands yet.</td></tr>';
  $('item-more').classList.toggle('hidden', !items.nextBefore);
}

async function loadItems() {
  const r = await api('inventory');
  Object.assign(items, { list: r.items, piles: r.stockpiles, entries: r.entries, nextBefore: r.nextBefore });
  renderItems();
}

$('item-more').addEventListener('click', (e) => {
  busy(e.currentTarget, async () => {
    const r = await api(`inventory?before=${items.nextBefore}`);
    items.entries.push(...r.entries);
    items.nextBefore = r.nextBefore;
    renderItems();
  }).catch(() => {});
});

$('give-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = $('give-to').selectedOptions[0];
  const good = items.list.find((i) => i.goodId === Number($('give-good').value));
  const qty = Number($('give-qty').value);
  if (!to?.value) return toast('Choose who to give to.', true);
  if (!good) return;
  if (!await confirmBox(`Give ${qty} ${good.unit} of ${good.name} to ${to.textContent}?`)) return;
  busy(e.submitter, async () => {
    await api('inventory', { method: 'POST', body: { action: 'give', toUserId: Number(to.value), goodId: good.goodId, qty, memo: $('give-memo').value } });
    $('give-memo').value = '';
    toast(`Gave ${qty} × ${good.name} to ${to.textContent}.`);
    await loadItems();
  }).catch(() => {});
});

/* ── Currencies table ──────────────────────────────────── */
function renderCurrencies() {
  $('currency-rows').innerHTML = active().map((c) => `
    <tr>
      <td>${esc(c.symbol)} &nbsp;${esc(c.name)} ${c.isBase ? '<span class="tag base">base</span>' : ''}</td>
      <td class="mono">${esc(c.code)}</td>
      <td>${c.subunitsPerUnit} ${esc(c.subunitName)} (${esc(c.subunitSymbol)})</td>
      <td class="num">${esc(describeRate(c, base()))}</td>
    </tr>`).join('');
}

/* ── Account ───────────────────────────────────────────── */
function renderAccount(firms) {
  const mine = firms.filter((c) => c.myRole);
  $('acct-info').innerHTML = `<dt>Name</dt><dd>${esc(user.rpName)}</dd>
    <dt>Signs in as</dt><dd class="mono">@${esc(user.username)}</dd>
    <dt>Companies</dt><dd>${mine.map((c) => `<a href="companies.html?c=${c.id}">${esc(c.name)}</a> <span class="small muted">${esc(c.myRole)}</span>`).join('<br>')
      || '<span class="muted">none</span>'}</dd>`;
}

$('pw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('pw-new').value !== $('pw-again').value) { toast("The two new passwords don't match.", true); return; }
  busy(e.submitter, async () => {
    await api('account', {
      method: 'POST',
      body: { action: 'changePassword', currentPassword: $('pw-current').value, newPassword: $('pw-new').value },
    });
    e.target.reset();
    toast('Password changed. Other devices have been signed out.');
  }).catch(() => {});
});

/* ── Load ──────────────────────────────────────────────── */
function fillSelect(select, html) {
  const keep = select.value;
  select.innerHTML = html;
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

async function loadWallet() {
  const r = await api('wallet');
  Object.assign(state, {
    currencies: r.currencies, balances: r.balances, transactions: r.transactions,
    nextBefore: r.nextBefore, feePct: r.exchangeFeePct,
  });
  const opts = currencyOptions(active());
  fillSelect($('send-cur'), opts);
  const hadEx = $('ex-to').value;
  fillSelect($('ex-from'), opts);
  fillSelect($('ex-to'), opts);
  if (!hadEx && active().length > 1) $('ex-to').selectedIndex = 1;
  send.refresh();
  ex.refresh();
  // With a single currency there is nothing to exchange: hide the money-changer.
  $('ex-panel').classList.toggle('hidden', active().length < 2);
  $('fee-note').textContent = state.feePct
    ? `Swap currencies at today's rates. The money-changer keeps ${state.feePct}%.`
    : "Swap one currency for another at today's rates.";
  renderPurse();
  renderQuote();
  renderHistory();
  renderCurrencies();
}

try {
  const [clock, players, firms] = await Promise.all([getClock(), api('players'), api('companies')]);
  state.calendar = clock.calendar;
  const people = players.players.filter((p) => p.id !== user.id);
  $('send-to').innerHTML = '<option value="">— choose —</option>'
    + `<optgroup label="People">${people.map((p) => `<option value="user:${p.id}">${esc(p.rpName)}${p.gm ? ' (GM)' : ''}</option>`).join('')}</optgroup>`
    + (firms.companies.length ? `<optgroup label="Company treasuries">${firms.companies
      .map((c) => `<option value="company:${c.id}">${esc(c.name)} (${esc(c.ticker)})</option>`).join('')}</optgroup>` : '');
  $('give-to').innerHTML = '<option value="">— choose —</option>'
    + people.map((p) => `<option value="${p.id}">${esc(p.rpName)}${p.gm ? ' (GM)' : ''}</option>`).join('');
  renderAccount(firms.companies);
  await Promise.all([loadWallet(), loadItems()]);
} catch (err) {
  toast(err.message, true);
}
