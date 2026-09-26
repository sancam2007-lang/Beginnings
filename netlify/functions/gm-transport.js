// /api/gm/transport — GM only. Shipping between towns.
//   GET  — the shipping rules, every shipment, and the stockpiles a waiting shipment can be redirected to
//   POST { action: 'saveRules', rules: { ratePerUnit, rushPctPerDay, minDays, maxDays } }
//              ratePerUnit: freight per unit for the slowest shipment, base-currency sub-units (decimals allowed)
//        { action: 'arriveNow',  shipmentId }                 deliver now (as much as fits)
//        { action: 'return',     shipmentId }                 send what's still in transit back where it came from
//        { action: 'redirect',   shipmentId, stockpileId }    another depot in the destination town
import { sql, withTransaction, audit, setSetting } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { currentDay } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import { getStockpile } from '../lib/inventory.js';
import { arriveNow, cleanRules, listShipments, loadRules, redirectShipment, returnShipment } from '../lib/transport.js';

async function snapshot() {
  const [rules, [base], day, piles] = await Promise.all([
    loadRules(sql),
    sql`select * from currencies where is_base`,
    currentDay(sql),
    sql`select s.id, s.name, s.settlement_id, coalesce(c.name, u.rp_name) as owner_name from stockpiles s
        left join companies c on s.owner_type = 'company' and c.id = s.owner_id
        left join users u on s.owner_type = 'user' and u.id = s.owner_id
        where s.active and s.kind <> 'personal' order by s.name`,
  ]);
  return {
    rules, currency: publicCurrency(base), worldDay: day,
    shipments: await listShipments(sql, { limit: 300 }),
    stockpiles: piles.map((p) => ({ id: p.id, name: p.name, settlementId: p.settlement_id, ownerName: p.owner_name })),
  };
}

export default route({
  GET: async (req) => {
    await requireGM(req);
    return json(await snapshot());
  },

  POST: async (req) => {
    const me = await requireGM(req);
    const b = await readJson(req);
    await withTransaction(async (q) => {
      if (b.action === 'saveRules') {
        const rules = cleanRules(b.rules ?? {});
        await setSetting('shipping', rules, q);
        await audit(me.id, 'shipping.rules', rules, q);
        return;
      }
      const [s] = await q`select * from shipments where id = ${Number(b.shipmentId) || 0} for update`;
      if (!s) throw new HttpError(404, 'Shipment not found.');
      switch (b.action) {
        case 'arriveNow': await arriveNow(q, s, me.id); break;
        case 'return': await returnShipment(q, s, me.id); break;
        case 'redirect': await redirectShipment(q, s, await getStockpile(q, b.stockpileId), me.id); break;
        default: throw new HttpError(400, 'Unknown action.');
      }
      await audit(me.id, `shipment.${b.action}`, { shipmentId: s.id, stockpileId: b.stockpileId ?? null }, q);
    });
    return json(await snapshot());
  },
});

export const config = { path: '/api/gm/transport' };
