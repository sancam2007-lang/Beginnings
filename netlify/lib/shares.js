// The Exchange (script 10): company valuation, shares, the order book, and dividends.
//
// VALUATION (in the base currency's sub-units, recomputed every time the GM advances time):
//   book value  = treasury cash (every currency, converted) + goods in company stockpiles (at local
//                 market prices) + goods it is shipping (at destination prices) + other assets (GM-set:
//                 buildings, charters, monopolies…)
//   confidence  = a bounded multiplier (default 0.5–2.0) that drifts with results:
//                   + growth of book value since the last valuation
//                   + dividends paid (as a share of book value)
//                   + trading above / below the previous share price
//                   − a pull back toward 1.0 over time
//   share price = book value × confidence ÷ shares issued
// Like the VOC or the Dutch West India Company: the price rests on real assets, and sentiment can
// only stretch it within bounds.
//
// TRADING: players (and companies, for their own treasury) post limit orders. An incoming order
// matches the best opposite orders at THEIR price, oldest first; you never trade with yourself.
// Nothing is escrowed: shares and money are checked when a trade happens, and an order whose owner
// can no longer honour it is cancelled.
//
// DIVIDENDS: a director pays a fixed amount per share from the company treasury (base currency)
// to every shareholder. Shares the company holds itself (treasury shares) get nothing.
import { HttpError } from './http.js';
import { getSetting } from './db.js';
import { move, currentDay, balanceOf } from './ledger.js';

export const DEFAULT_RULES = {
  minConfidence: 0.5, maxConfidence: 2, growthWeight: 0.5, dividendWeight: 1, tradeWeight: 0.3,
  reversionPerSession: 0.25, newCompanyShares: 1000,
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const MAX_QTY = 1e12;

export function cleanRules(b = {}) {
  const n = (v, d, lo, hi) => {
    const x = Number(v ?? d);
    if (!Number.isFinite(x) || x < lo || x > hi) throw new HttpError(400, `Values must be between ${lo} and ${hi}.`);
    return x;
  };
  const r = {
    minConfidence: n(b.minConfidence, DEFAULT_RULES.minConfidence, 0.01, 10),
    maxConfidence: n(b.maxConfidence, DEFAULT_RULES.maxConfidence, 0.01, 10),
    growthWeight: n(b.growthWeight, DEFAULT_RULES.growthWeight, 0, 10),
    dividendWeight: n(b.dividendWeight, DEFAULT_RULES.dividendWeight, 0, 10),
    tradeWeight: n(b.tradeWeight, DEFAULT_RULES.tradeWeight, 0, 10),
    reversionPerSession: n(b.reversionPerSession, DEFAULT_RULES.reversionPerSession, 0, 1),
    newCompanyShares: Math.round(n(b.newCompanyShares, DEFAULT_RULES.newCompanyShares, 1, 1e9)),
  };
  if (r.minConfidence > 1 || r.maxConfidence < 1) throw new HttpError(400, 'The confidence range must include 1.0.');
  return r;
}

export async function loadRules(q) {
  return { ...DEFAULT_RULES, ...(await getSetting('exchange_rules', {}, q)) };
}

export async function baseCurrency(q) {
  const [c] = await q`select * from currencies where is_base`;
  return c;
}

/** Book value of companies, in base sub-units, with the breakdown. Returns Map(id → {...}). */
export async function bookValues(q, companyIds) {
  if (!companyIds.length) return new Map();
  const [currencies, wallets, stock, listings, transit, companies] = await Promise.all([
    q`select id, subunits_per_unit, rate_to_base, is_base from currencies`,
    q`select owner_id, currency_id, balance_minor from wallets where owner_type = 'company' and owner_id = any(${companyIds}::int[])`,
    q`select s.owner_id, s.settlement_id, k.good_id, k.qty from stock k join stockpiles s on s.id = k.stockpile_id
      where s.owner_type = 'company' and s.owner_id = any(${companyIds}::int[]) and s.active and k.qty > 0`,
    q`select l.good_id, l.price, m.settlement_id, m.currency_id from listings l
      join markets m on m.id = l.market_id and m.active where l.active`,
    q`select sh.owner_id, sh.to_settlement_id as settlement_id, c.good_id, c.qty from shipments sh
      join shipment_cargo c on c.shipment_id = sh.id
      where sh.owner_type = 'company' and sh.owner_id = any(${companyIds}::int[]) and sh.status in ('transit', 'waiting') and c.qty > 0`,
    q`select id, other_assets from companies where id = any(${companyIds}::int[])`,
  ]);
  const base = currencies.find((c) => c.is_base);
  const toBase = (minor, curId) => {
    const c = currencies.find((x) => x.id === curId);
    return ((Number(minor) / c.subunits_per_unit) * Number(c.rate_to_base) / Number(base.rate_to_base)) * base.subunits_per_unit;
  };
  // A good's unit value: average price at markets in the same settlement, else anywhere.
  const priceCache = new Map();
  const unitValue = (goodId, settlementId) => {
    const key = `${goodId}:${settlementId}`;
    if (!priceCache.has(key)) {
      const all = listings.filter((l) => l.good_id === goodId);
      const local = all.filter((l) => l.settlement_id === settlementId);
      const use = local.length ? local : all;
      priceCache.set(key, use.length ? use.reduce((s, l) => s + toBase(l.price, l.currency_id), 0) / use.length : 0);
    }
    return priceCache.get(key);
  };
  const out = new Map();
  for (const id of companyIds) {
    const cash = wallets.filter((w) => w.owner_id === id).reduce((s, w) => s + toBase(w.balance_minor, w.currency_id), 0);
    const goods = stock.filter((k) => k.owner_id === id).reduce((s, k) => s + Number(k.qty) * unitValue(k.good_id, k.settlement_id), 0);
    const shipping = transit.filter((k) => k.owner_id === id).reduce((s, k) => s + Number(k.qty) * unitValue(k.good_id, k.settlement_id), 0);
    const other = Number(companies.find((c) => c.id === id)?.other_assets ?? 0);
    const r = (x) => Math.round(x);
    out.set(id, { cash: r(cash), goods: r(goods), shipping: r(shipping), other: r(other), total: Math.max(0, r(cash + goods + shipping + other)) });
  }
  return out;
}

/**
 * Revalues companies. With `days` > 0 (a time advance) confidence also moves; with 0 (GM
 * "revalue now") only book value and price are refreshed. Returns lines for the time log.
 */
export async function revalue(q, { fromDay, toDay, companyIds = null }) {
  const companies = companyIds
    ? await q`select * from companies where id = any(${companyIds}::int[]) for update`
    : await q`select * from companies where active and kind not in ('house', 'crown') order by id for update`;
  if (!companies.length) return [];
  const rules = await loadRules(q);
  const days = Math.max(0, toDay - fromDay);
  // Activity counted for this advance: everything dated from the day time last stood still (fromDay)
  // up to, not including, the new date. Consecutive advances never count the same day twice.
  const sessionDays = Number(await getSetting('session_days', 90, q));
  const ids = companies.map((c) => c.id);
  const [books, divs, trades] = await Promise.all([
    bookValues(q, ids),
    days ? q`select company_id, sum(total)::bigint as total from dividends
             where company_id = any(${ids}::int[]) and world_day >= ${fromDay} and world_day < ${toDay} group by company_id` : [],
    days ? q`select company_id, sum(qty * price)::numeric as value, sum(qty)::numeric as qty from share_trades
             where company_id = any(${ids}::int[]) and world_day >= ${fromDay} and world_day < ${toDay} group by company_id` : [],
  ]);
  const moves = [];
  for (const c of companies) {
    const b = books.get(c.id);
    let conf = Number(c.confidence);
    const prevBook = c.book_value == null ? null : Number(c.book_value);
    const prevPrice = c.share_price == null ? null : Number(c.share_price);
    const detail = { ...b };
    if (days) {
      const growth = prevBook ? clamp((b.total - prevBook) / prevBook, -0.5, 0.5) : 0;
      const paid = Number(divs.find((d) => d.company_id === c.id)?.total ?? 0);
      const yieldPart = clamp(paid / Math.max(b.total, 1), 0, 0.5);
      const t = trades.find((x) => x.company_id === c.id);
      const vwap = t && Number(t.qty) ? Number(t.value) / Number(t.qty) : null;
      const tradeSignal = vwap && prevPrice ? clamp(vwap / prevPrice - 1, -0.5, 0.5) : 0;
      const pull = Math.min(1, rules.reversionPerSession * (days / Math.max(1, sessionDays)));
      conf += rules.growthWeight * growth + rules.dividendWeight * yieldPart + rules.tradeWeight * tradeSignal - pull * (conf - 1);
      Object.assign(detail, { growth, dividendYield: yieldPart, tradeSignal, vwap });
    }
    conf = clamp(conf, rules.minConfidence, rules.maxConfidence);
    const shares = Number(c.shares_total);
    const price = shares ? (b.total * conf) / shares : null;
    await q`update companies set book_value = ${b.total}, confidence = ${conf.toFixed(4)},
              share_price = ${price == null ? null : price.toFixed(4)}, valued_day = ${toDay} where id = ${c.id}`;
    await q`insert into valuations (company_id, world_day, book_value, confidence, share_price, detail)
            values (${c.id}, ${toDay}, ${b.total}, ${conf.toFixed(4)}, ${price == null ? null : price.toFixed(4)}, ${JSON.stringify(detail)}::jsonb)`;
    if (prevPrice && price) moves.push({ ticker: c.ticker, change: price / prevPrice - 1 });
  }
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const big = moves.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).filter((m) => Math.abs(m.change) >= 0.005).slice(0, 5);
  return [`Exchange: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} revalued.${big.length ? ` ${big.map((m) => `${m.ticker} ${pct(m.change)}`).join(', ')}.` : ''}`];
}

/* ── Holdings ── */

export async function holding(q, companyId, owner) {
  const [h] = await q`select qty from shareholdings where company_id = ${companyId} and owner_type = ${owner.type} and owner_id = ${owner.id}`;
  return Number(h?.qty ?? 0);
}

export async function adjustShares(q, companyId, owner, delta) {
  if (delta >= 0) {
    await q`insert into shareholdings (company_id, owner_type, owner_id, qty) values (${companyId}, ${owner.type}, ${owner.id}, ${delta})
            on conflict (company_id, owner_type, owner_id) do update set qty = shareholdings.qty + excluded.qty`;
    return;
  }
  const rows = await q`update shareholdings set qty = qty + ${delta}
                       where company_id = ${companyId} and owner_type = ${owner.type} and owner_id = ${owner.id} and qty >= ${-delta} returning qty`;
  if (!rows.length) throw new HttpError(400, `${owner.label ?? 'That holder'} doesn't have ${-delta} shares.`);
}

/** Shares not already promised to open sell orders. */
async function freeShares(q, companyId, owner) {
  const [{ reserved }] = await q`select coalesce(sum(qty_left), 0)::bigint as reserved from share_orders
                                 where company_id = ${companyId} and owner_type = ${owner.type} and owner_id = ${owner.id}
                                   and side = 'sell' and status = 'active'`;
  return (await holding(q, companyId, owner)) - Number(reserved);
}

/** Money not already promised to open buy orders (base currency). */
async function freeFunds(q, owner, currencyId) {
  const [{ reserved }] = await q`select coalesce(sum(qty_left * price), 0)::bigint as reserved from share_orders
                                 where owner_type = ${owner.type} and owner_id = ${owner.id} and side = 'buy' and status = 'active'`;
  return (await balanceOf(q, owner, currencyId)) - Number(reserved);
}

const sameOwner = (a, b) => a.owner_type === b.type && a.owner_id === b.id;

/**
 * Places a limit order and matches it immediately against the book.
 * `owner` = { type, id, label }; `company` = companies row (locked). Returns { orderId, filled, trades }.
 */
export async function placeOrder(q, { me, company, owner, side, qty, price }) {
  if (!company.active) throw new HttpError(400, `${company.name} has been dissolved.`);
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'Quantity must be a whole number of shares.');
  if (!Number.isSafeInteger(price) || price < 1 || price > 1e15) throw new HttpError(400, 'Price per share must be at least 1.');
  const base = await baseCurrency(q);
  if (side === 'sell') {
    const free = await freeShares(q, company.id, owner);
    if (free < qty) throw new HttpError(400, `${owner.label ?? 'You'} can sell at most ${Math.max(0, free).toLocaleString()} ${company.ticker} shares (the rest are already offered).`);
  } else if (side === 'buy') {
    const free = await freeFunds(q, owner, base.id);
    if (free < qty * price) throw new HttpError(400, `${owner.label ?? 'You'} can't cover ${qty.toLocaleString()} shares at that price with money not already bid elsewhere.`);
  } else {
    throw new HttpError(400, 'Choose buy or sell.');
  }
  const day = await currentDay(q);
  const [o] = await q`
    insert into share_orders (company_id, side, owner_type, owner_id, qty_total, qty_left, price, created_day, created_by)
    values (${company.id}, ${side}, ${owner.type}, ${owner.id}, ${qty}, ${qty}, ${price}, ${day}, ${me.id}) returning id`;

  let left = qty;
  const trades = [];
  const book = side === 'buy'
    ? await q`select * from share_orders where company_id = ${company.id} and side = 'sell' and status = 'active' and price <= ${price}
              and id <> ${o.id} order by price, id for update`
    : await q`select * from share_orders where company_id = ${company.id} and side = 'buy' and status = 'active' and price >= ${price}
              and id <> ${o.id} order by price desc, id for update`;
  for (const r of book) {
    if (left <= 0) break;
    if (sameOwner(r, owner)) continue; // never trade with yourself
    const rOwner = { type: r.owner_type, id: r.owner_id };
    const seller = side === 'buy' ? rOwner : owner;
    const buyer = side === 'buy' ? owner : rOwner;
    let n = Math.min(left, Number(r.qty_left), await holding(q, company.id, seller));
    n = Math.min(n, Math.floor((await balanceOf(q, buyer, base.id)) / Number(r.price)));
    if (n <= 0) {
      // The resting order can't be honoured any more (its owner sold the shares or spent the money).
      const restingShort = side === 'buy' ? (await holding(q, company.id, rOwner)) < 1 : (await balanceOf(q, rOwner, base.id)) < Number(r.price);
      if (restingShort) { await q`update share_orders set status = 'cancelled' where id = ${r.id}`; continue; }
      break; // the incoming side can't pay/deliver more
    }
    const total = n * Number(r.price);
    await move(q, { from: { ...buyer }, to: { ...seller }, currencyId: base.id, amount: total, kind: 'shares',
      memo: `${n.toLocaleString()} ${company.ticker} shares at ${Number(r.price)} each`, actorId: me.id, day });
    await adjustShares(q, company.id, seller, -n);
    await adjustShares(q, company.id, buyer, n);
    await q`insert into share_trades (company_id, buyer_type, buyer_id, seller_type, seller_id, qty, price, world_day)
            values (${company.id}, ${buyer.type}, ${buyer.id}, ${seller.type}, ${seller.id}, ${n}, ${Number(r.price)}, ${day})`;
    const rLeft = Number(r.qty_left) - n;
    await q`update share_orders set qty_left = ${rLeft}, status = ${rLeft === 0 ? 'filled' : 'active'} where id = ${r.id}`;
    left -= n;
    trades.push({ qty: n, price: Number(r.price) });
  }
  await q`update share_orders set qty_left = ${left}, status = ${left === 0 ? 'filled' : 'active'} where id = ${o.id}`;
  return { orderId: o.id, filled: qty - left, left, trades };
}

/** Pays `perShare` (base sub-units) to every outside shareholder. Returns the dividend record. */
export async function declareDividend(q, { me, company, perShare }) {
  if (!Number.isSafeInteger(perShare) || perShare < 1) throw new HttpError(400, 'Dividend per share must be at least 1.');
  const base = await baseCurrency(q);
  const holders = await q`
    select h.owner_type, h.owner_id, h.qty, coalesce(u.rp_name, c.name) as name from shareholdings h
    left join users u on h.owner_type = 'user' and u.id = h.owner_id
    left join companies c on h.owner_type = 'company' and c.id = h.owner_id
    where h.company_id = ${company.id} and h.qty > 0 and not (h.owner_type = 'company' and h.owner_id = ${company.id})
    order by h.owner_type, h.owner_id`;
  const shares = holders.reduce((s, h) => s + Number(h.qty), 0);
  if (!shares) throw new HttpError(400, `${company.name} has no outside shareholders to pay.`);
  const total = shares * perShare;
  const treasury = await balanceOf(q, { type: 'company', id: company.id }, base.id);
  if (treasury < total) throw new HttpError(400, `${company.name}'s treasury can't cover ${total.toLocaleString()} (${shares.toLocaleString()} shares × ${perShare}).`);
  const day = await currentDay(q);
  const from = { type: 'company', id: company.id, label: company.name };
  for (const h of holders) {
    await move(q, { from, to: { type: h.owner_type, id: h.owner_id }, currencyId: base.id, amount: Number(h.qty) * perShare,
      kind: 'dividend', memo: `${company.ticker} dividend: ${Number(h.qty).toLocaleString()} shares × ${perShare}`, actorId: me.id, day });
  }
  const [d] = await q`insert into dividends (company_id, world_day, per_share, shares_paid, total, currency_id, declared_by)
                      values (${company.id}, ${day}, ${perShare}, ${shares}, ${total}, ${base.id}, ${me.id}) returning id`;
  return { id: d.id, perShare, shares, total, holders: holders.length };
}

/** Company summary rows for the board (current valuation, last trade, previous price). */
export async function boardRows(q, { includeInactive = false } = {}) {
  const rows = await q`
    select c.id, c.name, c.ticker, c.active, c.shares_total, c.confidence, c.book_value, c.share_price, c.valued_day, c.other_assets,
           s.name as home_name,
           (select price from share_trades t where t.company_id = c.id order by id desc limit 1) as last_trade,
           (select share_price from valuations v where v.company_id = c.id order by id desc offset 1 limit 1) as prev_price,
           (select coalesce(sum(total), 0) from dividends d where d.company_id = c.id) as dividends_total,
           (select qty from shareholdings h where h.company_id = c.id and h.owner_type = 'company' and h.owner_id = c.id) as treasury_shares
    from companies c left join settlements s on s.id = c.home_settlement_id
    where c.kind not in ('house', 'crown') and (${includeInactive} or c.active)
    order by c.name`;
  const history = rows.length ? await q`
    select company_id, world_day, share_price from (
      select company_id, world_day, share_price, row_number() over (partition by company_id order by id desc) as rn
      from valuations where company_id = any(${rows.map((r) => r.id)}::int[])) v
    where rn <= 30 order by company_id, world_day` : [];
  return rows.map((c) => ({
    id: c.id, name: c.name, ticker: c.ticker, active: c.active, homeName: c.home_name,
    sharesTotal: Number(c.shares_total), treasuryShares: Number(c.treasury_shares ?? 0),
    confidence: Number(c.confidence), bookValue: c.book_value == null ? null : Number(c.book_value),
    sharePrice: c.share_price == null ? null : Number(c.share_price), prevPrice: c.prev_price == null ? null : Number(c.prev_price),
    lastTrade: c.last_trade == null ? null : Number(c.last_trade), valuedDay: c.valued_day,
    otherAssets: Number(c.other_assets), dividendsTotal: Number(c.dividends_total),
    history: history.filter((h) => h.company_id === c.id && h.share_price != null).map((h) => ({ day: h.world_day, price: Number(h.share_price) })),
  }));
}

export const publicOrder = (o) => ({
  id: o.id, companyId: o.company_id, ticker: o.ticker, side: o.side, ownerType: o.owner_type, ownerId: o.owner_id, ownerName: o.owner_name,
  qtyTotal: Number(o.qty_total), qtyLeft: Number(o.qty_left), price: Number(o.price), status: o.status, createdDay: o.created_day,
});
