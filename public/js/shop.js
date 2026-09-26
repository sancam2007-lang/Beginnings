// Goods Shop: browse a market, see price trends, buy and sell.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox } from './common.js';
import { formatMoney, formatPrice } from './money.js';
import { formatDay } from './calendar.js';
import { sparkline, lineChart } from './chart.js';

const $ = (id) => document.getElementById(id);
await requireSession();

const st = { data: null, calendar: null, marketId: Number(new URLSearchParams(location.search).get('m')) || null, asId: null };
/** The stockpile we're trading from (personal pack by default). */
const as = () => st.data.tradeAs.find((t) => t.stockpileId === st.asId) ?? st.data.tradeAs[0];

function renderTabs() {
  const { markets, market } = st.data;
  $('market-tabs').innerHTML = markets.map((m) => `
    <button type="button" data-id="${m.id}" class="${m.id === market.id ? 'active' : ''}">
      ${esc(m.name)} <span class="small muted">${esc(m.currencyCode)}</span></button>`).join('');
}

function renderHead() {
  const { market, tradeAs } = st.data;
  const cur = market.currency;
  $('market-name').textContent = market.name;
  $('market-desc').textContent = market.description ?? '';
  $('as-wrap').classList.toggle('hidden', tradeAs.length < 2);
  $('f-as').innerHTML = tradeAs.map((t) => `<option value="${t.stockpileId}">${esc(t.label)}</option>`).join('');
  $('f-as').value = as().stockpileId;
  $('purse-label').textContent = 'Your purse here';
  $('market-purse').textContent = formatMoney(as().balance, cur);
  $('market-terms').textContent = `Prices in ${cur.name}. The shop charges ${market.markupPct}% over market price and buys back at ${market.buybackPct}% of it.`;
  const cats = [...new Set(st.data.listings.map((l) => l.category))];
  const keep = $('f-cat').value;
  $('f-cat').innerHTML = '<option value="">All</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  if (cats.includes(keep)) $('f-cat').value = keep;
}

function changeCell(pct) {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return '<span class="muted">—</span>';
  const up = pct > 0;
  return `<span class="${up ? 'credit' : 'debit'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function renderRows() {
  const { listings, market } = st.data;
  const { owned } = as();
  const cur = market.currency;
  const cat = $('f-cat').value;
  const term = $('f-search').value.trim().toLowerCase();
  const rows = listings.filter((l) => (!cat || l.category === cat) && (!term || l.name.toLowerCase().includes(term)));
  let lastCat = null;
  $('shop-rows').innerHTML = rows.map((l) => {
    const header = l.category !== lastCat && !cat ? `<tr class="cat-row"><td colspan="9">${esc(l.category)}</td></tr>` : '';
    lastCat = l.category;
    const own = owned[l.goodId] ?? 0;
    return `${header}
      <tr data-good="${l.goodId}">
        <td class="name-cell"><button class="linklike" data-detail="${l.goodId}">${esc(l.name)}</button>
          <div class="small muted">per ${esc(l.unit)}${l.playerMade ? ' · <span class="tag gm" title="NPCs never restock this — only players make it">player-made</span>' : ''}</div></td>
        <td class="spark-cell" data-label="Recent">${sparkline(l.history.map((h) => h.price), { label: `${l.name} recent prices` })}</td>
        <td class="num small" data-label="Change">${changeCell(l.changePct)}</td>
        <td class="num" data-label="Buy at">${esc(formatMoney(l.buyPrice, cur))}</td>
        <td class="num muted" data-label="Sell at">${l.sellPrice ? esc(formatMoney(l.sellPrice, cur)) : '—'}</td>
        <td class="num" data-label="Stock">${l.stock.toLocaleString()}</td>
        <td class="num" data-label="You own">${own ? own.toLocaleString() : '<span class="muted">0</span>'}</td>
        <td class="num qty-cell"><input class="qty" type="number" min="1" max="10000" value="1" aria-label="Quantity of ${esc(l.name)}"></td>
        <td class="num nowrap buy-cell">
          <button class="small" data-buy="${l.goodId}" ${l.stock ? '' : 'disabled'}>Buy</button>
          <button class="ghost small" data-sell="${l.goodId}" ${own && l.sellPrice ? '' : 'disabled'}>Sell</button>
        </td>
      </tr>`;
  }).join('') || `<tr><td colspan="9" class="muted">${listings.length ? 'Nothing matches.' : 'This market has nothing for sale yet.'}</td></tr>`;
}

async function load() {
  const qs = st.marketId ? `?marketId=${st.marketId}` : '';
  st.data = await api(`markets${qs}`);
  if (!st.data.market) {
    $('market-name').textContent = 'No shops are open.';
    $('shop-rows').innerHTML = '<tr><td colspan="9" class="muted">No goods shops are open yet. The GM opens them under Markets.</td></tr>';
    return;
  }
  st.marketId = st.data.market.id;
  history.replaceState(null, '', `?m=${st.marketId}`);
  renderTabs();
  renderHead();
  renderRows();
}

$('market-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  st.marketId = Number(b.dataset.id);
  load().catch((err) => toast(err.message, true));
});
$('f-cat').addEventListener('change', renderRows);
$('f-as').addEventListener('change', (e) => { st.asId = Number(e.target.value); renderHead(); renderRows(); });
$('f-search').addEventListener('input', renderRows);

/* ── Buy / sell ── */
$('shop-rows').addEventListener('click', async (e) => {
  const buy = e.target.closest('button[data-buy]');
  const sell = e.target.closest('button[data-sell]');
  const detail = e.target.closest('button[data-detail]');
  if (detail) return openDetail(Number(detail.dataset.detail));
  const btn = buy || sell;
  if (!btn) return;
  const action = buy ? 'buy' : 'sell';
  const goodId = Number(btn.dataset[action]);
  const l = st.data.listings.find((x) => x.goodId === goodId);
  const qty = Number(btn.closest('tr').querySelector('.qty').value);
  if (!Number.isInteger(qty) || qty < 1) return toast('Enter a quantity.', true);
  const cur = st.data.market.currency;
  const unit = action === 'buy' ? l.buyPrice : l.sellPrice;
  const total = formatMoney(unit * qty, cur);
  const forWhom = as().stockpileId !== st.data.tradeAs[0].stockpileId ? ` (${as().label})` : '';
  if (!await confirmBox(`${action === 'buy' ? 'Buy' : 'Sell'} ${qty} ${l.unit} of ${l.name}${forWhom} for ${total}?`)) return;
  const who = as();
  busy(btn, () => api('shop', { method: 'POST', body: { action, marketId: st.marketId, goodId, qty, stockpileId: who.stockpileId } }))
    .then(async () => { toast(`${action === 'buy' ? 'Bought' : 'Sold'} ${qty} × ${l.name} for ${total}.`); await load(); })
    .catch(() => {});
});

/* ── Price detail ── */
async function openDetail(goodId) {
  const l = st.data.listings.find((x) => x.goodId === goodId);
  const cur = st.data.market.currency;
  $('d-title').textContent = `${l.name} at ${st.data.market.name}`;
  $('d-desc').textContent = [l.description, `Market price now ${formatPrice(l.price, cur)} per ${l.unit}.`].filter(Boolean).join(' ');
  $('d-chart').innerHTML = '<p class="muted small">Loading…</p>';
  $('detail').showModal();
  const { points } = await api(`price-history?marketId=${st.marketId}&goodId=${goodId}`);
  const fmtDay = (d) => formatDay(d, st.calendar, { short: points.length > 1 && points[points.length - 1].day - points[0].day < 300 });
  lineChart($('d-chart'), points, { formatY: (v) => formatPrice(v, cur), formatX: fmtDay });
  $('d-table').innerHTML = [...points].reverse().map((p) => `
    <tr><td class="small">${esc(formatDay(p.day, st.calendar))}</td>
    <td class="num">${esc(formatPrice(p.price, cur))}</td><td class="num">${p.stock.toLocaleString()}</td></tr>`).join('');
}
$('d-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });

try {
  st.calendar = (await getClock()).calendar;
  await load();
} catch (err) {
  toast(err.message, true);
}
