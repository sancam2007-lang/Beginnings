// Companies page: the public register, plus full books for companies you serve.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox } from './common.js';
import { formatMoney, convertMinor, amountInput, currencyOptions } from './money.js';
import { formatDay } from './calendar.js';
import { viewerRow, itemRow, stockpileBlock } from './tx-format.js';

const $ = (id) => document.getElementById(id);
const user = await requireSession();

const st = {
  companies: [], players: [], calendar: null, myPiles: [],
  selected: Number(new URLSearchParams(location.search).get('c')) || null,
  book: null,
};
const mine = () => st.companies.filter((c) => c.myRole || user.role === 'gm');
const activeCur = () => (st.book?.currencies ?? []).filter((c) => c.active);

/* ── Register ── */
function renderRegister() {
  $('register').innerHTML = st.companies.map((c) => `
    <tr>
      <td><strong>${esc(c.name)}</strong> <span class="ticker">${esc(c.ticker)}</span>
        ${c.description ? `<div class="small muted">${esc(c.description)}</div>` : ''}</td>
      <td>${esc(c.homeSettlementName ?? '—')}</td>
      <td class="small">${c.members.map((m) => `${esc(m.rpName)}${m.role === 'director' ? ' <span class="tag gm">director</span>' : ''}`).join(', ') || '<span class="muted">—</span>'}</td>
      <td class="small nowrap">${esc(formatDay(c.foundedDay, st.calendar))}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No companies have been chartered yet.</td></tr>';
}

/* ── Your company ── */
function renderTabs() {
  $('mine').classList.toggle('hidden', !mine().length);
  $('company-tabs').innerHTML = mine().map((c) => `
    <button type="button" data-id="${c.id}" class="${c.id === st.selected ? 'active' : ''}">${esc(c.name)}</button>`).join('');
}

const pay = amountInput({
  select: $('pay-cur'), whole: $('pay-whole'), sub: $('pay-sub'),
  wholeLabel: $('pay-whole-label'), subLabel: $('pay-sub-label'),
}, activeCur);

function renderBook() {
  const b = st.book;
  const c = b.company;
  $('c-name').textContent = c.name;
  $('c-ticker').textContent = c.ticker;
  $('c-meta').textContent = [
    c.homeSettlementName && `Home port: ${c.homeSettlementName}`,
    `Chartered ${formatDay(c.foundedDay, st.calendar)}`,
    `You are ${b.myRole === 'gm' ? 'the GM' : `a ${b.myRole}`}`,
  ].filter(Boolean).join(' · ');
  $('c-charter').textContent = c.charter ?? '';
  $('c-charter').classList.toggle('hidden', !c.charter);

  const base = b.currencies.find((x) => x.isBase);
  const shown = b.currencies.filter((x) => x.active || b.balances[x.id]);
  $('c-balances').innerHTML = shown.map((x) => `
    <li class="${b.balances[x.id] ? '' : 'zero'}"><span class="cname">${esc(x.name)}</span>
      <span class="amt">${esc(formatMoney(b.balances[x.id] ?? 0, x))}</span></li>`).join('');
  const total = shown.reduce((s, x) => s + convertMinor(b.balances[x.id] ?? 0, x, base), 0);
  $('c-total').textContent = base ? formatMoney(total, base) : '—';

  $('c-members').innerHTML = b.members.map((m) => `
    <li><span class="cname">${esc(m.rpName)}</span>
      <span class="small">${m.role === 'director' ? '<span class="tag gm">director</span>' : 'officer'}</span></li>`).join('')
    || '<li class="muted">No officers.</li>';

  $('c-piles').innerHTML = b.stockpiles.map((p) => {
    // Auto-haul: send this stockpile's goods to another depot of the company in the same town.
    const others = b.stockpiles.filter((o) => o.id !== p.id && o.settlementId === p.settlementId);
    const haul = others.length ? `<label class="small haul-row">Auto-haul to
      <select class="small" data-haul="${p.id}"><option value="">— nowhere —</option>${others.map((o) => `<option value="${o.id}" ${o.id === p.haulToId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
      <span class="muted">each time the GM advances time${p.kind === 'facility' ? ' (a workplace store sends only what it produces)' : ''}</span></label>` : '';
    return stockpileBlock(p).replace(/<\/div>$/, `${haul}</div>`);
  }).join('')
    || '<p class="muted">This company has no stockpiles yet. The GM assigns warehouses and depots.</p>';

  $('c-tx').innerHTML = b.transactions.map((t) => viewerRow(t, c.id, b.currencies, st.calendar, 'company')).join('')
    || '<tr><td colspan="3" class="muted">No entries yet.</td></tr>';
  $('c-tx-more').classList.toggle('hidden', !b.nextBefore);
  $('c-goods').innerHTML = b.goodsLog.map((e) => itemRow(e, c.id, st.calendar, { viewerType: 'company' })).join('')
    || '<tr><td colspan="3" class="muted">No goods have moved yet.</td></tr>';

  // Pay form
  const keepCur = $('pay-cur').value;
  $('pay-cur').innerHTML = currencyOptions(activeCur());
  if (keepCur) $('pay-cur').value = keepCur;
  pay.refresh();
  $('pay-to').innerHTML = '<option value="">— choose —</option>'
    + `<optgroup label="People">${st.players.map((p) => `<option value="user:${p.id}">${esc(p.rpName)}</option>`).join('')}</optgroup>`
    + `<optgroup label="Companies">${st.companies.filter((x) => x.id !== c.id)
      .map((x) => `<option value="company:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>`;

  renderMoveForm();
}

/* ── Move goods ── */
function allPiles() {
  const company = st.book.stockpiles.map((p) => ({ ...p, label: `${st.book.company.name} — ${p.name} (${p.settlementName})` }));
  const own = st.myPiles.map((p) => ({ ...p, label: p.kind === 'personal' ? 'Your pack' : `Your ${p.name} (${p.settlementName})` }));
  return [...company, ...own];
}

function renderMoveForm() {
  const piles = allPiles();
  const opts = piles.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  const keepFrom = $('mv-from').value;
  const keepTo = $('mv-to').value;
  $('mv-from').innerHTML = opts;
  $('mv-to').innerHTML = opts;
  if (keepFrom && piles.some((p) => String(p.id) === keepFrom)) $('mv-from').value = keepFrom;
  if (keepTo && piles.some((p) => String(p.id) === keepTo)) $('mv-to').value = keepTo;
  else if (piles.length > 1) $('mv-to').selectedIndex = 1;
  renderMoveGoods();
}

function renderMoveGoods() {
  const from = allPiles().find((p) => p.id === Number($('mv-from').value));
  const goods = from?.items ?? [];
  $('mv-good').innerHTML = goods.map((i) => `<option value="${i.goodId}">${esc(i.name)} (${i.qty.toLocaleString()} ${esc(i.unit)})</option>`).join('')
    || '<option value="">— nothing here —</option>';
  $('mv-form').querySelector('button').disabled = !goods.length;
}
$('mv-from').addEventListener('change', renderMoveGoods);

$('mv-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = {
    fromStockpileId: Number($('mv-from').value), toStockpileId: Number($('mv-to').value),
    goodId: Number($('mv-good').value), qty: Number($('mv-qty').value), memo: $('mv-memo').value,
  };
  busy(e.submitter, async () => {
    await api('stock-move', { method: 'POST', body });
    $('mv-memo').value = '';
    toast('Goods moved.');
    await Promise.all([loadBook(), loadMyPiles()]);
  }).catch(() => {});
});

$('pay-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = $('pay-to').selectedOptions[0];
  const cur = pay.currency();
  const amount = pay.read();
  if (!to?.value) return toast('Choose who to pay.', true);
  if (amount <= 0) return toast('Enter an amount.', true);
  if (!await confirmBox(`Pay ${formatMoney(amount, cur)} from ${st.book.company.name} to ${to.textContent}?`)) return;
  const [toType, toId] = to.value.split(':');
  busy(e.submitter, async () => {
    await api('company', {
      method: 'POST',
      body: { action: 'pay', companyId: st.selected, toType, toId: Number(toId), currencyId: cur.id, amount, memo: $('pay-memo').value },
    });
    pay.clear();
    $('pay-memo').value = '';
    toast(`Paid ${formatMoney(amount, cur)} to ${to.textContent}.`);
    await loadBook();
  }).catch(() => {});
});

$('c-tx-more').addEventListener('click', (e) => {
  busy(e.currentTarget, async () => {
    const r = await api(`company?id=${st.selected}&before=${st.book.nextBefore}`);
    st.book.transactions.push(...r.transactions);
    st.book.nextBefore = r.nextBefore;
    renderBook();
  }).catch(() => {});
});

$('c-piles').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-haul]');
  if (!sel) return;
  api('company', { method: 'POST', body: { action: 'setHaul', companyId: st.selected, stockpileId: Number(sel.dataset.haul), toStockpileId: Number(sel.value) || null } })
    .then(async (r) => { toast(r.haulToId ? `Goods will be hauled to ${sel.selectedOptions[0].textContent} each time time advances.` : 'Auto-haul turned off.'); await loadBook(); })
    .catch(async (err) => { toast(err.message, true); await loadBook(); });
});

$('company-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  st.selected = Number(b.dataset.id);
  renderTabs();
  loadBook().catch((err) => toast(err.message, true));
});

/* ── Load ── */
async function loadBook() {
  if (!st.selected) return;
  st.book = await api(`company?id=${st.selected}`);
  history.replaceState(null, '', `?c=${st.selected}`);
  renderBook();
}
async function loadMyPiles() {
  st.myPiles = (await api('inventory')).stockpiles;
}

try {
  const [clock, list, players] = await Promise.all([getClock(), api('companies'), api('players')]);
  st.calendar = clock.calendar;
  st.companies = list.companies;
  st.players = players.players;
  renderRegister();
  if (!mine().some((c) => c.id === st.selected)) st.selected = mine()[0]?.id ?? null;
  renderTabs();
  if (st.selected) {
    await loadMyPiles();
    await loadBook();
  }
} catch (err) {
  toast(err.message, true);
}
