// /api/gm/realestate — GM only. Every building, the property market, and leases.
//   GET  — buildings, listings (open and recent), leases (active and recent), blueprints, settlements, owners, currencies
//   POST { action: 'place',    blueprintId, settlementId, name, ownerType?, ownerId? }  prebuilt from a blueprint (default: Crown property)
//        { action: 'transfer', buildingId, ownerType, ownerId }                        give it to someone (stores must be empty)
//        { action: 'rename',   buildingId, name, description? }
//        { action: 'list',     buildingId, kind, price, currencyId?, termSessions?, note? }   list any building (as its owner)
//        { action: 'cancel',   listingId }
//        { action: 'endLease', leaseId }                                               ends it (anything left stays with the building)
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { cleanText } from '../lib/validate.js';
import { currentDay } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import { placePrebuilt } from '../lib/construction.js';
import {
  buildingViews, cleanListing, createListing, crownId, endLease, leaseView, listingView, loadBuilding, loadListing, transferBuilding,
} from '../lib/realestate.js';

async function snapshot() {
  const [listings, leases, blueprints, settlements, companies, users, currencies, day, crown] = await Promise.all([
    sql`select * from property_listings order by (status = 'active') desc, id desc limit 200`,
    sql`select l.*, coalesce(c.name, u.rp_name) as tenant_name from leases l
        left join companies c on l.tenant_type = 'company' and c.id = l.tenant_id
        left join users u on l.tenant_type = 'user' and u.id = l.tenant_id
        order by (l.status = 'active') desc, l.id desc limit 200`,
    sql`select id, name, result_type, active from blueprints order by lower(name)`,
    sql`select id, name from settlements where active order by lower(name)`,
    sql`select id, name, kind from companies where active and kind <> 'house' order by (kind = 'crown') desc, lower(name)`,
    sql`select id, rp_name from users where not disabled order by lower(rp_name)`,
    sql`select * from currencies where active order by is_base desc, sort_order, name`,
    currentDay(sql),
    crownId(sql),
  ]);
  const names = new Map([...companies.map((c) => [`company:${c.id}`, c.name]), ...users.map((u) => [`user:${u.id}`, u.rp_name])]);
  return {
    worldDay: day,
    crownId: crown,
    buildings: await buildingViews(sql),
    listings: listings.map((l) => ({ ...listingView(l), sellerName: names.get(`${l.seller_type}:${l.seller_id}`) ?? '?',
      buyerName: l.buyer_type ? names.get(`${l.buyer_type}:${l.buyer_id}`) ?? '?' : null })),
    leases: leases.map((l) => ({ ...leaseView(l), landlordName: names.get(`${l.landlord_type}:${l.landlord_id}`) ?? '?' })),
    blueprints: blueprints.map((b) => ({ id: b.id, name: b.name, resultType: b.result_type, active: b.active })),
    settlements,
    owners: [
      ...companies.map((c) => ({ type: 'company', id: c.id, name: c.name, crown: c.kind === 'crown' })),
      ...users.map((u) => ({ type: 'user', id: u.id, name: u.rp_name })),
    ],
    currencies: currencies.map(publicCurrency),
  };
}

async function ownerFrom(q, b, fallbackCrown = true) {
  if (!b.ownerType && fallbackCrown) return { type: 'company', id: await crownId(q) };
  const type = b.ownerType === 'user' ? 'user' : 'company';
  const id = Number(b.ownerId) || 0;
  const [row] = type === 'user' ? await q`select id from users where id = ${id}` : await q`select id from companies where id = ${id} and active`;
  if (!row) throw new HttpError(404, 'Owner not found.');
  return { type, id };
}

export default route({
  GET: async (req) => {
    await requireGM(req);
    return json(await snapshot());
  },

  POST: async (req) => {
    const me = await requireGM(req);
    const b = await readJson(req);
    let message = null;
    await withTransaction(async (q) => {
      switch (b.action) {
        case 'place': {
          const [bp] = await q`select * from blueprints where id = ${Number(b.blueprintId) || 0}`;
          if (!bp) throw new HttpError(404, 'Choose a blueprint.');
          const [place] = await q`select id from settlements where id = ${Number(b.settlementId) || 0}`;
          if (!place) throw new HttpError(400, 'Choose a town.');
          const owner = await ownerFrom(q, b);
          const bld = await placePrebuilt(q, { blueprint: bp, settlementId: place.id, owner, name: cleanText(b.name || bp.name, 'Building name', 1, 60) });
          await audit(me.id, 'building.place', { buildingId: bld.id, blueprintId: bp.id, owner }, q);
          message = `${bld.name} placed.`;
          break;
        }
        case 'transfer': {
          const bld = await loadBuilding(q, b.buildingId, { lock: true });
          const to = await ownerFrom(q, b, false);
          await transferBuilding(q, bld, to);
          await audit(me.id, 'building.transfer', { buildingId: bld.id, to }, q);
          message = `${bld.name} transferred.`;
          break;
        }
        case 'rename': {
          const bld = await loadBuilding(q, b.buildingId, { lock: true });
          const name = cleanText(b.name, 'Building name', 1, 60);
          const description = String(b.description ?? '').trim().slice(0, 500) || null;
          await q`update buildings set name = ${name}, description = ${description} where id = ${bld.id}`;
          message = 'Building saved.';
          break;
        }
        case 'list': {
          const bld = await loadBuilding(q, b.buildingId, { lock: true });
          const l = await createListing(q, { b: bld, f: cleanListing(b), me });
          await audit(me.id, 'property.gm_list', { listingId: l.id, buildingId: bld.id }, q);
          message = `${bld.name} is on the market.`;
          break;
        }
        case 'cancel': {
          const l = await loadListing(q, b.listingId);
          if (l.status !== 'active') throw new HttpError(400, 'That listing is already closed.');
          await q`update property_listings set status = 'cancelled', closed_day = ${await currentDay(q)} where id = ${l.id}`;
          message = 'Listing withdrawn.';
          break;
        }
        case 'endLease': {
          const [lease] = await q`select * from leases where id = ${Number(b.leaseId) || 0} for update`;
          if (!lease) throw new HttpError(404, 'Lease not found.');
          const r = await endLease(q, lease, 'gm');
          await audit(me.id, 'property.gm_end_lease', { leaseId: lease.id }, q);
          message = `Lease on ${r.building.name} ended.${r.left ? ` ${r.left.toLocaleString()} units stayed in the building.` : ''}`;
          break;
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json({ ...(await snapshot()), message });
  },
});

export const config = { path: '/api/gm/realestate' };
