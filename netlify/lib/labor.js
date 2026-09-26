// The labor core (handbook "Labor Rules", script 5).
//
// Every settlement has a Working Age population split by SKILL TIER
// (General / Skilled / Specialist) and EMPLOYMENT STATUS (Employed / Available / Unavailable).
// Hiring moves workers Available → Employed in their own tier; releasing moves them back.
// Higher-skilled workers may fill lower-tier positions but stay counted in their own tier.
// Counts can never go negative (the database enforces it too).
import { HttpError } from './http.js';
import { getSetting } from './db.js';
import { move, currentDay } from './ledger.js';

export const TIERS = ['general', 'skilled', 'specialist'];
export const TIER_LABEL = { general: 'General Labor', skilled: 'Skilled Labor', specialist: 'Specialists' };
const RANK = { general: 0, skilled: 1, specialist: 2 };
const NOUN = { general: ['general laborer', 'general laborers'], skilled: ['skilled worker', 'skilled workers'], specialist: ['specialist', 'specialists'] };
/** "1 specialist", "20 general laborers" */
export const workers = (n, tier) => `${n.toLocaleString()} ${NOUN[tier][n === 1 ? 0 : 1]}`;

/** Handbook typical workforce sizes (guidance for the GM, not enforced). */
export const SIZES = {
  small_workshop: { label: 'Small Workshop', min: 3, max: 8 },
  large_workshop: { label: 'Large Workshop', min: 8, max: 20 },
  small_facility: { label: 'Small Facility', min: 15, max: 30 },
  medium_facility: { label: 'Medium Facility', min: 30, max: 60 },
  large_facility: { label: 'Large Facility', min: 60, max: 120 },
  major_facility: { label: 'Major Facility', min: 120, max: 250 },
};

export const DEFAULT_LABOR = {
  status: { employed: 75, available: 10, unavailable: 15 },
  tiers: { general: 70, skilled: 25, specialist: 5 },
};

export function cleanTier(v, label = 'Skill tier') {
  if (!TIERS.includes(v)) throw new HttpError(400, `${label} must be general, skilled or specialist.`);
  return v;
}

export const canFill = (workerTier, positionTier) => RANK[workerTier] >= RANK[positionTier];

/** Splits `total` by percentages so the parts are whole numbers that add up exactly (largest remainder). */
export function splitCounts(total, pcts) {
  const keys = Object.keys(pcts);
  const sum = keys.reduce((s, k) => s + Number(pcts[k]), 0) || 1;
  const raw = keys.map((k) => ({ k, v: (total * Number(pcts[k])) / sum }));
  const out = Object.fromEntries(raw.map((r) => [r.k, Math.floor(r.v)]));
  let left = total - Object.values(out).reduce((s, v) => s + v, 0);
  raw.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (const r of raw) { if (left <= 0) break; out[r.k] += 1; left -= 1; }
  return out;
}

/** Default pool for a settlement from its population, working-age % and the labor defaults. */
export function defaultPool(population, workingAgePct, defaults = DEFAULT_LABOR) {
  const workingAge = Math.round((population * Number(workingAgePct)) / 100);
  const byTier = splitCounts(workingAge, defaults.tiers);
  return Object.fromEntries(TIERS.map((t) => [t, splitCounts(byTier[t], defaults.status)]));
}

/** Workers of each tier currently hired by player/company workplaces in a settlement. */
export async function hiredInSettlement(q, settlementId) {
  const rows = await q`select e.worker_tier, coalesce(sum(e.count), 0)::int as n
                       from employment e join workplaces w on w.id = e.workplace_id
                       where w.settlement_id = ${settlementId} group by e.worker_tier`;
  return Object.fromEntries(TIERS.map((t) => [t, rows.find((r) => r.worker_tier === t)?.n ?? 0]));
}

/** Makes sure a settlement has pool rows, creating them from its population the first time. */
export async function ensurePool(q, settlementId) {
  const rows = await q`select * from labor_pools where settlement_id = ${settlementId}`;
  if (rows.length === TIERS.length) return rows;
  const [s] = await q`select population, working_age_pct from settlements where id = ${settlementId}`;
  if (!s) throw new HttpError(404, 'Settlement not found.');
  const pool = defaultPool(s.population, s.working_age_pct, await getSetting('labor_defaults', DEFAULT_LABOR, q));
  for (const t of TIERS) {
    await q`insert into labor_pools (settlement_id, tier, employed, available, unavailable)
            values (${settlementId}, ${t}, ${pool[t].employed}, ${pool[t].available}, ${pool[t].unavailable})
            on conflict (settlement_id, tier) do nothing`;
  }
  return q`select * from labor_pools where settlement_id = ${settlementId}`;
}

/**
 * Recomputes a settlement's pool from its population and the default splits.
 * Workers on player payrolls stay employed (taken from Available, then Unavailable).
 */
export async function resetPoolFromPopulation(q, settlementId) {
  const [s] = await q`select population, working_age_pct from settlements where id = ${settlementId}`;
  if (!s) throw new HttpError(404, 'Settlement not found.');
  await ensurePool(q, settlementId);
  const pool = defaultPool(s.population, s.working_age_pct, await getSetting('labor_defaults', DEFAULT_LABOR, q));
  const hired = await hiredInSettlement(q, settlementId);
  for (const t of TIERS) {
    let { employed, available, unavailable } = pool[t];
    if (employed < hired[t]) {
      const need = hired[t] - employed;
      const fromAvail = Math.min(need, available);
      available -= fromAvail;
      unavailable = Math.max(0, unavailable - (need - fromAvail));
      employed = hired[t];
    }
    await q`update labor_pools set employed = ${employed}, available = ${available}, unavailable = ${unavailable}
            where settlement_id = ${settlementId} and tier = ${t}`;
  }
}

/** Reference weekly wage for a tier in a settlement (settlement override, else global), or null if unset. */
export async function wageRate(q, settlementId, tier) {
  const [r] = await q`select weekly_wage_minor, currency_id from wage_rates
                      where tier = ${tier} and (settlement_id = ${settlementId} or settlement_id is null)
                      order by settlement_id nulls last limit 1`;
  return r ? { weeklyWage: Number(r.weekly_wage_minor), currencyId: r.currency_id } : null;
}

/* ── Staffing bands ─────────────────────────────────────────────── */

/** Handbook bands: 100%+ → 100, 75–99 → 75, 50–74 → 50, 25–49 → 25, below 25 → cannot operate. */
export function band(ratio) {
  if (ratio >= 1) return 1;
  if (ratio >= 0.75) return 0.75;
  if (ratio >= 0.5) return 0.5;
  if (ratio >= 0.25) return 0.25;
  return 0;
}

/**
 * Staffing for a workplace. `req` = { general, skilled, specialist } positions required;
 * `crews` = [{ positionTier, count }]. Output is the band of overall staffing (workers above a
 * tier's requirement don't count), further capped by the Skilled and Specialist bands so a
 * missing engineer can't be replaced by more laborers.
 */
export function staffing(req, crews) {
  const tiers = {};
  let required = 0;
  let counted = 0;
  for (const t of TIERS) {
    const filled = crews.filter((c) => c.positionTier === t).reduce((s, c) => s + c.count, 0);
    const r = Number(req[t]) || 0;
    tiers[t] = { required: r, filled, ratio: r ? filled / r : null };
    required += r;
    counted += Math.min(filled, r);
  }
  if (!required) return { tiers, required: 0, ratio: null, output: null, limitedBy: null };
  const ratio = counted / required;
  let output = band(ratio);
  let limitedBy = output < 1 ? 'overall' : null;
  for (const t of ['skilled', 'specialist']) {
    if (tiers[t].required && band(tiers[t].ratio) < output) {
      output = band(tiers[t].ratio);
      limitedBy = t;
    }
  }
  return { tiers, required, ratio, output, limitedBy };
}

/* ── Hiring & releasing ─────────────────────────────────────────── */

async function lockPoolRow(q, settlementId, tier) {
  await ensurePool(q, settlementId);
  const [row] = await q`select * from labor_pools where settlement_id = ${settlementId} and tier = ${tier} for update`;
  return row;
}

/** Hires `count` workers of `workerTier` into `positionTier` positions at a workplace. */
export async function hire(q, { workplace, positionTier, workerTier, count, weeklyWage, currencyId }) {
  if (!canFill(workerTier, positionTier)) {
    throw new HttpError(400, `${TIER_LABEL[workerTier]} cannot fill ${TIER_LABEL[positionTier]} positions.`);
  }
  const pool = await lockPoolRow(q, workplace.settlement_id, workerTier);
  if (pool.available < count) {
    throw new HttpError(400, `Only ${pool.available.toLocaleString()} ${TIER_LABEL[workerTier]} available in this settlement.`);
  }
  await q`update labor_pools set available = available - ${count}, employed = employed + ${count}
          where settlement_id = ${workplace.settlement_id} and tier = ${workerTier}`;
  // Merge into an identical crew if there is one, so the roster stays tidy.
  const [same] = await q`select id from employment where workplace_id = ${workplace.id} and position_tier = ${positionTier}
                         and worker_tier = ${workerTier} and weekly_wage_minor = ${weeklyWage} and currency_id = ${currencyId}`;
  if (same) {
    await q`update employment set count = count + ${count} where id = ${same.id}`;
    return same.id;
  }
  const [row] = await q`insert into employment (workplace_id, position_tier, worker_tier, count, weekly_wage_minor, currency_id, since_day)
                        values (${workplace.id}, ${positionTier}, ${workerTier}, ${count}, ${weeklyWage}, ${currencyId}, ${await currentDay(q)})
                        returning id`;
  return row.id;
}

/** Lets `count` workers go from a crew (Employed → Available). */
export async function release(q, crew, settlementId, count) {
  const n = Math.min(count, crew.count);
  await lockPoolRow(q, settlementId, crew.worker_tier);
  await q`update labor_pools set employed = employed - ${n}, available = available + ${n}
          where settlement_id = ${settlementId} and tier = ${crew.worker_tier}`;
  if (n >= crew.count) await q`delete from employment where id = ${crew.id}`;
  else await q`update employment set count = count - ${n} where id = ${crew.id}`;
  return n;
}

/* ── Wages (run on every advance) ───────────────────────────────── */

/**
 * Pays every crew for the days that passed. A full session costs weekly wage × weeks_per_session.
 * Fractions of a sub-unit carry over. If an employer can't cover a crew, it pays the workers it
 * can afford and the rest quit (Employed → Available).
 */
export async function payWages(q, { fromDay, toDay }) {
  const days = toDay - fromDay;
  if (days <= 0) return [];
  const weeksPerSession = Number(await getSetting('weeks_per_session', 13, q));
  const sessionDays = Number(await getSetting('session_days', 90, q));
  const weeks = (weeksPerSession * days) / sessionDays;

  const crews = await q`
    select e.*, w.owner_type, w.owner_id, w.settlement_id, w.name as workplace_name,
           coalesce(u.rp_name, c.name) as owner_name, cur.code as currency_code,
           cur.symbol, cur.subunit_symbol, cur.subunits_per_unit
    from employment e
    join workplaces w on w.id = e.workplace_id
    join currencies cur on cur.id = e.currency_id
    left join users u on w.owner_type = 'user' and u.id = w.owner_id
    left join companies c on w.owner_type = 'company' and c.id = w.owner_id
    order by e.id`;

  const paid = new Map();
  const lines = [];
  let quitTotal = 0;
  for (const crew of crews) {
    const perWorker = Number(crew.weekly_wage_minor) * weeks;
    const owedExact = perWorker * crew.count + Number(crew.unpaid_frac);
    const owed = Math.floor(owedExact + 1e-9);
    const payer = { type: crew.owner_type, id: crew.owner_id, label: crew.owner_name };
    const [w] = await q`select balance_minor from wallets where owner_type = ${payer.type} and owner_id = ${payer.id}
                        and currency_id = ${crew.currency_id} for update`;
    const balance = Number(w?.balance_minor ?? 0);

    let keep = crew.count;
    let amount = owed;
    let frac = owedExact - owed;
    if (balance < owed) {
      keep = perWorker > 0 ? Math.min(crew.count, Math.floor(balance / perWorker)) : crew.count;
      amount = Math.min(balance, Math.floor(perWorker * keep));
      frac = 0;
    }
    const memo = `Wages: ${workers(keep, crew.worker_tier)} at ${crew.workplace_name}`;
    if (amount > 0) {
      await move(q, { from: payer, to: null, currencyId: crew.currency_id, amount, kind: 'wages', memo, day: toDay });
      const prev = paid.get(crew.currency_code) ?? { amount: 0, cur: crew };
      prev.amount += amount;
      paid.set(crew.currency_code, prev);
    }
    if (keep < crew.count) {
      const quit = await release(q, crew, crew.settlement_id, crew.count - keep);
      quitTotal += quit;
      lines.push(`${crew.owner_name} couldn't pay ${workers(quit, crew.worker_tier)} at ${crew.workplace_name} — they quit.`);
    } else {
      await q`update employment set unpaid_frac = ${frac.toFixed(6)} where id = ${crew.id}`;
    }
  }
  if (!crews.length) return [];
  const fmt = ({ amount, cur }) => (cur.subunits_per_unit > 1
    ? `${Math.floor(amount / cur.subunits_per_unit).toLocaleString()} ${cur.symbol} ${amount % cur.subunits_per_unit} ${cur.subunit_symbol}`
    : `${amount.toLocaleString()} ${cur.symbol}`);
  const totals = [...paid.values()].map(fmt).join(' + ');
  const head = `Labor: ${crews.reduce((s, c) => s + c.count, 0).toLocaleString()} workers on payroll${totals ? `; wages paid ${totals}` : ''}${quitTotal ? `; ${quitTotal} quit unpaid` : ''}.`;
  return [head, ...lines.slice(0, 8)];
}

/* ── Views ──────────────────────────────────────────────────────── */

/** Workplaces (all, or only those with ids in `ids`) with crews and staffing. */
export async function workplaceViews(q, ids = null) {
  const places = await q`
    select w.*, s.name as settlement_name, coalesce(u.rp_name, c.name) as owner_name,
           (select cp.name from construction_projects cp where cp.status = 'complete'
              and cp.result_ref->>'workplaceId' = w.id::text order by cp.id limit 1) as built_by,
           (select cp.completed_day from construction_projects cp where cp.status = 'complete'
              and cp.result_ref->>'workplaceId' = w.id::text order by cp.id limit 1) as built_day
    from workplaces w
    join settlements s on s.id = w.settlement_id
    left join users u on w.owner_type = 'user' and u.id = w.owner_id
    left join companies c on w.owner_type = 'company' and c.id = w.owner_id
    where (${ids}::int[] is null or w.id = any(${ids}::int[]))
    order by s.name, owner_name, w.name`;
  if (!places.length) return [];
  const crews = await q`select * from employment where workplace_id = any(${places.map((p) => p.id)}::int[]) order by id`;
  const nodeIds = places.map((p) => p.node_id).filter(Boolean);
  const recipeIds = places.map((p) => p.recipe_id).filter(Boolean);
  const [nodes, items, recipes, piles] = await Promise.all([
    nodeIds.length ? q`select n.*, g.name as good_name, g.unit from resource_nodes n join goods g on g.id = n.good_id
                       where n.id = any(${nodeIds}::int[])` : [],
    recipeIds.length ? q`select ri.*, g.name, g.unit from recipe_items ri join goods g on g.id = ri.good_id
                         where ri.recipe_id = any(${recipeIds}::int[]) order by ri.role, g.name` : [],
    recipeIds.length ? q`select * from recipes where id = any(${recipeIds}::int[])` : [],
    q`select id, name from stockpiles where id = any(${places.map((p) => p.stockpile_id).filter(Boolean)}::int[])`,
  ]);
  const { nodeView, recipeView, expectedPerSession } = await import('./production-views.js');
  return places.map((w) => {
    const mine = crews.filter((e) => e.workplace_id === w.id).map((e) => ({
      id: e.id, positionTier: e.position_tier, workerTier: e.worker_tier, count: e.count,
      weeklyWage: Number(e.weekly_wage_minor), currencyId: e.currency_id, sinceDay: e.since_day,
    }));
    const req = { general: w.req_general, skilled: w.req_skilled, specialist: w.req_specialist };
    const st = staffing(req, mine);
    const node = nodes.find((n) => n.id === w.node_id) ?? null;
    const recipe = recipes.find((r) => r.id === w.recipe_id) ?? null;
    const baseOutput = Number(w.base_output);
    return {
      id: w.id, name: w.name, size: w.size, sizeLabel: SIZES[w.size]?.label ?? w.size, notes: w.notes,
      ownerType: w.owner_type, ownerId: w.owner_id, ownerName: w.owner_name,
      settlementId: w.settlement_id, settlementName: w.settlement_name, stockpileId: w.stockpile_id, active: w.active,
      builtBy: w.built_by ?? null, builtDay: w.built_day ?? null,
      required: req, crews: mine, staffing: st,
      stockpileName: piles.find((p) => p.id === w.stockpile_id)?.name ?? null,
      production: {
        mode: w.production_mode, baseOutput, producing: w.producing, progress: Number(w.progress),
        node: node ? nodeView(node) : null,
        recipe: recipe ? recipeView(recipe, items.filter((i) => i.recipe_id === recipe.id)) : null,
        perSession: expectedPerSession({ mode: w.production_mode, baseOutput, band: st.output ?? 0, node }),
        lastOutput: w.last_output ?? null,
      },
    };
  });
}

/** Pools (created on first look) and reference wages for every active settlement. */
export async function laborMarket(q) {
  const settlements = await q`select id, name, population, working_age_pct from settlements where active order by sort_order, lower(name)`;
  for (const s of settlements) await ensurePool(q, s.id);
  const [pools, rates, hired] = await Promise.all([
    q`select * from labor_pools`,
    q`select * from wage_rates`,
    q`select w.settlement_id, e.worker_tier, coalesce(sum(e.count), 0)::int as n
      from employment e join workplaces w on w.id = e.workplace_id group by w.settlement_id, e.worker_tier`,
  ]);
  const rateFor = (sid, t) => {
    const r = rates.find((x) => x.settlement_id === sid && x.tier === t) ?? rates.find((x) => x.settlement_id == null && x.tier === t);
    return r ? { weeklyWage: Number(r.weekly_wage_minor), currencyId: r.currency_id, override: r.settlement_id != null } : null;
  };
  return settlements.map((s) => ({
    id: s.id, name: s.name, population: s.population,
    workingAge: Math.round((s.population * Number(s.working_age_pct)) / 100),
    pool: Object.fromEntries(TIERS.map((t) => {
      const p = pools.find((x) => x.settlement_id === s.id && x.tier === t) ?? {};
      return [t, {
        employed: p.employed ?? 0, available: p.available ?? 0, unavailable: p.unavailable ?? 0,
        hiredByPlayers: hired.find((h) => h.settlement_id === s.id && h.worker_tier === t)?.n ?? 0,
      }];
    })),
    rates: Object.fromEntries(TIERS.map((t) => [t, rateFor(s.id, t)])),
  }));
}
