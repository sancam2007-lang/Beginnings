// /api/gm/npc — GM only. NPC-run companies (script 12).
//   GET  — every NPC company: policy, what it did last advance, cash, workplaces and staffing, listings
//   POST { action: 'savePolicy', companyId, policy }         — change how one company behaves
//        { action: 'savePolicyAll', policy }                  — apply one policy to every NPC company
//        { action: 'import', rows: [...], dryRun? }           — set up NPC companies from a spreadsheet (all-or-nothing)
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { balancesOf } from '../lib/ledger.js';
import { publicCurrency } from '../lib/currency.js';
import { staffing } from '../lib/labor.js';
import { DEFAULT_POLICY, cleanPolicy, policyOf } from '../lib/npc.js';
import { planNpcImport, applyNpcImport, summarize } from '../lib/npc-import.js';

async function snapshot() {
  const companies = await sql`select c.*, s.name as home_name from companies c left join settlements s on s.id = c.home_settlement_id
                              where c.kind = 'npc' order by c.active desc, lower(c.name)`;
  const ids = companies.map((c) => c.id);
  const [sites, crews, asks] = ids.length ? await Promise.all([
    sql`select w.*, s.name as town, coalesce(n.name, r.name) as source_name from workplaces w
        join settlements s on s.id = w.settlement_id
        left join resource_nodes n on n.id = w.node_id left join recipes r on r.id = w.recipe_id
        where w.owner_type = 'company' and w.owner_id = any(${ids}::int[]) and w.active order by w.name`,
    sql`select e.workplace_id, e.position_tier, e.count from employment e join workplaces w on w.id = e.workplace_id
        where w.owner_type = 'company' and w.owner_id = any(${ids}::int[])`,
    sql`select o.owner_id, count(*)::int as n, coalesce(sum(o.qty_left), 0)::bigint as units from market_orders o
        where o.owner_type = 'company' and o.owner_id = any(${ids}::int[]) and o.side = 'sell' and o.status = 'active' group by o.owner_id`,
  ]) : [[], [], []];
  const out = [];
  for (const c of companies) {
    const balances = await balancesOf(sql, { type: 'company', id: c.id });
    out.push({
      id: c.id, name: c.name, ticker: c.ticker, active: c.active, home: c.home_name,
      policy: policyOf(c), custom: Boolean(c.npc_policy && Object.keys(c.npc_policy).length), last: c.npc_last ?? null,
      balances,
      listings: { count: asks.find((a) => a.owner_id === c.id)?.n ?? 0, units: Number(asks.find((a) => a.owner_id === c.id)?.units ?? 0) },
      workplaces: sites.filter((w) => w.owner_id === c.id).map((w) => {
        const st = staffing({ general: w.req_general, skilled: w.req_skilled, specialist: w.req_specialist },
          crews.filter((x) => x.workplace_id === w.id).map((x) => ({ positionTier: x.position_tier, count: x.count })));
        return {
          id: w.id, name: w.name, town: w.town, mode: w.production_mode, source: w.source_name,
          required: st.required, staffed: Object.values(st.tiers).reduce((s, t) => s + Math.min(t.filled, t.required), 0),
          band: st.output, last: w.last_output ?? null,
        };
      }),
    });
  }
  const currencies = await sql`select * from currencies order by is_base desc, sort_order, name`;
  return { companies: out, defaults: DEFAULT_POLICY, currencies: currencies.map(publicCurrency) };
}

export default route({
  GET: async (req) => {
    await requireGM(req);
    return json(await snapshot());
  },

  POST: async (req) => {
    const me = await requireGM(req);
    const b = await readJson(req);
    switch (b.action) {
      case 'savePolicy': {
        const policy = cleanPolicy(b.policy);
        await withTransaction(async (q) => {
          const [c] = await q`select id, kind from companies where id = ${Number(b.companyId) || 0} for update`;
          if (!c) throw new HttpError(404, 'Company not found.');
          if (c.kind !== 'npc') throw new HttpError(400, 'Only NPC-run companies follow a policy. Set "Run by" to NPCs first.');
          await q`update companies set npc_policy = ${JSON.stringify(policy)}::jsonb where id = ${c.id}`;
          await audit(me.id, 'npc.policy', { companyId: c.id, policy }, q);
        });
        break;
      }
      case 'savePolicyAll': {
        const policy = cleanPolicy(b.policy);
        await withTransaction(async (q) => {
          const rows = await q`update companies set npc_policy = ${JSON.stringify(policy)}::jsonb where kind = 'npc' returning id`;
          await audit(me.id, 'npc.policy_all', { companies: rows.length, policy }, q);
        });
        break;
      }
      case 'import': {
        const result = await withTransaction(async (q) => {
          const [settlements, nodes, recipes, companies, workplaces, [base]] = await Promise.all([
            q`select id, name from settlements where active`,
            q`select n.id, n.name, n.settlement_id, g.name as good_name from resource_nodes n join goods g on g.id = n.good_id where n.active`,
            q`select id, name from recipes where active`,
            q`select id, name, ticker, kind from companies`,
            q`select id, name, owner_id from workplaces where owner_type = 'company'`,
            q`select id, subunits_per_unit from currencies where is_base`,
          ]);
          const { plan, errors } = planNpcImport(b.rows, { settlements, nodes, recipes, companies, workplaces, base });
          if (errors.length) return { errors };
          if (b.dryRun) return { summary: summarize(plan) };
          const summary = await applyNpcImport(q, plan, me.id);
          await audit(me.id, 'npc.import', { rows: b.rows.length, ...summary }, q);
          return { summary };
        });
        if (result.errors) {
          return json({ error: `${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} found — nothing was imported.`, rowErrors: result.errors.slice(0, 100) }, 400);
        }
        return json({ ...(await snapshot()), imported: result.summary, dryRun: Boolean(b.dryRun) });
      }
      default:
        throw new HttpError(400, 'Unknown action.');
    }
    return json(await snapshot());
  },
});

export const config = { path: '/api/gm/npc' };
