// /api/construction — building by milestones of materials.
//   GET  — blueprints, every active/finished project, and the stockpiles you could deliver from
//   POST { action: 'start',     blueprintId, settlementId, ownerType: 'user'|'company', ownerId, name }
//        { action: 'deliver',   projectId, stockpileId, goodId, qty }   (anyone may contribute from their own stock)
//        { action: 'setSupply', projectId, stockpileId | null }          (owner: auto-feed from this stockpile each advance)
//        { action: 'cancel',    projectId }                              (owner; delivered materials are not returned)
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { cleanText } from '../lib/validate.js';
import { currentDay } from '../lib/ledger.js';
import {
  getStockpile, requireStockpileAccess, getGood, cleanQty, companyRole, personalStockpile,
} from '../lib/inventory.js';
import { lockProject, deliver, projectView } from '../lib/construction.js';

async function mayManage(q, me, ownerType, ownerId) {
  if (me.role === 'gm') return true;
  if (ownerType === 'user') return ownerId === me.id;
  return Boolean(await companyRole(q, ownerId, me.id));
}

export default route({
  GET: async (req) => {
    const me = await requireUser(req);
    await personalStockpile(sql, me.id);
    const [blueprints, projects, goods, settlements, piles, companies, users, memberships] = await Promise.all([
      sql`select * from blueprints where active order by lower(name)`,
      sql`select * from construction_projects where status <> 'cancelled' order by (status = 'active') desc, id desc limit 200`,
      sql`select id, name, unit, npc_supply from goods`,
      sql`select id, name from settlements where active order by sort_order, lower(name)`,
      sql`select s.id, s.name, s.kind, s.settlement_id, s.owner_type, s.owner_id, c.name as company_name
          from stockpiles s left join companies c on s.owner_type = 'company' and c.id = s.owner_id
          where s.active and ((s.owner_type = 'user' and s.owner_id = ${me.id})
             or (s.owner_type = 'company' and exists (select 1 from company_members m where m.company_id = s.owner_id and m.user_id = ${me.id})))
          order by (s.kind = 'personal') desc, s.name`,
      sql`select id, name from companies`,
      sql`select id, rp_name from users`,
      sql`select c.id, c.name from companies c join company_members m on m.company_id = c.id where m.user_id = ${me.id} and c.active`,
    ]);
    const goodsById = new Map(goods.map((g) => [g.id, g]));
    const ownerName = (t, id) => (t === 'company' ? companies.find((c) => c.id === id)?.name : users.find((u) => u.id === id)?.rp_name) ?? '?';
    const placeName = (id) => settlements.find((s) => s.id === id)?.name ?? '?';
    const myCompanyIds = new Set(memberships.map((m) => m.id));
    const canManage = (p) => me.role === 'gm' || (p.owner_type === 'user' ? p.owner_id === me.id : myCompanyIds.has(p.owner_id));
    const namedMilestones = (ms) => ms.map((m) => ({
      name: m.name,
      materials: m.materials.map((x) => ({
        goodId: x.goodId, qty: x.qty, name: goodsById.get(x.goodId)?.name ?? '?', unit: goodsById.get(x.goodId)?.unit ?? '',
        playerMade: goodsById.get(x.goodId)?.npc_supply === false,
      })),
    }));
    const spec = (type, s) => s;
    return json({
      blueprints: blueprints.map((b) => ({
        id: b.id, name: b.name, description: b.description, resultType: b.result_type, resultSpec: spec(b.result_type, b.result_spec),
        milestones: namedMilestones(b.milestones),
      })),
      projects: projects.map((p) => projectView(p, goodsById, {
        ownerName: ownerName(p.owner_type, p.owner_id), settlementName: placeName(p.settlement_id), canManage: canManage(p),
      })),
      settlements,
      myStockpiles: piles.map((s) => ({
        id: s.id, name: s.kind === 'personal' ? 'Your pack' : `${s.company_name ? `${s.company_name} — ` : 'Your '}${s.name}`,
        settlementId: s.settlement_id, personal: s.kind === 'personal', ownerType: s.owner_type, ownerId: s.owner_id,
      })),
      myCompanies: memberships,
    });
  },

  POST: async (req) => {
    const me = await requireUser(req);
    const b = await readJson(req);
    const result = await withTransaction(async (q) => {
      switch (b.action) {
        case 'start': {
          const [bp] = await q`select * from blueprints where id = ${Number(b.blueprintId) || 0} and active`;
          if (!bp) throw new HttpError(404, 'Blueprint not found.');
          const [place] = await q`select id from settlements where id = ${Number(b.settlementId) || 0} and active`;
          if (!place) throw new HttpError(400, 'Choose a settlement.');
          const ownerType = b.ownerType === 'company' ? 'company' : 'user';
          const ownerId = ownerType === 'user' && !b.ownerId ? me.id : Number(b.ownerId) || 0;
          if (!(await mayManage(q, me, ownerType, ownerId))) throw new HttpError(403, 'You can only build for yourself or a company you serve.');
          const name = cleanText(b.name || bp.name, 'Project name', 1, 60);
          const milestones = bp.milestones.map((m) => ({ name: m.name, materials: m.materials.map((x) => ({ ...x, delivered: 0 })) }));
          const [row] = await q`
            insert into construction_projects (blueprint_id, name, owner_type, owner_id, settlement_id, result_type, result_spec,
                                               milestones, started_day, created_by)
            values (${bp.id}, ${name}, ${ownerType}, ${ownerId}, ${place.id}, ${bp.result_type}, ${JSON.stringify(bp.result_spec)}::jsonb,
                    ${JSON.stringify(milestones)}::jsonb, ${await currentDay(q)}, ${me.id})
            returning id`;
          await audit(me.id, 'construction.start', { projectId: row.id, blueprintId: bp.id, ownerType, ownerId }, q);
          return { projectId: row.id };
        }
        case 'deliver': {
          const p = await lockProject(q, b.projectId);
          const pile = await getStockpile(q, b.stockpileId);
          await requireStockpileAccess(q, me, pile);
          if (pile.kind !== 'personal' && pile.settlement_id !== p.settlement_id) {
            throw new HttpError(400, `${pile.name} isn't in the same settlement as ${p.name}. Ship the materials there first.`);
          }
          const good = await getGood(q, b.goodId, { activeOnly: false });
          const r = await deliver(q, p, pile, good, cleanQty(b.qty, 'Quantity', 1e9), me.id);
          return { delivered: r.used, events: r.lines };
        }
        case 'setSupply': {
          const p = await lockProject(q, b.projectId);
          if (!(await mayManage(q, me, p.owner_type, p.owner_id))) throw new HttpError(403, `You don't manage ${p.name}.`);
          let id = null;
          if (b.stockpileId) {
            const pile = await getStockpile(q, b.stockpileId);
            await requireStockpileAccess(q, me, pile);
            if (pile.kind === 'personal' || pile.settlement_id !== p.settlement_id) {
              throw new HttpError(400, 'Auto-supply needs a warehouse or depot in the same settlement.');
            }
            id = pile.id;
          }
          await q`update construction_projects set supply_stockpile_id = ${id} where id = ${p.id}`;
          return { ok: true };
        }
        case 'cancel': {
          const p = await lockProject(q, b.projectId);
          if (!(await mayManage(q, me, p.owner_type, p.owner_id))) throw new HttpError(403, `You don't manage ${p.name}.`);
          if (p.status !== 'active') throw new HttpError(400, `${p.name} is already ${p.status}.`);
          await q`update construction_projects set status = 'cancelled' where id = ${p.id}`;
          await audit(me.id, 'construction.cancel', { projectId: p.id }, q);
          return { ok: true };
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json({ ok: true, ...result });
  },
});

export const config = { path: '/api/construction' };
