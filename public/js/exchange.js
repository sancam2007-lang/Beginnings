// The Exchange: company share prices, order book, trading, holdings and dividends.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox } from './common.js';
import { formatMoney, formatPrice, toMinor } from './money.js';
import { formatDay } from './calendar.js';
import { sparkline, lineChart } from './chart.js';

const $ = (id) => document.getElementById(id);
await requireSession();

const st = { d: null, calendar: null, companyId: Number(new URLSearchParams(location.search).get('c')) || null };
const cur = () => st.d.currency;
const money = (v) => formatMoney(Math.round(v), cur());
const price = (v) => (v == null ? '—' : formatPrice(v, cur()));
const day = (n) => formatDay(n, st.calendar, { short: true });
const heldBy = (companyId, account = null) => st.d.holdings
  .filter((h) => h.companyId === companyId && !h.treasury && (!account || h.account === account)).reduce((s, h) => s + h.qty, 0);

function changeCell(now, prev) {
  if (now == null || prev == null || !prev) return '<span class="muted">—</span>';
  const pct = (now / prev - 1) * 100;
  if (Math.abs(pct) < 0.05) return '<span class="muted">—</span>';
  return `<span class="${pct > 0 ? 'credit' : 'debit'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
}
function confidenceBar(c) {
  const { minConfidence: lo, maxConfidence: hi } = st.d.rules;
  const pos = Math.min(100, Math.max(0, ((c - lo) / (hi - lo)) * 100));
  const mid = ((1 - lo) / (hi - lo)) * 100;
  const mood = c >= 1.15 ? 'bullish' : c <= 0.87 ? 'bearish' : 'steady';
  return `<div class="conf" title="Confidence ${c.toFixed(2)} (range ${lo}–${hi})">
    <div class="conf-track"><span class="conf-mid" style="left:${mid}%"></span><span class="conf-dot" style="left:${pos}%"></span></div>
    <span class="small muted">${c.toFixed(2)} · ${mood}</span></div>`;
}

/* ── Board ── */
function renderBoard() {
  const { board } = st.d;
  $('board').innerHTML = board.map((c) => {
    const mine = heldBy(c.id);
    return `<tr class="${c.id === st.companyId ? 'selected' : ''}" data-id="${c.id}">
      <td class="name-cell"><button class="linklike" data-open="${c.id}">${esc(c.name)}</button>
        <div class="small muted"><span class="mono">${esc(c.ticker)}</span>${c.homeName ? ` · ${esc(c.homeName)}` : ''}</div></td>
      <td class="spark-cell" data-label="Recent">${sparkline(c.history.map((h) => h.price), { label: `${c.ticker} price` })}</td>
      <td class="num" data-label="Price">${c.sharePrice == null ? '<span class="muted">not yet valued</span>' : esc(price(c.sharePrice))}</td>
      <td class="num small" data-label="Change">${changeCell(c.sharePrice, c.prevPrice)}</td>
      <td class="num" data-label="Last trade">${c.lastTrade == null ? '<span class="muted">—</span>' : esc(price(c.lastTrade))}</td>
      <td class="num" data-label="Value">${c.sharePrice == null ? '—' : esc(money(c.sharePrice * c.sharesTotal))}</td>
      <td data-label="Confidence">${confidenceBar(c.confidence)}</td>
      <td class="num" data-label="You hold">${mine ? mine.toLocaleString() : '<span class="muted">0</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No companies have been chartered yet.</td></tr>';
  const unvalued = board.some((c) => c.sharePrice == null);
  $('board-note').textContent = `Prices in ${cur().name}. Company value = price × all shares issued.`
    + (unvalued ? ' Companies marked "not yet valued" get a price the next time the GM advances time.' : '');
}
$('board').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  st.companyId = Number(b.dataset.open);
  load().then(() => $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' })).catch((err) => toast(err.message, true));
});

/* ── Company detail ── */
function renderDetail() {
  const c = st.d.company;
  $('detail').classList.toggle('hidden', !c);
  if (!c) return;
  $('d-name').textContent = `${c.name} (${c.ticker})`;
  $('d-sub').textContent = [c.homeName && `Chartered at ${c.homeName}`, c.valuedDay != null && `valued ${day(c.valuedDay)}`].filter(Boolean).join(' · ');
  $('d-price').textContent = price(c.sharePrice);
  const b = c.breakdown ?? {};
  const outside = c.sharesTotal - c.treasuryShares;
  $('d-stats').innerHTML = [
    ['Book value', c.bookValue == null ? '—' : money(c.bookValue),
      c.bookValue == null ? '' : `cash ${money(b.cash ?? 0)} · goods ${money(b.goods ?? 0)}${b.shipping ? ` · shipping ${money(b.shipping)}` : ""} · other ${money(b.other ?? 0)}`],
    ['Confidence', c.confidence.toFixed(2), `bounded ${st.d.rules.minConfidence}–${st.d.rules.maxConfidence}`],
    ['Shares', c.sharesTotal.toLocaleString(), `${outside.toLocaleString()} held by investors · ${c.treasuryShares.toLocaleString()} in treasury`],
    ['Dividends paid', money(c.dividendsTotal), c.dividends[0] ? `last ${price(c.dividends[0].perShare)}/share on ${day(c.dividends[0].day)}` : 'none yet'],
  ].map(([k, v, sub]) => `<div class="stat"><div class="small muted">${k}</div><div class="mono">${esc(v)}</div><div class="small muted">${esc(sub)}</div></div>`).join('');
  lineChart($('d-chart'), c.history.filter((h) => h.price != null), { formatY: (v) => price(v), formatX: (d) => day(d), height: 220 });

  // order book: asks (highest first) above bids
  const asks = [...c.asks].sort((a, b2) => b2.price - a.price);
  $('d-book').innerHTML = asks.map((a) => `<tr><td class="debit small">sell</td><td class="num">${esc(price(a.price))}</td><td class="num">${a.qty.toLocaleString()}</td><td class="num small">${a.orders}</td></tr>`).join('')
    + (c.asks.length && c.bids.length ? `<tr class="spread"><td colspan="4" class="small muted">spread ${esc(price(Math.min(...c.asks.map((a) => a.price)) - Math.max(...c.bids.map((x) => x.price))))}</td></tr>` : '')
    + c.bids.map((x) => `<tr><td class="credit small">buy</td><td class="num">${esc(price(x.price))}</td><td class="num">${x.qty.toLocaleString()}</td><td class="num small">${x.orders}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No open orders. Post the first one.</td></tr>';

  // trade form
  const keep = $('o-as').value;
  $('o-as').innerHTML = st.d.acting.map((a) => `<option value="${a.key}">${esc(a.label)}</option>`).join('');
  if ([...$('o-as').options].some((o) => o.value === keep)) $('o-as').value = keep;
  $('o-whole-label').textContent = `Price / share (${cur().symbol})`;
  $('o-sub-label').textContent = `+ ${cur().subunitName}`;
  $('o-sub').disabled = cur().subunitsPerUnit === 1;
  if (!st.priceSet && c.sharePrice != null) {
    const p = Math.round(c.lastTrade ?? c.sharePrice);
    $('o-whole').value = Math.floor(p / cur().subunitsPerUnit);
    $('o-sub').value = p % cur().subunitsPerUnit;
    st.priceSet = c.id;
  }
  orderHint();

  // my orders
  $('d-orders').innerHTML = c.orders.map((o) => `
    <tr class="${o.status === 'active' ? '' : 'inactive'}">
      <td><span class="tag ${o.side === 'sell' ? 'base' : 'gm'}">${o.side}</span></td>
      <td class="small">${esc(o.ownerName)}</td>
      <td class="num">${o.qtyLeft.toLocaleString()} <span class="small muted">/ ${o.qtyTotal.toLocaleString()}</span></td>
      <td class="num">${esc(price(o.price))}</td>
      <td class="small">${o.status === 'active' ? (o.qtyLeft < o.qtyTotal ? 'part filled' : 'open') : esc(o.status)}</td>
      <td class="num">${o.status === 'active' ? `<button class="ghost small" data-cancel="${o.id}">Cancel</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">No orders.</td></tr>';

  $('d-trades').innerHTML = c.trades.map((t) => `<tr><td class="small nowrap">${esc(day(t.day))}</td><td class="num">${t.qty.toLocaleString()}</td>
    <td class="num">${esc(price(t.price))}</td><td class="small">${esc(t.buyer)} ← ${esc(t.seller)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No trades yet.</td></tr>';
  $('d-holders').innerHTML = c.holders.map((h) => `<tr><td>${esc(h.name)}${h.treasury ? ' <span class="small muted">(treasury)</span>' : ''}</td>
    <td class="num">${h.qty.toLocaleString()}</td><td class="num small">${((h.qty / c.sharesTotal) * 100).toFixed(1)}%</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">No shares issued.</td></tr>';
  $('d-divs').innerHTML = c.dividends.map((d) => `<tr><td class="small">${esc(day(d.day))}</td><td class="num">${esc(price(d.perShare))}</td>
    <td class="num">${d.shares.toLocaleString()}</td><td class="num">${esc(money(d.total))}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No dividends yet.</td></tr>';

  $('div-form').classList.toggle('hidden', !c.canDeclare);
  $('dv-whole-label').textContent = `Dividend per share (${cur().symbol})`;
  $('dv-sub-label').textContent = `+ ${cur().subunitName}`;
  divHint();
}

function orderHint() {
  const c = st.d.company;
  if (!c) return;
  const qty = Number($('o-qty').value) || 0;
  const p = toMinor($('o-whole').value, $('o-sub').value, cur());
  const acct = $('o-as').value;
  const own = heldBy(c.id, acct) + (acct === `company:${c.id}` ? c.treasuryShares : 0);
  const side = $('o-side').value;
  const bestAsk = c.asks.length ? Math.min(...c.asks.map((a) => a.price)) : null;
  const bestBid = c.bids.length ? Math.max(...c.bids.map((b) => b.price)) : null;
  const crosses = side === 'buy' ? bestAsk != null && p >= bestAsk : bestBid != null && p <= bestBid;
  $('o-hint').innerHTML = `${side === 'buy' ? 'Up to' : 'At least'} <strong>${esc(money(qty * p))}</strong> for ${qty.toLocaleString()} shares.
    ${side === 'sell' ? `You hold ${own.toLocaleString()} (this account).` : ''}
    ${crosses ? '<span class="credit">Trades now against the book.</span>' : '<span class="muted">Waits in the book until someone meets your price.</span>'}`;
  $('o-go').disabled = !qty || !p;
}
['o-qty', 'o-whole', 'o-sub'].forEach((id) => $(id).addEventListener('input', orderHint));
['o-as', 'o-side'].forEach((id) => $(id).addEventListener('change', orderHint));

function divHint() {
  const c = st.d.company;
  if (!c) return;
  const per = toMinor($('dv-whole').value, $('dv-sub').value, cur());
  const outside = c.sharesTotal - c.treasuryShares;
  $('dv-hint').textContent = `${outside.toLocaleString()} investor shares × ${price(per)} = ${money(outside * per)} from the treasury.`;
  $('dv-go').disabled = !per;
}
['dv-whole', 'dv-sub'].forEach((id) => $(id).addEventListener('input', divHint));

$('o-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = st.d.company;
  const body = {
    action: 'placeOrder', companyId: c.id, side: $('o-side').value, qty: Number($('o-qty').value),
    price: toMinor($('o-whole').value, $('o-sub').value, cur()), as: $('o-as').value,
  };
  busy(e.submitter, () => api('shares', { method: 'POST', body })).then(async (r) => {
    toast(r.filled ? `Traded ${r.filled.toLocaleString()} ${c.ticker} shares${r.left ? `; ${r.left.toLocaleString()} still waiting` : ''}.`
      : `Order posted: ${body.side} ${body.qty.toLocaleString()} ${c.ticker} at ${price(body.price)}.`);
    await load();
  }).catch(() => {});
});
$('d-orders').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cancel]');
  if (!b) return;
  busy(b, () => api('shares', { method: 'POST', body: { action: 'cancelOrder', orderId: Number(b.dataset.cancel) } }))
    .then(async () => { toast('Order cancelled.'); await load(); }).catch(() => {});
});
$('div-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = st.d.company;
  const per = toMinor($('dv-whole').value, $('dv-sub').value, cur());
  if (!await confirmBox(`Pay ${price(per)} per share to every ${c.ticker} investor from ${c.name}'s treasury?`)) return;
  busy(e.submitter, () => api('shares', { method: 'POST', body: { action: 'declareDividend', companyId: c.id, perShare: per } }))
    .then(async (r) => { toast(`Dividend paid: ${money(r.dividend.total)} to ${r.dividend.holders} holder${r.dividend.holders === 1 ? '' : 's'}.`); await load(); })
    .catch(() => {});
});

async function load() {
  const prev = st.d?.company?.id;
  st.d = await api(`shares${st.companyId ? `?companyId=${st.companyId}` : ''}`);
  if (!st.d.company && st.d.board.length && !st.companyId) {
    // Open on a company you're involved with: one you serve, then one you hold, else the first listed.
    const listed = (id) => st.d.board.some((c) => c.id === id);
    const serve = st.d.acting.find((a) => a.type === 'company' && listed(a.id))?.id;
    const hold = st.d.holdings.find((h) => !h.treasury && listed(h.companyId))?.companyId;
    st.companyId = serve ?? hold ?? st.d.board[0].id;
    st.d = await api(`shares?companyId=${st.companyId}`);
  }
  if (prev !== st.d.company?.id) st.priceSet = null;
  if (st.companyId) history.replaceState(null, '', `?c=${st.companyId}`);
  renderBoard();
  renderDetail();
}

try {
  st.calendar = (await getClock()).calendar;
  await load();
} catch (err) {
  toast(err.message, true);
}
