// Shipping between towns (replaces routes, vessels and voyages).
//
// A shipment carries goods from a stockpile in one town to a stockpile (any owner's) in another.
// The sender picks how long it takes, between the GM's minimum and maximum (5–10 days by default),
// and pays freight in the base currency:
//     fee = rate per unit × units × (1 + rush % × days faster than the slowest)
// The goods leave the source stockpile when the shipment is sent and arrive on the first advance
// that reaches the arrival day. If the destination is full or closed, the rest waits there
// ("waiting") and is delivered as soon as there is room; the sender or GM can redirect it.
// Nothing is lost on the way.
import { HttpError } from './http.js';
import { getSetting } from './db.js';
import { move, currentDay } from './ledger.js';
import { moveItems } from './inventory.js';

export const DEFAULT_RULES = { ratePerUnit: 0, rushPctPerDay: 10, minDays: 5, maxDays: 10 };
const MAX_CARGO_LINES = 20;

export function cleanRules(b = {}) {
  const num = (v, lo, hi, d, label) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${label} must be between ${lo} and ${hi}.`);
    return n;
  };
  const r = {
    ratePerUnit: num(b.ratePerUnit, 0, 1e9, DEFAULT_RULES.ratePerUnit, 'Freight per unit'),
    rushPctPerDay: num(b.rushPctPerDay, 0, 1000, DEFAULT_RULES.rushPctPerDay, 'Rush surcharge'),
    minDays: Math.round(num(b.minDays, 1, 365, DEFAULT_RULES.minDays, 'Fastest shipment')),
    maxDays: Math.round(num(b.maxDays, 1, 365, DEFAULT_RULES.maxDays, 'Slowest shipment')),
  };
  if (r.minDays > r.maxDays) throw new HttpError(400, 'The fastest shipment can’t take longer than the slowest.');
  return r;
}
export async function loadRules(q) {
  return { ...DEFAULT_RULES, ...(await getSetting('shipping', DEFAULT_RULES, q)) };
}

/** Freight for `units` over `days`, in base-currency sub-units. */
export function freight(rules, units, days) {
  const rate = Number(rules.ratePerUnit) || 0;
  if (rate <= 0 || units <= 0) return 0;
  const faster = Math.max(0, rules.maxDays - days);
  return Math.max(1, Math.ceil(rate * units * (1 + (Number(rules.rushPctPerDay) || 0) / 100 * faster) - 1e-9));
}

export function cleanDays(rules, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < rules.minDays || n > rules.maxDays) {
    throw new HttpError(400, `Choose ${rules.minDays}–${rules.maxDays} days.`);
  }
  return n;
}

/** May `me` send goods for this owner? (the player, an officer of the company, or the GM) */
export async function canActFor(q, me, ownerType, ownerId) {
  if (me.role === 'gm') return true;
  if (ownerType === 'user') return ownerId === me.id;
  const [m] = await q`select 1 from company_members cm join companies c on c.id = cm.company_id
                      where cm.company_id = ${ownerId} and cm.user_id = ${me.id} and c.active`;
  return Boolean(m);
}

export function cleanCargo(list) {
  if (!Array.isArray(list)) return [];
  const byGood = new Map();
  for (const line of list) {
    const goodId = Number(line?.goodId);
    const qty = Number(line?.qty);
    if (!goodId || !qty) continue;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1e9) throw new HttpError(400, 'Quantities must be whole numbers from 1.');
    byGood.set(goodId, (byGood.get(goodId) ?? 0) + qty);
  }
  if (byGood.size > MAX_CARGO_LINES) throw new HttpError(400, `At most ${MAX_CARGO_LINES} different goods per shipment.`);
  return [...byGood].map(([goodId, qty]) => ({ goodId, qty }));
}

/**
 * Sends a shipment. `from` / `to` are stockpile rows (from needs owner_name). Charges freight to the
 * sender (the source stockpile's owner), takes the goods out of `from`. Returns { id, fee, arriveDay, units }.
 */
export async function sendShipment(q, { me, from, to, cargo, days, rules }) {
  if (!from || !from.active || from.kind === 'personal') throw new HttpError(400, 'Ship from a warehouse or depot (your pack travels with you).');
  if (!to || !to.active || to.kind === 'personal') throw new HttpError(400, 'Ship to a warehouse or depot that is open.');
  if (from.settlement_id === to.settlement_id) throw new HttpError(400, `${to.name} is in the same town — move the goods directly instead.`);
  const d = cleanDays(rules, days);
  const lines = cleanCargo(cargo);
  if (!lines.length) throw new HttpError(400, 'Add something to ship.');
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const goods = await q`select id, name from goods where id = any(${lines.map((l) => l.goodId)}::int[])`;
  const day = await currentDay(q);
  const [base] = await q`select id from currencies where is_base`;
  const fee = freight(rules, units, d);
  const [s] = await q`
    insert into shipments (owner_type, owner_id, from_stockpile_id, to_stockpile_id, from_settlement_id, to_settlement_id,
                           depart_day, days, arrive_day, fee_minor, fee_currency_id, created_by)
    values (${from.owner_type}, ${from.owner_id}, ${from.id}, ${to.id}, ${from.settlement_id}, ${to.settlement_id},
            ${day}, ${d}, ${day + d}, ${fee}, ${base.id}, ${me?.id ?? null})
    returning id`;
  if (fee > 0) {
    await move(q, { from: { type: from.owner_type, id: from.owner_id, label: from.owner_name }, to: null, currencyId: base.id, amount: fee,
      kind: 'freight', memo: `Freight: ${units.toLocaleString()} units to ${to.name} (${d} days)`, actorId: me?.id ?? null, day });
  }
  for (const l of lines) {
    const good = goods.find((g) => g.id === l.goodId);
    if (!good) throw new HttpError(404, 'Unknown good in the shipment.');
    await moveItems(q, { from, to: null, good, qty: l.qty, kind: 'ship_out', actorId: me?.id ?? null, shipmentId: s.id,
      memo: `Shipped to ${to.name} (${d} days)` });
    await q`insert into shipment_cargo (shipment_id, good_id, loaded, qty) values (${s.id}, ${l.goodId}, ${l.qty}, ${l.qty})`;
  }
  return { id: s.id, fee, arriveDay: day + d, units };
}

/** Puts a shipment's cargo into its destination (as much as fits). Returns units delivered. */
async function deliver(q, s, day, actorId = null) {
  const [pile] = s.to_stockpile_id ? await q`select * from stockpiles where id = ${s.to_stockpile_id} for update` : [];
  if (!pile || !pile.active) {
    await q`update shipments set status = 'waiting', note = ${pile ? `${pile.name} is closed` : 'no destination stockpile'} where id = ${s.id}`;
    return 0;
  }
  let free = Infinity;
  if (pile.capacity != null) {
    const [{ used }] = await q`select coalesce(sum(qty), 0)::bigint as used from stock where stockpile_id = ${pile.id}`;
    free = Math.max(0, Number(pile.capacity) - Number(used));
  }
  const cargo = await q`select c.good_id, c.qty, g.name from shipment_cargo c join goods g on g.id = c.good_id
                        where c.shipment_id = ${s.id} and c.qty > 0 order by c.good_id`;
  let moved = 0;
  for (const c of cargo) {
    const n = Math.min(Number(c.qty), free);
    if (n <= 0) break;
    await moveItems(q, { from: null, to: { ...pile, capacity: null }, good: { id: c.good_id, name: c.name }, qty: n,
      kind: 'ship_in', actorId, shipmentId: s.id, memo: `Arrived at ${pile.name}` });
    await q`update shipment_cargo set qty = qty - ${n} where shipment_id = ${s.id} and good_id = ${c.good_id}`;
    free -= n;
    moved += n;
  }
  const [{ left }] = await q`select coalesce(sum(qty), 0)::bigint as left from shipment_cargo where shipment_id = ${s.id}`;
  if (Number(left) === 0) {
    await q`update shipments set status = 'delivered', delivered_day = ${day}, note = null where id = ${s.id}`;
  } else {
    await q`update shipments set status = 'waiting', note = ${`${pile.name} is full — ${Number(left).toLocaleString()} units waiting for room`} where id = ${s.id}`;
  }
  return moved;
}

/** Tick: deliver everything due by `toDay`, and retry waiting shipments. */
export async function tickShipments(q, { toDay }) {
  const due = await q`select * from shipments where (status = 'transit' and arrive_day <= ${toDay}) or status = 'waiting'
                      order by arrive_day, id for update`;
  if (!due.length) return [];
  let arrived = 0;
  let units = 0;
  for (const s of due) {
    const n = await deliver(q, s, toDay);
    units += n;
    const [now] = await q`select status from shipments where id = ${s.id}`;
    if (now.status === 'delivered') arrived += 1;
  }
  const [{ waiting }] = await q`select count(*)::int as waiting from shipments where status = 'waiting'`;
  const parts = [arrived && `${arrived} shipment${arrived === 1 ? '' : 's'} arrived (${units.toLocaleString()} units)`,
    waiting && `${waiting} waiting at a full or closed destination`].filter(Boolean);
  return parts.length ? [`Shipping: ${parts.join('; ')}.`] : [];
}

/** Sends a waiting shipment to a different stockpile in the same destination town, and tries delivery. */
export async function redirectShipment(q, s, pile, actorId = null) {
  if (!['waiting', 'transit'].includes(s.status)) throw new HttpError(400, 'That shipment has already been delivered.');
  if (!pile || !pile.active || pile.kind === 'personal' || pile.settlement_id !== s.to_settlement_id) {
    throw new HttpError(400, 'Choose an open warehouse or depot in the destination town.');
  }
  await q`update shipments set to_stockpile_id = ${pile.id} where id = ${s.id}`;
  const day = await currentDay(q);
  if (s.status === 'waiting' || s.arrive_day <= day) return deliver(q, { ...s, to_stockpile_id: pile.id }, day, actorId);
  return 0;
}

/** GM: delivers a shipment now. */
export async function arriveNow(q, s, actorId = null) {
  if (!['waiting', 'transit'].includes(s.status)) throw new HttpError(400, 'That shipment has already been delivered.');
  const day = await currentDay(q);
  await q`update shipments set arrive_day = least(arrive_day, ${day}) where id = ${s.id}`;
  return deliver(q, s, day, actorId);
}

/** GM: sends what's still in transit back into the stockpile it came from (ignores capacity). */
export async function returnShipment(q, s, actorId = null) {
  if (!['waiting', 'transit'].includes(s.status)) throw new HttpError(400, 'That shipment has already been delivered.');
  const [pile] = s.from_stockpile_id ? await q`select * from stockpiles where id = ${s.from_stockpile_id}` : [];
  if (!pile) throw new HttpError(400, 'The stockpile it came from no longer exists — redirect it instead.');
  const cargo = await q`select c.good_id, c.qty, g.name from shipment_cargo c join goods g on g.id = c.good_id
                        where c.shipment_id = ${s.id} and c.qty > 0`;
  for (const c of cargo) {
    await moveItems(q, { from: null, to: { ...pile, capacity: null }, good: { id: c.good_id, name: c.name }, qty: Number(c.qty),
      kind: 'ship_in', actorId, shipmentId: s.id, memo: `Returned to ${pile.name}` });
  }
  await q`update shipment_cargo set qty = 0 where shipment_id = ${s.id}`;
  await q`update shipments set status = 'returned', delivered_day = ${await currentDay(q)}, note = 'returned to sender by the GM' where id = ${s.id}`;
}

/**
 * Shipments as API objects. Filter by owners (sent by, or delivered to a stockpile of, any of them),
 * or everything (GM).
 */
export async function listShipments(q, { owners = null, limit = 80 } = {}) {
  const types = owners?.map((o) => o.type) ?? null;
  const ids = owners?.map((o) => o.id) ?? null;
  const rows = await q`
    select sh.*, fs.name as from_town, ts.name as to_town, fp.name as from_pile, tp.name as to_pile,
           tp.owner_type as to_owner_type, tp.owner_id as to_owner_id,
           coalesce(c.name, u.rp_name) as owner_name, coalesce(c2.name, u2.rp_name) as to_owner_name
    from shipments sh
    join settlements fs on fs.id = sh.from_settlement_id
    join settlements ts on ts.id = sh.to_settlement_id
    left join stockpiles fp on fp.id = sh.from_stockpile_id
    left join stockpiles tp on tp.id = sh.to_stockpile_id
    left join companies c on sh.owner_type = 'company' and c.id = sh.owner_id
    left join users u on sh.owner_type = 'user' and u.id = sh.owner_id
    left join companies c2 on tp.owner_type = 'company' and c2.id = tp.owner_id
    left join users u2 on tp.owner_type = 'user' and u2.id = tp.owner_id
    where (${types}::text[] is null
           or (sh.owner_type, sh.owner_id) in (select * from unnest(${types}::text[], ${ids}::int[]))
           or (tp.owner_type, tp.owner_id) in (select * from unnest(${types}::text[], ${ids}::int[])))
    order by (sh.status in ('transit', 'waiting')) desc, sh.arrive_day desc, sh.id desc
    limit ${limit}`;
  if (!rows.length) return [];
  const cargo = await q`select c.*, g.name, g.unit from shipment_cargo c join goods g on g.id = c.good_id
                        where c.shipment_id = any(${rows.map((r) => r.id)}::int[]) order by g.name`;
  return rows.map((s) => ({
    id: s.id, status: s.status, note: s.note,
    ownerType: s.owner_type, ownerId: s.owner_id, ownerName: s.owner_name,
    fromStockpileId: s.from_stockpile_id, fromPile: s.from_pile, fromTown: s.from_town, fromSettlementId: s.from_settlement_id,
    toStockpileId: s.to_stockpile_id, toPile: s.to_pile, toTown: s.to_town, toSettlementId: s.to_settlement_id,
    toOwnerType: s.to_owner_type, toOwnerId: s.to_owner_id, toOwnerName: s.to_owner_name,
    departDay: s.depart_day, days: s.days, arriveDay: s.arrive_day, deliveredDay: s.delivered_day,
    fee: Number(s.fee_minor), feeCurrencyId: s.fee_currency_id,
    cargo: cargo.filter((c) => c.shipment_id === s.id).map((c) => ({ goodId: c.good_id, name: c.name, unit: c.unit, loaded: Number(c.loaded), qty: Number(c.qty) })),
  }));
}
