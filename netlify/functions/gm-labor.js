// /api/gm/labor — GM only. Labor pools, wage rates, and workplaces.
//   GET  — defaults, weeks per session, every settlement's pool, wage rates, all workplaces
//   POST { action: 'setDefaults', status: {employed, available, unavailable}, tiers: {general, skilled, specialist} }  (percent)
//        { action: 'setWeeksPerSession', weeks }
//        { action: 'setRate', settlementId|null, tier, weeklyWage|null (null = remove), currencyId }
//        { action: 'adjustPool', settlementId, tier, employed, available, unavailable }
//        { action: 'resetPool', settlementId }        (recompute from population; keeps hired workers employed)
//        { action: 'saveWorkplace', id, ownerType, ownerId, name, size, reqGeneral, reqSkilled,   (existing workplaces only —
//                                   they are built through Construction; the settlement never changes)
//                                   reqSpecialist, stockpileId?, notes, active,
//                                   productionMode: 'none'|'extract'|'process', nodeId?, recipeId?, baseOutput, producing }
import { sql, withTransaction, getSetting, setSetting, audit } from '../lib/db.js';
import { syncTitle } from '../lib/realestate.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { cleanText, cleanInt } from '../lib/validate.js';
import { getCurrency } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import {
  TIERS, TIER_LABEL, SIZES, DEFAULT_LABOR, cleanTier, ensurePool, defaultPool, hiredInSettlement,
  workplaceViews, laborMarket, release, resetPoolFromPopulation,
} from '../lib/labor.js';

async function snapshot() {
  const [defaults, weeks, settlements, rates, workplaces, currencies, companies, users, piles] = await Promise.all([
    getSetting('labor_defaults', DEFAULT_LABOR),
    getSetting('weeks_per_session', 13),
    laborMarket(sql),
    sql`select r.*, s.name as settlement_name from wage_rates r left join settlements s on s.id = r.settlement_id
        order by r.settlement_id nulls first, s.name, r.tier`,
    workplaceViews(sql),
    sql`select * from currencies order by is_base desc, sort_order, name`,
    sql`select id, name from companies where active order by lower(name)`,
    sql`select id, rp_name from users where not disabled order by lower(rp_name)`,
    sql`select id, name, owner_type, owner_id, settlement_id from stockpiles where active and kind <> 'personal' order by name`,
  ]);
  const [nodes, recipes] = await Promise.all([
    sql`select id, name, settlement_id from resource_nodes where active order by name`,
    sql`select id, name from recipes where active order by lower(name)`,
  ]);
  return {
    defaults, weeksPerSession: Number(weeks), settlements, workplaces,
    tiers: TIERS.map((t) => ({ id: t, label: TIER_LABEL[t] })),
    sizes: Object.entries(SIZES).map(([id, s]) => ({ id, ...s })),
    rates: rates.map((r) => ({
      id: r.id, settlementId: r.settlement_id, settlementName: r.settlement_name, tier: r.tier,
      weeklyWage: Number(r.weekly_wage_minor), currencyId: r.currency_id,
    })),
    currencies: currencies.map(publicCurrency),
    owners: [
      ...companies.map((c) => ({ type: 'company', id: c.id, name: c.name })),
      ...users.map((u) => ({ type: 'user', id: u.id, name: u.rp_name })),
    ],
    stockpiles: piles.map((p) => ({ id: p.id, name: p.name, ownerType: p.owner_type, ownerId: p.owner_id, settlementId: p.settlement_id })),
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, settlementId: n.settlement_id })),
    recipes: recipes.map((r) => ({ id: r.id, name: r.name })),
  };
}

function pctSet(obj, keys, label) {
  const out = {};
  for (const k of keys) {
    const n = Number(obj?.[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${label}: ${k} must be 0–100%.`);
    out[k] = n;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) throw new HttpError(400, `${label} must add up to 100% (now ${sum}%).`);
  return out;
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
        case 'setDefaults': {
          const value = {
            status: pctSet(b.status, ['employed', 'available', 'unavailable'], 'Employment split'),
            tiers: pctSet(b.tiers, TIERS, 'Skill split'),
          };
          await setSetting('labor_defaults', value, q);
          await audit(me.id, 'labor.defaults', value, q);
          break;
        }
        case 'setWeeksPerSession': {
          const weeks = Number(b.weeks);
          if (!(weeks > 0 && weeks <= 520)) throw new HttpError(400, 'Weeks per session must be between 0 and 520.');
          await setSetting('weeks_per_session', weeks, q);
          await audit(me.id, 'labor.weeks_per_session', { weeks }, q);
          break;
        }
        case 'setRate': {
          const tier = cleanTier(b.tier);
          const sid = Number(b.settlementId) || null;
          if (b.weeklyWage === null || b.weeklyWage === '') {
            await q`delete from wage_rates where tier = ${tier} and coalesce(settlement_id, 0) = ${sid ?? 0}`;
          } else {
            const wage = Number(b.weeklyWage);
            if (!Number.isSafeInteger(wage) || wage < 0) throw new HttpError(400, 'Wage must be a whole number of sub-units, zero or more.');
            const cur = await getCurrency(q, b.currencyId);
            await q`delete from wage_rates where tier = ${tier} and coalesce(settlement_id, 0) = ${sid ?? 0}`;
            await q`insert into wage_rates (settlement_id, tier, weekly_wage_minor, currency_id) values (${sid}, ${tier}, ${wage}, ${cur.id})`;
          }
          await audit(me.id, 'labor.rate', { settlementId: sid, tier, weeklyWage: b.weeklyWage ?? null, currencyId: b.currencyId ?? null }, q);
          break;
        }
        case 'adjustPool': {
          const sid = Number(b.settlementId) || 0;
          const tier = cleanTier(b.tier);
          const f = {
            employed: cleanInt(b.employed, 'Employed', 0, 1e9),
            available: cleanInt(b.available, 'Available', 0, 1e9),
            unavailable: cleanInt(b.unavailable, 'Unavailable', 0, 1e9),
          };
          await ensurePool(q, sid);
          const hired = (await hiredInSettlement(q, sid))[tier];
          if (f.employed < hired) {
            throw new HttpError(400, `${hired} ${TIER_LABEL[tier]} work for player workplaces here — Employed can't be lower. Release them first.`);
          }
          await q`update labor_pools set employed = ${f.employed}, available = ${f.available}, unavailable = ${f.unavailable}
                  where settlement_id = ${sid} and tier = ${tier}`;
          await audit(me.id, 'labor.adjust_pool', { settlementId: sid, tier, ...f }, q);
          break;
        }
        case 'resetPool': {
          const sid = Number(b.settlementId) || 0;
          await resetPoolFromPopulation(q, sid);
          await audit(me.id, 'labor.reset_pool', { settlementId: sid }, q);
          break;
        }
        case 'saveWorkplace': {
          // Workplaces come into being only by construction (a finished project from a workplace blueprint).
          // Here the GM sets one up: owner, name, positions, linked store, production. It can't move towns.
          if (!b.id) throw new HttpError(400, 'New workplaces are built through Construction: start a project from a workplace blueprint. When it finishes, set it up here.');
          const [site] = await q`select settlement_id from workplaces where id = ${Number(b.id) || 0}`;
          if (!site) throw new HttpError(404, 'Workplace not found.');
          const f = {
            ownerType: b.ownerType === 'user' ? 'user' : 'company',
            ownerId: Number(b.ownerId) || 0,
            settlementId: site.settlement_id, // a building stays where it was built
            name: cleanText(b.name, 'Workplace name', 1, 60),
            size: SIZES[b.size] ? b.size : 'small_workshop',
            reqGeneral: cleanInt(b.reqGeneral ?? 0, 'General positions', 0, 100000),
            reqSkilled: cleanInt(b.reqSkilled ?? 0, 'Skilled positions', 0, 100000),
            reqSpecialist: cleanInt(b.reqSpecialist ?? 0, 'Specialist positions', 0, 100000),
            stockpileId: Number(b.stockpileId) || null,
            notes: String(b.notes ?? '').trim().slice(0, 500) || null,
            active: b.active !== false,
            mode: ['none', 'extract', 'process'].includes(b.productionMode) ? b.productionMode : 'none',
            nodeId: Number(b.nodeId) || null,
            recipeId: Number(b.recipeId) || null,
            baseOutput: Number(b.baseOutput ?? 0),
            producing: b.producing !== false,
          };
          if (!(f.baseOutput >= 0 && f.baseOutput <= 1e9)) throw new HttpError(400, 'Base output must be zero or more.');
          if (f.mode === 'extract') {
            const [n] = await q`select settlement_id from resource_nodes where id = ${f.nodeId ?? 0}`;
            if (!n) throw new HttpError(400, 'Choose the resource node this site extracts from.');
            if (n.settlement_id !== f.settlementId) throw new HttpError(400, 'The resource node must be in the same settlement.');
          }
          if (f.mode === 'process') {
            const [r] = await q`select id from recipes where id = ${f.recipeId ?? 0}`;
            if (!r) throw new HttpError(400, 'Choose the recipe this site runs.');
          }
          if (f.mode !== 'none' && !f.stockpileId) throw new HttpError(400, 'A producing workplace needs a linked stockpile for its inputs and outputs.');
          if (f.mode !== 'extract') f.nodeId = null;
          if (f.mode !== 'process') f.recipeId = null;
          const [owner] = f.ownerType === 'user'
            ? await q`select id from users where id = ${f.ownerId}`
            : await q`select id from companies where id = ${f.ownerId}`;
          if (!owner) throw new HttpError(404, 'Owner not found.');
          const [place] = await q`select id from settlements where id = ${f.settlementId}`;
          if (!place) throw new HttpError(400, 'Choose a settlement.');
          if (f.stockpileId) {
            const [p] = await q`select * from stockpiles where id = ${f.stockpileId} for update`;
            if (!p || p.settlement_id !== f.settlementId) throw new HttpError(400, 'The linked stockpile must be in the same settlement.');
            if (p.owner_type !== f.ownerType || p.owner_id !== f.ownerId) {
              // A new owner takes the workplace's own store with it (it was built together with the workplace).
              const [cur] = await q`select owner_type, owner_id, stockpile_id from workplaces where id = ${Number(b.id)}`;
              const ownStore = cur && cur.stockpile_id === p.id && cur.owner_type === p.owner_type && cur.owner_id === p.owner_id;
              if (!ownStore) throw new HttpError(400, `${p.name} belongs to someone else. Link a stockpile the workplace's owner owns.`);
              const [{ used }] = await q`select coalesce(sum(qty), 0)::bigint as used from stock where stockpile_id = ${p.id}`;
              if (Number(used) > 0) throw new HttpError(400, `Empty ${p.name} before assigning the workplace to a new owner (the goods belong to the current owner).`);
              const [order] = await q`select 1 from market_orders where stockpile_id = ${p.id} and status = 'active' limit 1`;
              if (order) throw new HttpError(400, `${p.name} has open market listings or buy orders. Withdraw them first.`);
              await q`update stockpiles set owner_type = ${f.ownerType}, owner_id = ${f.ownerId}, haul_to_id = null where id = ${p.id}`;
              await q`update stockpiles set haul_to_id = null where haul_to_id = ${p.id}`;
            }
          }
          if (b.id) {
            const [old] = await q`select * from workplaces where id = ${Number(b.id)} for update`;
            if (!old) throw new HttpError(404, 'Workplace not found.');
            if (old.owner_type !== f.ownerType || old.owner_id !== f.ownerId) {
              await syncTitle(q, { workplaceId: old.id }, { type: f.ownerType, id: f.ownerId });
            }
            const crews = await q`select * from employment where workplace_id = ${old.id}`;
            if (crews.length && (old.settlement_id !== f.settlementId)) {
              throw new HttpError(400, 'Release its workers before moving a workplace to another settlement.');
            }
            // Closing a workplace sends its workers back to the Available pool.
            if (!f.active && old.active) for (const c of crews) await release(q, c, old.settlement_id, c.count);
            await q`update workplaces set owner_type = ${f.ownerType}, owner_id = ${f.ownerId}, settlement_id = ${f.settlementId},
                      name = ${f.name}, size = ${f.size}, req_general = ${f.reqGeneral}, req_skilled = ${f.reqSkilled},
                      req_specialist = ${f.reqSpecialist}, stockpile_id = ${f.stockpileId}, notes = ${f.notes}, active = ${f.active},
                      production_mode = ${f.mode}, node_id = ${f.nodeId}, recipe_id = ${f.recipeId}, base_output = ${f.baseOutput},
                      producing = ${f.producing},
                      progress = case when production_mode = ${f.mode} and coalesce(node_id, 0) = ${f.nodeId ?? 0}
                                       and coalesce(recipe_id, 0) = ${f.recipeId ?? 0} then progress else 0 end
                    where id = ${old.id}`;
          } else {
            await q`insert into workplaces (owner_type, owner_id, settlement_id, name, size, req_general, req_skilled,
                                            req_specialist, stockpile_id, notes, active, production_mode, node_id, recipe_id,
                                            base_output, producing)
                    values (${f.ownerType}, ${f.ownerId}, ${f.settlementId}, ${f.name}, ${f.size}, ${f.reqGeneral},
                            ${f.reqSkilled}, ${f.reqSpecialist}, ${f.stockpileId}, ${f.notes}, ${f.active}, ${f.mode},
                            ${f.nodeId}, ${f.recipeId}, ${f.baseOutput}, ${f.producing})`;
          }
          await audit(me.id, 'workplace.save', { id: b.id ?? null, ...f }, q);
          break;
        }
        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json(await snapshot());
  },
});

export const config = { path: '/api/gm/labor' };
