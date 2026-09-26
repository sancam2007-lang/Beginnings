// /api/shipping — send goods from your stockpiles to a depot in another town (5–10 days, your choice).
//   GET  — your stockpiles and what's in them, every depot you can ship to, your shipments, the rules
//   POST { action: 'quote',    units, days }                                  → { fee, arriveDay }
//        { action: 'send',     fromStockpileId, toStockpileId, days, cargo: [{ goodId, qty }] }
//        { action: 'redirect', shipmentId, stockpileId }   a waiting (or not yet arrived) shipment you sent,
//                                                         to another depot in the same destination town
// Senders: yourself, or a company you are an officer/director of (the GM: any company).
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { currentDay } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import { getStockpile } from '../lib/inventory.js';
import { canActFor, cleanDays, freight, listShipments, loadRules, redirectShipment, sendShipment } from '../lib/transport.js';

async function myOwners(me) {
  const companies = me.role === 'gm'
    ? await sql`select id, name from companies where active and kind not in ('house', 'crown') order by lower(name)`
    : await sql`select c.id, c.name from companies c join company_members m on m.company_id = c.id
                where m.user_id = ${me.id} and c.active order by lower(c.name)`;
  return [{ type: 'user', id: me.id, name: me.rpName ?? me.rp_name ?? 'You' }, ...companies.map((c) => ({ type: 'company', id: c.id, name: c.name }))];
}

export default route({
  GET: async (req) => {
    const me = await requireUser(req);
    const owners = await myOwners(me);
    const types = owners.map((o) => o.type);
    const ids = owners.map((o) => o.id);
    const [piles, stock, destinations, rules, [base], day] = await Promise.all([
      sql`select s.id, s.name, s.kind, s.capacity, s.settlement_id, s.owner_type, s.owner_id, st.name as town
          from stockpiles s join settlements st on st.id = s.settlement_id
          where s.active and s.kind <> 'personal'
            and (s.owner_type, s.owner_id) in (select * from unnest(${types}::text[], ${ids}::int[]))
          order by st.name, s.name`,
      sql`select k.stockpile_id, k.good_id, k.qty, g.name, g.unit from stock k join goods g on g.id = k.good_id
          join stockpiles s on s.id = k.stockpile_id
          where k.qty > 0 and s.active and s.kind <> 'personal'
            and (s.owner_type, s.owner_id) in (select * from unnest(${types}::text[], ${ids}::int[]))
          order by g.name`,
      sql`select s.id, s.name, s.kind, s.settlement_id, s.owner_type, s.owner_id, st.name as town,
                 coalesce(c.name, u.rp_name) as owner_name
          from stockpiles s join settlements st on st.id = s.settlement_id
          left join companies c on s.owner_type = 'company' and c.id = s.owner_id
          left join users u on s.owner_type = 'user' and u.id = s.owner_id
          where s.active and s.kind <> 'personal' and (s.owner_type = 'user' or c.active)
          order by st.name, owner_name, s.name`,
      loadRules(sql),
      sql`select * from currencies where is_base`,
      currentDay(sql),
    ]);
    const mine = (s) => owners.find((o) => o.type === s.owner_type && o.id === s.owner_id);
    return json({
      worldDay: day,
      rules,
      currency: publicCurrency(base),
      owners: owners.map((o) => ({ type: o.type, id: o.id, name: o.name })),
      sources: piles.map((s) => ({
        id: s.id, name: s.name, kind: s.kind, settlementId: s.settlement_id, town: s.town,
        ownerType: s.owner_type, ownerId: s.owner_id, ownerName: mine(s)?.name ?? '?',
        goods: stock.filter((k) => k.stockpile_id === s.id).map((k) => ({ goodId: k.good_id, name: k.name, unit: k.unit, qty: Number(k.qty) })),
      })),
      destinations: destinations.map((s) => ({
        id: s.id, name: s.name, kind: s.kind, settlementId: s.settlement_id, town: s.town,
        ownerType: s.owner_type, ownerId: s.owner_id, ownerName: s.owner_name, mine: Boolean(mine(s)),
      })),
      shipments: await listShipments(sql, { owners }),
    });
  },

  POST: async (req) => {
    const me = await requireUser(req);
    const b = await readJson(req);
    if (b.action === 'quote') {
      const rules = await loadRules(sql);
      const days = cleanDays(rules, b.days);
      const units = Math.max(0, Math.floor(Number(b.units) || 0));
      return json({ fee: freight(rules, units, days), arriveDay: (await currentDay(sql)) + days });
    }
    const result = await withTransaction(async (q) => {
      switch (b.action) {
        case 'send': {
          const rules = await loadRules(q);
          const from = await getStockpile(q, b.fromStockpileId);
          if (!from || from.kind === 'personal') throw new HttpError(404, 'Choose a warehouse or depot to ship from.');
          if (!(await canActFor(q, me, from.owner_type, from.owner_id))) throw new HttpError(403, 'You can only ship from your own or your company’s stockpiles.');
          const to = await getStockpile(q, b.toStockpileId);
          if (!to) throw new HttpError(404, 'Choose where to ship to.');
          const r = await sendShipment(q, { me, from, to, cargo: b.cargo, days: b.days, rules });
          await audit(me.id, 'shipment.send', { shipmentId: r.id, from: from.id, to: to.id, days: Number(b.days), fee: r.fee }, q);
          return { sent: r };
        }
        case 'redirect': {
          const [s] = await q`select * from shipments where id = ${Number(b.shipmentId) || 0} for update`;
          if (!s) throw new HttpError(404, 'Shipment not found.');
          if (!(await canActFor(q, me, s.owner_type, s.owner_id))) throw new HttpError(403, 'Only the sender can redirect a shipment.');
          const pile = await getStockpile(q, b.stockpileId);
          const moved = await redirectShipment(q, s, pile, me.id);
          await audit(me.id, 'shipment.redirect', { shipmentId: s.id, to: pile?.id }, q);
          return { moved };
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json({ ok: true, ...result });
  },
});

export const config = { path: '/api/shipping' };
