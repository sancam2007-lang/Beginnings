// The goods core. Goods always sit in a STOCKPILE: one owner, one place.
// A player's "personal" stockpile has no settlement — it travels with the character.
// Company goods (and player warehouses) are tied to a settlement and can't teleport.
import { HttpError } from './http.js';
import { currentDay } from './ledger.js';

export function cleanQty(v, label = 'Quantity', max = 1_000_000) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw new HttpError(400, `${label} must be a whole number from 1 to ${max.toLocaleString()}.`);
  return n;
}

export async function getGood(q, id, { activeOnly = true } = {}) {
  const [g] = await q`select * from goods where id = ${Number(id) || 0}`;
  if (!g || (activeOnly && !g.active)) throw new HttpError(404, 'That good is not available.');
  return g;
}

/** A user's personal (carried) stockpile, created on first use. */
export async function personalStockpile(q, userId) {
  await q`insert into stockpiles (owner_type, owner_id, name, kind)
          values ('user', ${userId}, 'Personal', 'personal')
          on conflict (owner_type, owner_id) where kind = 'personal' do nothing`;
  const [s] = await q`select * from stockpiles where owner_type = 'user' and owner_id = ${userId} and kind = 'personal'`;
  return s;
}

export async function getStockpile(q, id) {
  const [s] = await q`
    select s.*, st.name as settlement_name,
           case when s.owner_type = 'user' then u.rp_name else c.name end as owner_name
    from stockpiles s
    left join settlements st on st.id = s.settlement_id
    left join users u on s.owner_type = 'user' and u.id = s.owner_id
    left join companies c on s.owner_type = 'company' and c.id = s.owner_id
    where s.id = ${Number(id) || 0}`;
  if (!s || !s.active) throw new HttpError(404, 'That stockpile does not exist.');
  return s;
}

/** Company role of a user ('director' | 'officer' | null). */
export async function companyRole(q, companyId, userId) {
  const [m] = await q`select role from company_members where company_id = ${companyId} and user_id = ${userId}`;
  return m?.role ?? null;
}

/** May `me` take goods out of / spend on behalf of this stockpile's owner? */
export async function canUseStockpile(q, me, s) {
  if (me.role === 'gm') return true;
  if (s.owner_type === 'user') return s.owner_id === me.id;
  return Boolean(await companyRole(q, s.owner_id, me.id));
}

export async function requireStockpileAccess(q, me, s) {
  if (!(await canUseStockpile(q, me, s))) throw new HttpError(403, `You can't use ${s.name}.`);
}

/** Goods only move between stockpiles in the same place (personal = carried, fits anywhere). */
export function requireSamePlace(a, b) {
  if (a.settlement_id && b.settlement_id && a.settlement_id !== b.settlement_id) {
    throw new HttpError(400, `${a.name} and ${b.name} are in different places. Goods must be shipped between settlements.`);
  }
}

const ownerLabel = (s) => (s.kind === 'personal' ? (s.owner_name ?? null) : `${s.owner_name ?? 'Owner'} — ${s.name}`);

/** Adds `delta` of a good to a stockpile. Removals fail if short; additions fail if over capacity. */
export async function adjustStock(q, s, good, delta) {
  if (delta >= 0) {
    if (s.capacity != null) {
      const [{ used }] = await q`select coalesce(sum(qty), 0)::bigint as used from stock where stockpile_id = ${s.id}`;
      if (Number(used) + delta > Number(s.capacity)) {
        throw new HttpError(400, `${s.name} is full (${Number(used).toLocaleString()} of ${Number(s.capacity).toLocaleString()} units).`);
      }
    }
    await q`insert into stock (stockpile_id, good_id, qty) values (${s.id}, ${good.id}, ${delta})
            on conflict (stockpile_id, good_id) do update set qty = stock.qty + excluded.qty`;
    return;
  }
  const [row] = await q`update stock set qty = qty + ${delta}
                        where stockpile_id = ${s.id} and good_id = ${good.id} and qty >= ${-delta} returning qty`;
  if (!row) {
    const who = s.kind === 'personal' && !s.label ? "You don't" : `${s.label ?? ownerLabel(s)} doesn't`;
    throw new HttpError(400, `${who} have ${-delta} × ${good.name}${s.kind === 'personal' ? '' : ` in ${s.name}`}.`);
  }
}

/** Moves goods between stockpiles (null = the market / the Crown) and logs it. */
export async function moveItems(q, {
  from = null, to = null, good, qty, kind, marketId = null, unitPrice = null,
  currencyId = null, memo = null, actorId = null, groupId = null, projectId = null, shipmentId = null,
}) {
  if (from) await adjustStock(q, from, good, -qty);
  if (to) await adjustStock(q, to, good, qty);
  const day = await currentDay(q);
  await q`
    insert into item_log (group_id, world_day, kind, from_type, from_id, to_type, to_id, good_id, qty,
                          market_id, unit_price, currency_id, memo, actor_id, from_stockpile_id, to_stockpile_id, project_id, shipment_id)
    values (${groupId}, ${day}, ${kind}, ${from?.owner_type ?? null}, ${from?.owner_id ?? null},
            ${to?.owner_type ?? null}, ${to?.owner_id ?? null}, ${good.id}, ${qty}, ${marketId}, ${unitPrice},
            ${currencyId}, ${memo}, ${actorId}, ${from?.id ?? null}, ${to?.id ?? null}, ${projectId}, ${shipmentId})`;
}

/** Every stockpile an owner has, with contents. */
export async function holdings(q, owner) {
  const piles = await q`
    select s.id, s.name, s.kind, s.capacity, s.settlement_id, s.haul_to_id, st.name as settlement_name
    from stockpiles s left join settlements st on st.id = s.settlement_id
    where s.owner_type = ${owner.type} and s.owner_id = ${owner.id} and s.active
    order by (s.kind = 'personal') desc, st.name nulls first, s.name`;
  const rows = piles.length ? await q`
    select k.stockpile_id, k.good_id, k.qty, g.name, g.unit, g.category
    from stock k join goods g on g.id = k.good_id
    where k.stockpile_id = any(${piles.map((p) => p.id)}::int[]) and k.qty > 0
    order by g.category, lower(g.name)` : [];
  return piles.map((p) => {
    const items = rows.filter((r) => r.stockpile_id === p.id)
      .map((r) => ({ goodId: r.good_id, qty: Number(r.qty), name: r.name, unit: r.unit, category: r.category }));
    return {
      id: p.id, name: p.name, kind: p.kind, settlementId: p.settlement_id, settlementName: p.settlement_name, haulToId: p.haul_to_id,
      capacity: p.capacity == null ? null : Number(p.capacity), used: items.reduce((s, i) => s + i.qty, 0), items,
    };
  });
}

/** Item log for one owner (or everyone), newest first. */
export async function itemLog(q, { owner = null, before = null, limit = 25 } = {}) {
  const rows = await q`
    select l.*, g.name as good_name, g.unit, m.name as market_name,
           coalesce(fu.rp_name, fc.name) as from_name, coalesce(tu.rp_name, tc.name) as to_name,
           fs.name as from_pile, ts.name as to_pile, fss.name as from_place, tss.name as to_place
    from item_log l
    join goods g on g.id = l.good_id
    left join markets m on m.id = l.market_id
    left join users fu on l.from_type = 'user' and fu.id = l.from_id
    left join users tu on l.to_type = 'user' and tu.id = l.to_id
    left join companies fc on l.from_type = 'company' and fc.id = l.from_id
    left join companies tc on l.to_type = 'company' and tc.id = l.to_id
    left join stockpiles fs on fs.id = l.from_stockpile_id
    left join stockpiles ts on ts.id = l.to_stockpile_id
    left join settlements fss on fss.id = fs.settlement_id
    left join settlements tss on tss.id = ts.settlement_id
    where (${owner?.type ?? null}::text is null
           or (l.from_type = ${owner?.type ?? null} and l.from_id = ${owner?.id ?? null})
           or (l.to_type = ${owner?.type ?? null} and l.to_id = ${owner?.id ?? null}))
      and (${before}::bigint is null or l.id < ${before}::bigint)
    order by l.id desc limit ${limit + 1}`;
  const more = rows.length > limit;
  const party = (type, id, name, pile, place) => (type ? {
    type, id, name, stockpile: pile && pile !== 'Personal' ? pile : null, place: place ?? null,
  } : null);
  const entries = rows.slice(0, limit).map((r) => ({
    id: Number(r.id), kind: r.kind, worldDay: r.world_day, goodId: r.good_id, goodName: r.good_name, unit: r.unit,
    qty: Number(r.qty), marketName: r.market_name, unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    currencyId: r.currency_id, memo: r.memo,
    from: party(r.from_type, r.from_id, r.from_name, r.from_pile, r.from_place),
    to: party(r.to_type, r.to_id, r.to_name, r.to_pile, r.to_place),
  }));
  return { entries, nextBefore: more ? entries[entries.length - 1].id : null };
}
