// /api/gm/construction — GM only. Blueprints and oversight of every project.
//   GET  — all blueprints (incl. inactive), all projects, goods, recipes
//   POST { action: 'saveBlueprint', id?, name, description, resultType: 'workplace'|'stockpile'|'none', resultSpec, milestones, active }
//        { action: 'completeMilestone', projectId }   (GM override: marks the current milestone fully delivered)
//        { action: 'cancel', projectId }
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { cleanText } from '../lib/validate.js';
import { cleanMilestones, cleanResultSpec, lockProject, projectView, settleAndSave } from '../lib/construction.js';
import { SIZES } from '../lib/labor.js';

async function snapshot() {
  const [blueprints, projects, goods, recipes, companies, users, settlements] = await Promise.all([
    sql`select * from blueprints order by lower(name)`,
    sql`select * from construction_projects order by (status = 'active') desc, id desc limit 300`,
    sql`select id, name, unit, category, npc_supply, active from goods order by category, lower(name)`,
    sql`select id, name from recipes where active order by lower(name)`,
    sql`select id, name from companies`,
    sql`select id, rp_name from users`,
    sql`select id, name from settlements`,
  ]);
  const goodsById = new Map(goods.map((g) => [g.id, g]));
  const ownerName = (t, id) => (t === 'company' ? companies.find((c) => c.id === id)?.name : users.find((u) => u.id === id)?.rp_name) ?? '?';
  return {
    blueprints: blueprints.map((b) => ({
      id: b.id, name: b.name, description: b.description, resultType: b.result_type, resultSpec: b.result_spec,
      milestones: b.milestones, active: b.active,
      inUse: projects.filter((p) => p.blueprint_id === b.id && p.status === 'active').length,
    })),
    projects: projects.map((p) => projectView(p, goodsById, {
      ownerName: ownerName(p.owner_type, p.owner_id), settlementName: settlements.find((s) => s.id === p.settlement_id)?.name ?? '?',
    })),
    goods: goods.map((g) => ({ id: g.id, name: g.name, unit: g.unit, category: g.category, playerMade: g.npc_supply === false, active: g.active })),
    recipes,
    sizes: Object.entries(SIZES).map(([id, s]) => ({ id, ...s })),
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
      switch (b.action) {
        case 'saveBlueprint': {
          const resultType = ['workplace', 'stockpile', 'none'].includes(b.resultType) ? b.resultType : 'none';
          const f = {
            name: cleanText(b.name, 'Blueprint name', 1, 60),
            description: String(b.description ?? '').trim().slice(0, 1000) || null,
            resultType,
            resultSpec: cleanResultSpec(resultType, b.resultSpec ?? {}),
            milestones: cleanMilestones(b.milestones),
            active: b.active !== false,
          };
          const ids = [...new Set(f.milestones.flatMap((m) => m.materials.map((x) => x.goodId)))];
          const found = await q`select id from goods where id = any(${ids}::int[])`;
          if (found.length !== ids.length) throw new HttpError(400, 'One of the materials no longer exists.');
          try {
            if (b.id) {
              const r = await q`update blueprints set name = ${f.name}, description = ${f.description}, result_type = ${f.resultType},
                                  result_spec = ${JSON.stringify(f.resultSpec)}::jsonb, milestones = ${JSON.stringify(f.milestones)}::jsonb,
                                  active = ${f.active} where id = ${Number(b.id)} returning id`;
              if (!r.length) throw new HttpError(404, 'Blueprint not found.');
            } else {
              await q`insert into blueprints (name, description, result_type, result_spec, milestones, active)
                      values (${f.name}, ${f.description}, ${f.resultType}, ${JSON.stringify(f.resultSpec)}::jsonb,
                              ${JSON.stringify(f.milestones)}::jsonb, ${f.active})`;
            }
          } catch (err) {
            if (err.code === '23505') throw new HttpError(409, 'A blueprint with that name already exists.');
            throw err;
          }
          await audit(me.id, 'blueprint.save', { id: b.id ?? null, name: f.name }, q);
          break;
        }
        case 'completeMilestone': {
          const p = await lockProject(q, b.projectId);
          if (p.status !== 'active') throw new HttpError(400, 'That project is not active.');
          const m = p.milestones[p.current];
          m.materials.forEach((x) => { x.delivered = x.qty; });
          await settleAndSave(q, p);
          await audit(me.id, 'construction.gm_complete_milestone', { projectId: p.id, milestone: m.name }, q);
          break;
        }
        case 'cancel': {
          const p = await lockProject(q, b.projectId);
          if (p.status !== 'active') throw new HttpError(400, 'That project is not active.');
          await q`update construction_projects set status = 'cancelled' where id = ${p.id}`;
          await audit(me.id, 'construction.gm_cancel', { projectId: p.id }, q);
          break;
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json(await snapshot());
  },
});

export const config = { path: '/api/gm/construction' };
