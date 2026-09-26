// /api/realestate — the property market, and your buildings.
//   GET  — buildings for sale or rent, the buildings you (or your companies) own or rent, who you can act as
//   POST { action: 'list',     buildingId, kind: 'sale'|'lease', price (sub-units; rent per session), currencyId?, termSessions?, note? }
//        { action: 'cancel',   listingId }
//        { action: 'buy',      listingId, as: 'user:ID' | 'company:ID' }
//        { action: 'lease',    listingId, as }
//        { action: 'endLease', leaseId }       tenant moving out (stores empty), or landlord ending an open-ended lease
// You act for yourself and for companies you are an officer or director of.
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { currentDay } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import { canActFor } from '../lib/transport.js';
import {
  buildingViews, buyListing, cleanListing, createListing, endLease, leaseListing, loadBuilding, loadListing, ownerName,
} from '../lib/realestate.js';

async function myOwners(me) {
  const companies = await sql`select c.id, c.name from companies c join company_members m on m.company_id = c.id
                              where m.user_id = ${me.id} and c.active order by lower(c.name)`;
  return [{ type: 'user', id: me.id, name: me.rp_name ?? me.rpName ?? 'You' }, ...companies.map((c) => ({ type: 'company', id: c.id, name: c.name }))];
}

async function actingAs(q, me, key) {
  const [type, idText] = String(key ?? '').split(':');
  const id = Number(idText) || 0;
  if (!['user', 'company'].includes(type) || !(await canActFor(q, me, type, id))) throw new HttpError(403, 'You can only buy or rent for yourself or a company you serve.');
  return { type, id, label: await ownerName(q, type, id) };
}

export default route({
  GET: async (req) => {
    const me = await requireUser(req);
    const owners = await myOwners(me);
    const [currencies, day, forSale] = await Promise.all([
      sql`select * from currencies where active order by is_base desc, sort_order, name`,
      currentDay(sql),
      sql`select building_id from property_listings where status = 'active'`,
    ]);
    const market = forSale.length ? await buildingViews(sql, { ids: forSale.map((r) => r.building_id) }) : [];
    const mine = await buildingViews(sql, { owners });
    const isMine = (t, id) => owners.some((o) => o.type === t && o.id === id);
    return json({
      worldDay: day,
      currencies: currencies.map(publicCurrency),
      owners,
      market: market.filter((b) => b.listing),
      mine: mine.map((b) => ({ ...b, owned: isMine(b.ownerType, b.ownerId), renting: Boolean(b.lease && isMine(b.lease.tenantType, b.lease.tenantId)) })),
    });
  },

  POST: async (req) => {
    const me = await requireUser(req);
    const b = await readJson(req);
    const out = await withTransaction(async (q) => {
      switch (b.action) {
        case 'list': {
          const bld = await loadBuilding(q, b.buildingId, { lock: true });
          if (!(await canActFor(q, me, bld.owner_type, bld.owner_id))) throw new HttpError(403, 'Only its owner can put it on the market.');
          const l = await createListing(q, { b: bld, f: cleanListing(b), me });
          await audit(me.id, 'property.list', { listingId: l.id, buildingId: bld.id }, q);
          return { message: `${bld.name} is on the market.` };
        }
        case 'cancel': {
          const l = await loadListing(q, b.listingId);
          if (l.status !== 'active') throw new HttpError(400, 'That listing is already closed.');
          if (!(await canActFor(q, me, l.seller_type, l.seller_id))) throw new HttpError(403, 'Only the seller can withdraw it.');
          await q`update property_listings set status = 'cancelled', closed_day = ${await currentDay(q)} where id = ${l.id}`;
          return { message: 'Listing withdrawn.' };
        }
        case 'buy': {
          const l = await loadListing(q, b.listingId);
          const buyer = await actingAs(q, me, b.as);
          const bld = await buyListing(q, { l, buyer, me });
          await audit(me.id, 'property.buy', { listingId: l.id, buildingId: bld.id, buyer }, q);
          return { message: `${buyer.label} now owns ${bld.name}.` };
        }
        case 'lease': {
          const l = await loadListing(q, b.listingId);
          const tenant = await actingAs(q, me, b.as);
          const lease = await leaseListing(q, { l, tenant });
          await audit(me.id, 'property.lease', { listingId: l.id, leaseId: lease.id, tenant }, q);
          return { message: `${tenant.label} has taken the lease.` };
        }
        case 'endLease': {
          const [lease] = await q`select * from leases where id = ${Number(b.leaseId) || 0} for update`;
          if (!lease) throw new HttpError(404, 'Lease not found.');
          const asTenant = await canActFor(q, me, lease.tenant_type, lease.tenant_id);
          const asLandlord = !asTenant && (await canActFor(q, me, lease.landlord_type, lease.landlord_id));
          if (!asTenant && !asLandlord) throw new HttpError(403, 'Only the tenant or the landlord can end it.');
          const r = await endLease(q, lease, asTenant ? 'tenant' : 'landlord');
          await audit(me.id, 'property.end_lease', { leaseId: lease.id, as: asTenant ? 'tenant' : 'landlord' }, q);
          return { message: `The lease on ${r.building.name} has ended.${r.left ? ` ${r.left.toLocaleString()} units stayed in the building.` : ''}` };
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json({ ok: true, ...out });
  },
});

export const config = { path: '/api/realestate' };
