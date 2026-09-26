// GM Console → Markets: open markets, maintain the goods catalog, and set what
// each market sells with its price behaviour.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, promptBox } from '../common.js';
import { formatPrice, formatMoney, toMinor, currencyOptions } from '../money.js';

export function init({ $, on, emit }) {
  const st = { markets: [], goods: [], listings: [], currencies: [], orders: [], settlements: [], marketId: null, editing: null };
  const market = () => st.markets.find((m) => m.id === st.marketId);
  const currency = (id) => st.currencies.find((c) => c.id === id);
  const good = (id) => st.goods.find((g) => g.id === id);

  function apply(r) {
    Object.assign(st, { markets: r.markets, goods: r.goods, listings: r.listings, currencies: r.currencies, orders: r.orders ?? [] });
    if (!st.markets.some((m) => m.id === st.marketId)) st.marketId = st.markets[0]?.id ?? null;
    renderAll();
    emit('catalog', { goods: st.goods, markets: st.markets });
  }
  const post = (body) => api('gm/markets', { method: 'POST', body }).then(apply);

  function renderAll() {
    renderMarketSelect();
    renderListings();
    renderMarkets();
    renderGoods();
    renderOrders();
  }

  /* ── Standing orders (players') ── */
  function renderOrders() {
    $('or-rows').innerHTML = st.orders.map((o) => {
      const m = st.markets.find((x) => x.id === o.marketId);
      const cur = m && currency(m.currencyId);
      return `<tr>
        <td>${esc(o.ownerName)}<div class="small muted">${esc(o.stockpileName)}</div></td>
        <td><span class="tag ${o.side === 'sell' ? 'base' : 'gm'}">${o.side}</span> ${esc(o.goodName)}</td>
        <td class="small">${esc(o.marketName)}</td>
        <td class="num">${o.qtyLeft.toLocaleString()} / ${o.qtyTotal.toLocaleString()}</td>
        <td class="num">${cur ? esc(formatPrice(o.limitPrice, cur)) : o.limitPrice}</td>
        <td class="small muted">${o.lastFill ? `${o.lastFill.qty.toLocaleString()} units` : '—'}</td>
        <td class="num"><button class="ghost small" data-or="${o.id}">Cancel</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No open orders.</td></tr>';
  }
  $('or-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-or]');
    if (!b || !await confirmBox('Cancel this order for the player?')) return;
    busy(b, () => api('bulk', { method: 'POST', body: { action: 'cancelOrder', orderId: Number(b.dataset.or) } }))
      .then(() => api('gm/markets')).then(apply).then(() => toast('Order cancelled.')).catch(() => {});
  });

  /* ── Listings for the selected market ── */
  const picked = new Set(); // goodIds ticked for bulk delete (current market only)
  function syncPicked(visible) {
    for (const id of [...picked]) if (!visible.includes(id)) picked.delete(id);
    const n = picked.size;
    $('ls-selected').textContent = n ? `${n} selected` : 'None selected';
    $('ls-delete').disabled = !n;
    $('ls-all').checked = n > 0 && n === visible.length;
    $('ls-all').indeterminate = n > 0 && n < visible.length;
  }
  const visibleIds = () => [...document.querySelectorAll('#ls-rows .ls-pick')].map((c) => Number(c.value));
  $('ls-all').addEventListener('change', (e) => {
    picked.clear();
    if (e.target.checked) visibleIds().forEach((id) => picked.add(id));
    document.querySelectorAll('#ls-rows .ls-pick').forEach((c) => { c.checked = e.target.checked; });
    syncPicked(visibleIds());
  });
  $('ls-rows').addEventListener('change', (e) => {
    const c = e.target.closest('.ls-pick');
    if (!c) return;
    if (c.checked) picked.add(Number(c.value)); else picked.delete(Number(c.value));
    syncPicked(visibleIds());
  });
  async function deleteListings(goodIds, button) {
    const names = goodIds.map((id) => good(id)?.name ?? `#${id}`);
    const what = names.length === 1 ? names[0] : `${names.length} goods`;
    if (!await confirmBox(`Delete ${what} from ${market().name}?\n\nThis takes ${names.length === 1 ? 'it' : 'them'} off sale here and erases the price history. `
      + 'Open standing orders are cancelled. The goods stay in the catalog and in stockpiles. This cannot be undone.')) return;
    busy(button, () => api('gm/markets', { method: 'POST', body: { action: 'deleteListings', marketId: st.marketId, goodIds } }))
      .then((r) => {
        goodIds.forEach((id) => picked.delete(id));
        if (goodIds.includes(st.editing)) resetListingForm();
        apply(r);
        const extra = r.deleted?.ordersCancelled ? ` ${r.deleted.ordersCancelled} standing order${r.deleted.ordersCancelled === 1 ? '' : 's'} cancelled.` : '';
        toast(`Deleted ${r.deleted?.listings === 1 ? names[0] : `${r.deleted?.listings ?? goodIds.length} listings`} from ${market().name}.${extra}`);
      }).catch(() => {});
  }
  $('ls-delete').addEventListener('click', (e) => deleteListings([...picked], e.currentTarget));
  function renderMarketSelect() {
    const kindName = (m) => (m.kind === 'shop' ? 'goods shop' : 'bulk');
    $('mk-select').innerHTML = st.markets.map((m) => `<option value="${m.id}">${esc(m.name)} (${kindName(m)})${m.active ? '' : ' — closed'}</option>`).join('');
    if (st.marketId) $('mk-select').value = st.marketId;
  }
  $('mk-select').addEventListener('change', (e) => { st.marketId = Number(e.target.value); picked.clear(); resetListingForm(); renderListings(); });

  function renderListings() {
    const m = market();
    if (!m) {
      $('ls-rows').innerHTML = '<tr><td colspan="9" class="muted">Open a market first.</td></tr>';
      return;
    }
    const cur = currency(m.currencyId);
    $('mk-terms').textContent = (m.kind === 'shop'
      ? `Goods shop (players) · prices in ${cur.name} · markup ${m.markupPct}% · buy-back ${m.buybackPct}%`
      : `Bulk market (companies) · prices in ${cur.name} · fee ${m.feePct}%`)
      + ` · NPC purse ${m.purse == null ? 'unlimited' : formatMoney(m.purse, cur)}`;
    const bulk = m.kind !== 'shop';
    $('ls-base-whole-label').textContent = bulk ? `Townsfolk pay up to (${cur.symbol})` : `Normal price (${cur.symbol})`;
    document.querySelectorAll('#ls-form .ls-shop').forEach((el) => el.classList.toggle('hidden', bulk));
    document.querySelectorAll('#ls-form .ls-bulk').forEach((el) => el.classList.toggle('hidden', !bulk));
    $('ls-base-sub-label').textContent = `+ ${cur.subunitName} (${cur.subunitSymbol})`;

    const rows = st.listings.filter((l) => l.marketId === m.id)
      .map((l) => ({ ...l, good: good(l.goodId) }))
      .sort((a, b) => a.good.category.localeCompare(b.good.category) || a.good.name.localeCompare(b.good.name));
    $('ls-rows').innerHTML = rows.map((l) => {
      const ratio = l.basePrice ? l.price / l.basePrice : 1;
      const cls = ratio > 1.15 ? 'debit' : ratio < 0.87 ? 'credit' : '';
      const event = l.trendDays > 0
        ? `<span class="${l.trendPct > 0 ? 'debit' : 'credit'}">${l.trendPct > 0 ? '+' : ''}${l.trendPct.toFixed(1)}%/day</span> <span class="small muted">${l.trendDays}d left</span>`
        : '<span class="muted">—</span>';
      return `<tr class="${l.active && l.good.active ? '' : 'inactive'}">
        <td class="check-col"><input type="checkbox" class="ls-pick" value="${l.goodId}" ${picked.has(l.goodId) ? 'checked' : ''} aria-label="Select ${esc(l.good.name)}"></td>
        <td>${esc(l.good.name)} <span class="small muted">/${esc(l.good.unit)}</span>${l.active ? '' : ' <span class="tag off">off sale</span>'}</td>
        <td class="num ${cls}">${esc(formatPrice(l.price, cur))}</td>
        <td class="num muted">${esc(formatPrice(l.basePrice, cur))}</td>
        <td class="num">${m.kind === 'shop' ? `${l.stock.toLocaleString()} <span class="small muted">on shelf</span>` : `${l.stock.toLocaleString()} <span class="small muted">listed</span>`}</td>
        <td class="num small">${m.kind === 'shop' ? `buys ${l.restockPerDay}/day<div class="muted">up to ${l.targetStock.toLocaleString()}</div>` : `townsfolk ${l.npcDemand ?? 0}/day`}</td>
        <td class="num small">±${l.volatilityPct.toFixed(1)}%</td>
        <td class="small">${event}</td>
        <td class="num nowrap">
          <button class="ghost small" data-edit="${l.goodId}">Edit</button>
          ${m.kind === 'shop' ? `<button class="ghost small" data-price="${l.goodId}">Set price</button>` : ''}
          <button class="ghost small danger" data-del="${l.goodId}">Delete</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">Nothing for sale yet. Add goods below.</td></tr>';
    syncPicked(rows.map((l) => l.goodId));

    // Goods not yet sold here
    const listed = new Set(rows.map((l) => l.goodId));
    const options = st.goods.filter((g) => g.active && !listed.has(g.id));
    if (!st.editing) {
      $('ls-good').innerHTML = options.map((g) => `<option value="${g.id}">${esc(g.name)} (${esc(g.category)})</option>`).join('')
        || '<option value="">— every good is already listed; add more to the catalog —</option>';
      $('ls-submit').disabled = !options.length;
    }
  }

  function resetListingForm() {
    st.editing = null;
    $('ls-form').reset();
    $('ls-good').disabled = false;
    $('ls-title').textContent = 'Add a Good to this Market';
    $('ls-submit').textContent = 'Add to Market';
    $('ls-cancel').classList.add('hidden');
    $('ls-edit-only').classList.add('hidden');
    renderListings();
  }
  $('ls-cancel').addEventListener('click', resetListingForm);

  function editListing(goodId) {
    const l = st.listings.find((x) => x.marketId === st.marketId && x.goodId === goodId);
    const g = good(goodId);
    const cur = currency(market().currencyId);
    st.editing = goodId;
    $('ls-good').innerHTML = `<option value="${g.id}">${esc(g.name)}</option>`;
    $('ls-good').disabled = true;
    const baseMinor = Math.round(l.basePrice);
    $('ls-base-whole').value = Math.floor(baseMinor / cur.subunitsPerUnit);
    $('ls-base-sub').value = baseMinor % cur.subunitsPerUnit;
    $('ls-stock').value = l.stock;
    $('ls-target').value = l.targetStock;
    $('ls-restock').value = l.restockPerDay;
    $('ls-demand').value = l.npcDemand ?? 0;
    $('ls-vol').value = +l.volatilityPct.toFixed(3);
    $('ls-rev').value = +l.reversionPct.toFixed(3);
    $('ls-el').value = l.elasticity;
    $('ls-trend').value = +l.trendPct.toFixed(3);
    $('ls-trend-days').value = l.trendDays;
    $('ls-active').checked = l.active;
    $('ls-title').textContent = `Edit ${g.name} at ${market().name}`;
    $('ls-submit').textContent = 'Save Changes';
    $('ls-submit').disabled = false;
    $('ls-cancel').classList.remove('hidden');
    $('ls-edit-only').classList.remove('hidden');
    $('ls-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('ls-rows').addEventListener('click', async (e) => {
    const edit = e.target.closest('button[data-edit]');
    const price = e.target.closest('button[data-price]');
    const del = e.target.closest('button[data-del]');
    if (edit) return editListing(Number(edit.dataset.edit));
    if (del) return deleteListings([Number(del.dataset.del)], del);
    if (!price) return;
    const goodId = Number(price.dataset.price);
    const l = st.listings.find((x) => x.marketId === st.marketId && x.goodId === goodId);
    const cur = currency(market().currencyId);
    const input = await promptBox(
      `New market price for ${good(goodId).name}, in ${cur.subunitName} (1 ${cur.name} = ${cur.subunitsPerUnit} ${cur.subunitName}).\nNow: ${formatPrice(l.price, cur)} = ${l.price.toFixed(1)} ${cur.subunitSymbol}.\nTip: type "+20%" or "-15%" to shock the price.`,
      Math.round(l.price),
    );
    if (input == null) return;
    const pct = /^\s*([+-]\d+(\.\d+)?)\s*%\s*$/.exec(input);
    const next = pct ? l.price * (1 + Number(pct[1]) / 100) : Number(input);
    if (!Number.isFinite(next) || next <= 0) return toast('Enter a price above zero.', true);
    busy(price, () => post({ action: 'setPrice', marketId: st.marketId, goodId, price: next }))
      .then(() => toast(`${good(goodId).name} now ${formatPrice(next, cur)}.`)).catch(() => {});
  });

  $('ls-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cur = currency(market().currencyId);
    const basePrice = toMinor($('ls-base-whole').value, $('ls-base-sub').value, cur);
    if (basePrice <= 0) return toast('Set a normal price above zero.', true);
    const body = {
      action: st.editing ? 'updateListing' : 'addListing',
      marketId: st.marketId,
      goodId: st.editing ?? Number($('ls-good').value),
      basePrice,
      stock: Number($('ls-stock').value),
      targetStock: Number($('ls-target').value),
      restockPerDay: Number($('ls-restock').value),
      npcDemand: market().kind === 'shop' ? null : Number($('ls-demand').value || 0),
      volatilityPct: Number($('ls-vol').value),
      reversionPct: Number($('ls-rev').value),
      elasticity: Number($('ls-el').value),
      trendPct: Number($('ls-trend').value),
      trendDays: Number($('ls-trend-days').value),
      active: $('ls-active').checked,
    };
    const was = st.editing;
    busy(e.submitter, () => post(body))
      .then(() => { resetListingForm(); toast(was ? 'Listing saved.' : `Now selling ${good(body.goodId).name}.`); })
      .catch(() => {});
  });

  /* ── Markets ── */
  function renderMarkets() {
    $('mk-rows').innerHTML = st.markets.map((m) => `
      <tr class="${m.active ? '' : 'inactive'}">
        <td>${esc(m.name)} <span class="tag ${m.kind === 'shop' ? 'gm' : 'base'}">${m.kind === 'shop' ? 'goods shop' : 'bulk'}</span>${m.active ? '' : ' <span class="tag off">closed</span>'}
          <div class="small muted">${esc(st.settlements.find((x) => x.id === m.settlementId)?.name ?? 'no settlement')} ·
            ${esc(currency(m.currencyId)?.name ?? '?')} · ${m.kind === 'shop' ? `+${m.markupPct}% / buys at ${m.buybackPct}%` : `fee ${m.feePct}%`}</div>
          <div class="small muted">NPC purse: ${m.purse == null ? 'unlimited' : `${esc(formatMoney(m.purse, currency(m.currencyId)))}
            (+${esc(formatMoney(m.purseRefill, currency(m.currencyId)))}/session${m.purseCap != null ? `, cap ${esc(formatMoney(m.purseCap, currency(m.currencyId)))}` : ''})`}</div></td>
        <td class="num"><button class="ghost small" data-mk="${m.id}">Edit</button></td>
      </tr>`).join('');
    const keep = $('mk-cur').value;
    $('mk-cur').innerHTML = currencyOptions(st.currencies.filter((c) => c.active));
    if (keep) $('mk-cur').value = keep;
    renderPlaces();
  }

  function renderPlaces() {
    const keep = $('mk-place').value;
    $('mk-place').innerHTML = st.settlements.filter((x) => x.active)
      .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('') || '<option value="">— found a settlement first (World tab) —</option>';
    if (keep) $('mk-place').value = keep;
  }

  function resetMarketForm() {
    $('mk-form').reset();
    $('mk-id').value = '';
    $('mk-kind').disabled = false;
    $('mk-form-title').textContent = 'Open a Market';
    $('mk-submit').textContent = 'Open Market';
    $('mk-cancel').classList.add('hidden');
    $('mk-cur-warning').classList.add('hidden');
    const base = st.currencies.find((c) => c.isBase);
    if (base) $('mk-cur').value = base.id;
    syncKind();
    syncPurse();
  }
  // Shop markets use markup/buy-back; bulk markets use the fee and price impact.
  function syncKind() {
    const shop = $('mk-kind').value === 'shop';
    document.querySelectorAll('.mk-shop-only').forEach((el) => el.classList.toggle('hidden', !shop));
    document.querySelectorAll('.mk-bulk-only').forEach((el) => el.classList.toggle('hidden', shop));
  }
  $('mk-kind').addEventListener('change', () => {
    syncKind();
    const id = Number($('mk-id').value);
    const m = st.markets.find((x) => x.id === id);
    if (m && m.kind === 'bulk' && $('mk-kind').value === 'shop') toast('Turning this into a goods shop cancels its open standing orders when you save.');
  });
  const syncPurse = () => $('mk-purse-fields').classList.toggle('hidden', !$('mk-limited').checked);
  $('mk-limited').addEventListener('change', syncPurse);
  const wholeOf = (minor, cur) => (minor == null ? '' : +(minor / cur.subunitsPerUnit).toFixed(4));
  const minorOf = (v, cur) => (v === '' ? null : Math.round(Number(v) * cur.subunitsPerUnit));
  $('mk-cancel').addEventListener('click', resetMarketForm);

  $('mk-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mk]');
    if (!b) return;
    const m = st.markets.find((x) => x.id === Number(b.dataset.mk));
    $('mk-id').value = m.id;
    $('mk-kind').value = m.kind ?? 'bulk';
    syncKind();
    $('mk-name').value = m.name;
    $('mk-desc').value = m.description ?? '';
    $('mk-cur').value = m.currencyId;
    $('mk-place').value = m.settlementId ?? '';
    $('mk-sort').value = m.sortOrder;
    $('mk-markup').value = m.markupPct;
    $('mk-buyback').value = m.buybackPct;
    $('mk-active').checked = m.active;
    const cur = currency(m.currencyId);
    $('mk-fee').value = m.feePct;
    $('mk-impact').value = m.bulkImpact;
    $('mk-limited').checked = m.purse != null;
    $('mk-refill').value = wholeOf(m.purseRefill, cur);
    $('mk-cap').value = wholeOf(m.purseCap, cur);
    $('mk-now').value = '';
    $('mk-now').placeholder = m.purse == null ? 'start at refill' : `now ${wholeOf(m.purse, cur)}`;
    syncPurse();
    $('mk-form-title').textContent = `Edit ${m.name}`;
    $('mk-submit').textContent = 'Save Market';
    $('mk-cancel').classList.remove('hidden');
    $('mk-cur-warning').classList.remove('hidden');
    $('mk-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('mk-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number($('mk-id').value) || null;
    const body = {
      action: 'saveMarket', id, kind: $('mk-kind').value,
      name: $('mk-name').value, description: $('mk-desc').value,
      currencyId: Number($('mk-cur').value), sortOrder: Number($('mk-sort').value) || 0,
      settlementId: Number($('mk-place').value) || null,
      markupPct: Number($('mk-markup').value), buybackPct: Number($('mk-buyback').value),
      active: $('mk-active').checked,
      feePct: Number($('mk-fee').value), bulkImpact: Number($('mk-impact').value),
      purseLimited: $('mk-limited').checked,
    };
    const cur = currency(body.currencyId);
    if (body.purseLimited && cur) {
      body.purseRefill = minorOf($('mk-refill').value || '0', cur);
      body.purseCap = minorOf($('mk-cap').value, cur);
      body.purseNow = minorOf($('mk-now').value, cur);
    }
    busy(e.submitter, () => post(body))
      .then(() => { resetMarketForm(); toast(id ? 'Market saved.' : `${body.name} is open for trade.`); }).catch(() => {});
  });

  /* ── Goods catalog ── */
  const soldAt = (goodId) => {
    const at = st.listings.filter((l) => l.goodId === goodId).map((l) => st.markets.find((m) => m.id === l.marketId)).filter(Boolean);
    const shops = at.filter((m) => m.kind === 'shop').length;
    const bulk = at.length - shops;
    return [bulk && `${bulk} bulk`, shops && `${shops} shop${shops === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  };
  function renderGoods() {
    $('gd-rows').innerHTML = st.goods.map((g) => `
      <tr class="${g.active ? '' : 'inactive'}">
        <td>${esc(g.name)}</td>
        <td class="small">${esc(g.unit)}</td>
        <td class="small">${esc(g.category)}</td>
        <td class="small">${soldAt(g.id) || '<span class="muted">not listed</span>'}
          <span class="tag ${g.kind === 'raw' ? 'base' : 'gm'}">${esc(g.kind ?? 'raw')}</span></td>
        <td class="num"><button class="ghost small" data-gd="${g.id}">Edit</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No goods yet.</td></tr>';
    $('gd-cats').innerHTML = [...new Set(st.goods.map((g) => g.category))].map((c) => `<option value="${esc(c)}">`).join('');
  }

  function resetGoodForm() {
    $('gd-form').reset();
    $('gd-id').value = '';
    $('gd-form-title').textContent = 'Add a Good';
    $('gd-submit').textContent = 'Add Good';
    $('gd-cancel').classList.add('hidden');
  }
  $('gd-cancel').addEventListener('click', resetGoodForm);

  $('gd-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-gd]');
    if (!b) return;
    const g = good(Number(b.dataset.gd));
    $('gd-id').value = g.id;
    $('gd-name').value = g.name;
    $('gd-unit').value = g.unit;
    $('gd-cat').value = g.category;
    $('gd-desc').value = g.description ?? '';
    $('gd-kind').value = g.kind ?? (g.npcSupply === false ? 'processed' : 'raw');
    $('gd-active').checked = g.active;
    $('gd-form-title').textContent = `Edit ${g.name}`;
    $('gd-submit').textContent = 'Save Good';
    $('gd-cancel').classList.remove('hidden');
    $('gd-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('gd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number($('gd-id').value) || null;
    const body = {
      action: 'saveGood', id,
      name: $('gd-name').value, unit: $('gd-unit').value, category: $('gd-cat').value, description: $('gd-desc').value,
      active: $('gd-active').checked,
      kind: $('gd-kind').value,
    };
    busy(e.submitter, () => post(body))
      .then(() => { resetGoodForm(); toast(id ? 'Good saved.' : `${body.name} added to the catalog.`); }).catch(() => {});
  });

  /* ── React to other tabs ── */
  on('currencies', () => api('gm/markets').then(apply).catch(() => {}));
  on('world', (list) => { st.settlements = list; renderMarkets(); });
  on('markets-data', apply); // e.g. after a bulk import
  on('clock', () => api('gm/markets').then(apply).catch(() => {})); // prices move when time advances

  api('gm/markets').then((r) => { apply(r); resetMarketForm(); }).catch((err) => toast(err.message, true));
}

