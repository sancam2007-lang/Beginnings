// Buildings and real estate.
//
// A BUILDING is one property: a workplace (with its own store), a storage building (warehouse or
// depot), or a plain building. `owner` is who holds title. Its workplace and store are OPERATED by
// the owner, or by the tenant while it is leased.
//
// SALES: the owner (or the GM) lists a building at a price; the first buyer who pays gets it.
//   Workers stay on (the new owner pays their wages); stores must be empty, and have no open market
//   orders, when it is listed and when it changes hands, so goods never change owners by accident.
// LEASES: the owner lists it for rent per session (optionally for a fixed term). The tenant takes over
//   the workplace and store and pays rent each advance (pro rata, like wages). A tenant can leave any
//   time with empty stores; an at-will lease can also be ended by the landlord. If the tenant can't pay,
//   or a fixed term runs out, or the landlord/GM ends it, whatever is left in the stores stays with the
//   building (the landlord's now) and is logged.
// CROWN property belongs to the "Crown Estates" company; what it is paid leaves circulation.
import { HttpError } from './http.js';
import { getSetting } from './db.js';
import { move, currentDay, balanceOf } from './ledger.js';

export const KIND_LABEL = { workplace: 'Workplace', storage: 'Storage', building: 'Building' };

export async function crownId(q) {
  const [c] = await q`select id from companies where kind = 'crown' order by id limit 1`;
  if (!c) throw new HttpError(500, 'Crown Estates is missing — the database migration has not run.');
  return c.id;
}
const isCrown = async (q, owner) => owner.type === 'company' && owner.id === (await crownId(q));

export async function loadBuilding(q, id, { lock = false } = {}) {
  const [b] = lock
    ? await q`select * from buildings where id = ${Number(id) || 0} for update`
    : await q`select * from buildings where id = ${Number(id) || 0}`;
  if (!b) throw new HttpError(404, 'Building not found.');
  return b;
}

/** Adds a building to the registry. */
export async function registerBuilding(q, { name, kind, settlementId, owner, workplaceId = null, stockpileId = null,
  projectId = null, blueprintId = null, origin = 'construction', description = null }) {
  const [b] = await q`
    insert into buildings (name, kind, settlement_id, owner_type, owner_id, workplace_id, stockpile_id, project_id, blueprint_id,
                           origin, built_day, description)
    values (${name}, ${kind}, ${settlementId}, ${owner.type}, ${owner.id}, ${workplaceId}, ${stockpileId}, ${projectId}, ${blueprintId},
            ${origin}, ${await currentDay(q)}, ${description})
    returning *`;
  return b;
}

export const activeLease = async (q, b) => (await q`select * from leases where building_id = ${b.id} and status = 'active' for update`)[0] ?? null;
export const activeListing = async (q, b) => (await q`select * from property_listings where building_id = ${b.id} and status = 'active' for update`)[0] ?? null;

/** Why a building's stores can't change hands right now (null = fine). */
export async function contentsProblem(q, b) {
  if (!b.stockpile_id) return null;
  const [{ used }] = await q`select coalesce(sum(qty), 0)::bigint as used from stock where stockpile_id = ${b.stockpile_id}`;
  if (Number(used) > 0) return `Its store still holds ${Number(used).toLocaleString()} units. Move or sell them first.`;
  const [order] = await q`select 1 from market_orders where stockpile_id = ${b.stockpile_id} and status = 'active' limit 1`;
  if (order) return 'Its store has open market listings or buy orders. Withdraw them first.';
  return null;
}

/** Who operates the building's workplace and store (and so pays its wages and owns what it makes). */
async function setOperator(q, b, owner) {
  if (b.workplace_id) await q`update workplaces set owner_type = ${owner.type}, owner_id = ${owner.id} where id = ${b.workplace_id}`;
  if (b.stockpile_id) {
    await q`update stockpiles set owner_type = ${owner.type}, owner_id = ${owner.id}, haul_to_id = null where id = ${b.stockpile_id}`;
    await q`update stockpiles set haul_to_id = null where haul_to_id = ${b.stockpile_id}`;
  }
}

/** Hands a building's contents to its new operator, logging each good (eviction, expiry). */
async function forfeitContents(q, b, from, to, reason) {
  if (!b.stockpile_id) return 0;
  // Close the old operator's open orders on this store (sell listings return their goods first).
  const orders = await q`select * from market_orders where stockpile_id = ${b.stockpile_id} and status = 'active' for update`;
  if (orders.length) {
    const { cancelOrder } = await import('./bulk-book.js');
    for (const o of orders) await cancelOrder(q, { me: { id: null, role: 'gm' }, order: o });
  }
  const rows = await q`select good_id, qty from stock where stockpile_id = ${b.stockpile_id} and qty > 0`;
  const day = await currentDay(q);
  for (const r of rows) {
    await q`insert into item_log (world_day, kind, from_type, from_id, to_type, to_id, good_id, qty, memo, from_stockpile_id, to_stockpile_id)
            values (${day}, 'forfeit', ${from.type}, ${from.id}, ${to.type}, ${to.id}, ${r.good_id}, ${r.qty}, ${`Left in ${b.name}: ${reason}`},
                    ${b.stockpile_id}, ${b.stockpile_id})`;
  }
  return rows.reduce((s, r) => s + Number(r.qty), 0);
}

/**
 * Gives a building a new owner (sale, gift, GM transfer). Stores must be empty; not while leased.
 * Any open listing is closed.
 */
export async function transferBuilding(q, b, to, { listingStatus = 'cancelled' } = {}) {
  if (await activeLease(q, b)) throw new HttpError(400, `${b.name} is leased. End the lease first.`);
  const problem = await contentsProblem(q, b);
  if (problem) throw new HttpError(400, problem);
  const listing = await activeListing(q, b);
  if (listing) await q`update property_listings set status = ${listingStatus}, closed_day = ${await currentDay(q)} where id = ${listing.id}`;
  await q`update buildings set owner_type = ${to.type}, owner_id = ${to.id} where id = ${b.id}`;
  await setOperator(q, b, to);
}

/**
 * A workplace or stockpile got a new owner through the GM's Labor/Companies forms: move the building's
 * title with it. Refused while the building is leased (the tenant operates it). Closes any open listing.
 */
export async function syncTitle(q, { workplaceId = null, stockpileId = null }, to) {
  const [b] = workplaceId
    ? await q`select * from buildings where workplace_id = ${workplaceId} for update`
    : await q`select * from buildings where stockpile_id = ${stockpileId} for update`;
  if (!b) return;
  if (await activeLease(q, b)) throw new HttpError(400, `${b.name} is leased. End the lease (GM → Real Estate) before changing its owner.`);
  const listing = await activeListing(q, b);
  if (listing) await q`update property_listings set status = 'cancelled', closed_day = ${await currentDay(q)} where id = ${listing.id}`;
  await q`update buildings set owner_type = ${to.type}, owner_id = ${to.id} where id = ${b.id}`;
}

/* ── Listings ── */

export function cleanListing(body) {
  const kind = body.kind === 'lease' ? 'lease' : 'sale';
  const price = Number(body.price);
  if (!Number.isSafeInteger(price) || price < 0 || price > 1e14) throw new HttpError(400, `${kind === 'sale' ? 'Price' : 'Rent'} must be a whole number of sub-units, 0 or more.`);
  let term = null;
  if (kind === 'lease' && body.termSessions !== undefined && body.termSessions !== null && body.termSessions !== '') {
    term = Number(body.termSessions);
    if (!(term > 0 && term <= 1000)) throw new HttpError(400, 'Lease term must be more than 0 sessions (or blank for an open-ended lease).');
  }
  return { kind, price, currencyId: Number(body.currencyId) || null, term, note: String(body.note ?? '').trim().slice(0, 300) || null };
}

export async function createListing(q, { b, f, me }) {
  if (await activeListing(q, b)) throw new HttpError(400, `${b.name} is already on the market. Withdraw that listing first.`);
  if (await activeLease(q, b)) throw new HttpError(400, `${b.name} is leased. It can be listed once the lease ends.`);
  const problem = await contentsProblem(q, b);
  if (problem) throw new HttpError(400, problem);
  const [cur] = f.currencyId ? await q`select * from currencies where id = ${f.currencyId} and active` : await q`select * from currencies where is_base`;
  if (!cur) throw new HttpError(400, 'Choose a currency.');
  const [l] = await q`
    insert into property_listings (building_id, kind, seller_type, seller_id, price_minor, currency_id, term_sessions, note, created_day, created_by)
    values (${b.id}, ${f.kind}, ${b.owner_type}, ${b.owner_id}, ${f.price}, ${cur.id}, ${f.term}, ${f.note}, ${await currentDay(q)}, ${me?.id ?? null})
    returning *`;
  return l;
}

export async function loadListing(q, id) {
  const [l] = await q`select * from property_listings where id = ${Number(id) || 0} for update`;
  if (!l) throw new HttpError(404, 'Listing not found.');
  return l;
}

async function pay(q, { from, to, amount, currencyId, kind, memo, actorId }) {
  if (amount <= 0) return;
  const crown = await isCrown(q, to);
  await move(q, { from, to: crown ? null : to, currencyId, amount, kind, memo, actorId });
}

/** A buyer (user or company owner object with label) buys a listed building. */
export async function buyListing(q, { l, buyer, me }) {
  if (l.status !== 'active' || l.kind !== 'sale') throw new HttpError(400, 'That building is no longer for sale.');
  const b = await loadBuilding(q, l.building_id, { lock: true });
  if (b.owner_type !== l.seller_type || b.owner_id !== l.seller_id) throw new HttpError(400, 'The seller no longer owns that building.');
  if (buyer.type === b.owner_type && buyer.id === b.owner_id) throw new HttpError(400, 'You already own it.');
  const price = Number(l.price_minor);
  if (price > 0 && (await balanceOf(q, buyer, l.currency_id)) < price) throw new HttpError(400, `${buyer.label} can't afford it.`);
  const seller = { type: b.owner_type, id: b.owner_id, label: await ownerName(q, b.owner_type, b.owner_id) };
  await pay(q, { from: buyer, to: seller, amount: price, currencyId: l.currency_id, kind: 'property', memo: `Bought ${b.name}`, actorId: me?.id ?? null });
  await transferBuilding(q, b, buyer, { listingStatus: 'sold' });
  await q`update property_listings set buyer_type = ${buyer.type}, buyer_id = ${buyer.id} where id = ${l.id}`;
  return b;
}

/** A tenant takes a building on lease. The first rent is charged at the next advance. */
export async function leaseListing(q, { l, tenant }) {
  if (l.status !== 'active' || l.kind !== 'lease') throw new HttpError(400, 'That building is no longer for rent.');
  const b = await loadBuilding(q, l.building_id, { lock: true });
  if (b.owner_type !== l.seller_type || b.owner_id !== l.seller_id) throw new HttpError(400, 'The landlord no longer owns that building.');
  if (tenant.type === b.owner_type && tenant.id === b.owner_id) throw new HttpError(400, 'You own it already.');
  if (await activeLease(q, b)) throw new HttpError(400, 'It is already leased.');
  const problem = await contentsProblem(q, b);
  if (problem) throw new HttpError(400, `The landlord must clear it first: ${problem}`);
  const rent = Number(l.price_minor);
  if (rent > 0 && (await balanceOf(q, tenant, l.currency_id)) <= 0) throw new HttpError(400, `${tenant.label} has no money to pay rent with.`);
  const day = await currentDay(q);
  const sessionDays = Number(await getSetting('session_days', 90, q));
  const end = l.term_sessions ? day + Math.max(1, Math.round(Number(l.term_sessions) * sessionDays)) : null;
  const [lease] = await q`
    insert into leases (building_id, listing_id, landlord_type, landlord_id, tenant_type, tenant_id, rent_minor, currency_id, start_day, end_day)
    values (${b.id}, ${l.id}, ${b.owner_type}, ${b.owner_id}, ${tenant.type}, ${tenant.id}, ${rent}, ${l.currency_id}, ${day}, ${end})
    returning *`;
  await q`update property_listings set status = 'leased', closed_day = ${day}, buyer_type = ${tenant.type}, buyer_id = ${tenant.id} where id = ${l.id}`;
  await setOperator(q, b, tenant);
  return lease;
}

/**
 * Ends a lease. who: 'tenant' (stores must be empty), 'landlord' (at-will leases only), 'gm',
 * 'unpaid', 'expired'. Anything left in the store stays with the building (the landlord's).
 */
export async function endLease(q, lease, who) {
  if (lease.status !== 'active') throw new HttpError(400, 'That lease has already ended.');
  const b = await loadBuilding(q, lease.building_id, { lock: true });
  if (who === 'tenant') {
    const problem = await contentsProblem(q, b);
    if (problem) throw new HttpError(400, `Clear the building before you leave: ${problem}`);
  }
  if (who === 'landlord' && lease.end_day != null) throw new HttpError(400, 'This lease has a fixed term. It ends on its own (or the GM can end it).');
  const landlord = { type: b.owner_type, id: b.owner_id };
  const tenant = { type: lease.tenant_type, id: lease.tenant_id };
  const reason = { tenant: 'tenant moved out', landlord: 'landlord ended the lease', gm: 'ended by the GM', unpaid: 'rent unpaid', expired: 'lease term ended' }[who] ?? who;
  const left = who === 'tenant' ? 0 : await forfeitContents(q, b, tenant, landlord, reason);
  const day = await currentDay(q);
  await q`update leases set status = 'ended', ended_day = ${day}, end_reason = ${reason} where id = ${lease.id}`;
  await setOperator(q, b, landlord);
  return { building: b, left, reason };
}

/** Tick: collect rent for the days that passed; end leases that can't be paid or whose term is up. */
export async function collectRent(q, { fromDay, toDay }) {
  const days = toDay - fromDay;
  if (days <= 0) return [];
  const leases = await q`select * from leases where status = 'active' order by id for update`;
  if (!leases.length) return [];
  const sessionDays = Number(await getSetting('session_days', 90, q));
  const lines = [];
  let collected = 0;
  for (const l of leases) {
    // Rent runs until the end of the term (if the term ends inside this advance).
    const until = l.end_day != null ? Math.min(toDay, l.end_day) : toDay;
    const span = Math.max(0, until - Math.max(fromDay, l.start_day));
    const exact = (Number(l.rent_minor) * span) / sessionDays + Number(l.unpaid_frac);
    const owed = Math.floor(exact + 1e-9);
    const tenant = { type: l.tenant_type, id: l.tenant_id, label: await ownerName(q, l.tenant_type, l.tenant_id) };
    const landlord = { type: l.landlord_type, id: l.landlord_id, label: await ownerName(q, l.landlord_type, l.landlord_id) };
    const [b] = await q`select name from buildings where id = ${l.building_id}`;
    if (owed > 0) {
      const balance = await balanceOf(q, tenant, l.currency_id);
      if (balance < owed) {
        if (balance > 0) await pay(q, { from: tenant, to: landlord, amount: balance, currencyId: l.currency_id, kind: 'rent', memo: `Part rent: ${b.name}` });
        const r = await endLease(q, l, 'unpaid');
        lines.push(`${tenant.label} couldn't pay the rent on ${b.name} — evicted${r.left ? ` (${r.left.toLocaleString()} units left behind)` : ''}.`);
        continue;
      }
      await pay(q, { from: tenant, to: landlord, amount: owed, currencyId: l.currency_id, kind: 'rent', memo: `Rent: ${b.name}` });
      collected += owed;
    }
    await q`update leases set unpaid_frac = ${(exact - owed).toFixed(6)}, paid_total = paid_total + ${owed} where id = ${l.id}`;
    if (l.end_day != null && l.end_day <= toDay) {
      const r = await endLease(q, { ...l, status: 'active' }, 'expired');
      lines.push(`The lease on ${b.name} ended${r.left ? ` (${r.left.toLocaleString()} units left behind for the landlord)` : ''}.`);
    }
  }
  const head = `Real estate: ${leases.length} lease${leases.length === 1 ? '' : 's'}${collected ? ', rent collected' : ''}.`;
  return [head, ...lines.slice(0, 8)];
}

export async function ownerName(q, type, id) {
  const [r] = type === 'user' ? await q`select rp_name as n from users where id = ${id}` : await q`select name as n from companies where id = ${id}`;
  return r?.n ?? '?';
}

/* ── Views ── */

/** Buildings as API objects. filter: { ids?, owners? [{type,id}], all? } */
export async function buildingViews(q, { owners = null, ids = null } = {}) {
  const types = owners?.map((o) => o.type) ?? null;
  const oids = owners?.map((o) => o.id) ?? null;
  const rows = await q`
    select b.*, s.name as town, coalesce(c.name, u.rp_name) as owner_name, c.kind as owner_kind,
           w.size, w.req_general, w.req_skilled, w.req_specialist, w.production_mode, w.base_output, w.active as wp_active,
           coalesce(n.name, r.name) as source_name,
           (select coalesce(sum(e.count), 0)::int from employment e where e.workplace_id = b.workplace_id) as workers,
           sp.name as store_name, sp.capacity as store_capacity, sp.kind as store_kind,
           (select coalesce(sum(k.qty), 0)::bigint from stock k where k.stockpile_id = b.stockpile_id) as store_used,
           bp.name as blueprint_name, cp.name as project_name
    from buildings b
    join settlements s on s.id = b.settlement_id
    left join companies c on b.owner_type = 'company' and c.id = b.owner_id
    left join users u on b.owner_type = 'user' and u.id = b.owner_id
    left join workplaces w on w.id = b.workplace_id
    left join resource_nodes n on n.id = w.node_id
    left join recipes r on r.id = w.recipe_id
    left join stockpiles sp on sp.id = b.stockpile_id
    left join blueprints bp on bp.id = b.blueprint_id
    left join construction_projects cp on cp.id = b.project_id
    where (${ids}::int[] is null or b.id = any(${ids}::int[]))
      and (${types}::text[] is null or (b.owner_type, b.owner_id) in (select * from unnest(${types}::text[], ${oids}::int[]))
           or b.id in (select building_id from leases where status = 'active'
                       and (tenant_type, tenant_id) in (select * from unnest(${types}::text[], ${oids}::int[]))))
    order by s.name, b.name`;
  if (!rows.length) return [];
  const bIds = rows.map((r) => r.id);
  const [listings, leases] = await Promise.all([
    q`select * from property_listings where building_id = any(${bIds}::int[]) and status = 'active'`,
    q`select l.*, coalesce(c.name, u.rp_name) as tenant_name from leases l
      left join companies c on l.tenant_type = 'company' and c.id = l.tenant_id
      left join users u on l.tenant_type = 'user' and u.id = l.tenant_id
      where l.building_id = any(${bIds}::int[]) and l.status = 'active'`,
  ]);
  return rows.map((b) => {
    const l = listings.find((x) => x.building_id === b.id);
    const le = leases.find((x) => x.building_id === b.id);
    return {
      id: b.id, name: b.name, kind: b.kind, kindLabel: KIND_LABEL[b.kind], settlementId: b.settlement_id, town: b.town,
      ownerType: b.owner_type, ownerId: b.owner_id, ownerName: b.owner_name, crown: b.owner_kind === 'crown',
      active: b.active, origin: b.origin, builtDay: b.built_day, blueprintName: b.blueprint_name, projectName: b.project_name, description: b.description,
      workplaceId: b.workplace_id, stockpileId: b.stockpile_id,
      workplace: b.workplace_id ? {
        size: b.size, required: { general: b.req_general, skilled: b.req_skilled, specialist: b.req_specialist },
        mode: b.production_mode, source: b.source_name, baseOutput: Number(b.base_output ?? 0), workers: b.workers, active: b.wp_active,
      } : null,
      store: b.stockpile_id ? { name: b.store_name, capacity: b.store_capacity == null ? null : Number(b.store_capacity), used: Number(b.store_used), kind: b.store_kind } : null,
      listing: l ? listingView(l) : null,
      lease: le ? leaseView(le) : null,
    };
  });
}

export const listingView = (l) => ({
  id: l.id, buildingId: l.building_id, kind: l.kind, price: Number(l.price_minor), currencyId: l.currency_id,
  termSessions: l.term_sessions == null ? null : Number(l.term_sessions), note: l.note, status: l.status,
  sellerType: l.seller_type, sellerId: l.seller_id, createdDay: l.created_day, closedDay: l.closed_day,
});
export const leaseView = (l) => ({
  id: l.id, buildingId: l.building_id, landlordType: l.landlord_type, landlordId: l.landlord_id,
  tenantType: l.tenant_type, tenantId: l.tenant_id, tenantName: l.tenant_name ?? null,
  rent: Number(l.rent_minor), currencyId: l.currency_id, startDay: l.start_day, endDay: l.end_day,
  status: l.status, endedDay: l.ended_day, endReason: l.end_reason, paidTotal: Number(l.paid_total),
});
