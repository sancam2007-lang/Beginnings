// NPC-run companies (script 12). Each time the GM advances time, every active company whose
// "Run by" is NPCs looks after itself, using only the same actions a player company has:
//
// BEFORE production (npcPrepare)
//   1. Staff: fill each workplace's required positions from the town's labor pool at the town's
//      standard wage — only as many as the treasury can carry for the policy's wage reserve.
//   2. Stock factories: a processing workplace needs its recipe inputs in its own store. The company
//      first moves them from its other stockpiles in town, then buys the shortfall from the
//      cheapest listings on the town's bulk market (never above the policy's max price), keeping
//      enough cash for wages.
// AFTER production and hauling (npcSell)
//   3. Review its asking prices every `reviewDays`: unsold since the last review → a step cheaper
//      (not below the floor); more than half sold → a step dearer (not above the ceiling).
//   4. List: everything it holds that it doesn't need as its own inputs goes up for sale on a bulk
//      market in the same town that trades that good, at reference price × (1 + margin).
//   5. Ship: goods with no market in their town are shipped (policy's days, 5–10) to one of its depots
//      in a town where a bulk market trades them, if it can pay the freight.
//
// Nothing is created: workers come from the pool, inputs from real listings, outputs from real
// production, and every coin moves through the ledger.
import { getSetting } from './db.js';
import { balanceOf } from './ledger.js';
import { moveItems } from './inventory.js';
import { TIERS, staffing, hire, wageRate, ensurePool } from './labor.js';
import { nodeMultiplier } from './production.js';
import { takeAsks, placeListing, refreshListing } from './bulk-book.js';
import { sendShipment, loadRules as loadShipping, freight } from './transport.js';

export const DEFAULT_POLICY = {
  staff: true, // hire to fill positions
  buyInputs: true, // stock factories from depots and the market
  sell: true, // list output on the bulk market
  ship: true, // send goods with no local market to one that trades them
  margin: 10, // % over the reference price for a new listing
  floorPct: 60, // lowest ask, % of reference
  ceilPct: 250, // highest ask, % of reference
  stepPct: 5, // price change per review
  reviewDays: 7, // how often it reviews its asking prices (days)
  maxBuyPct: 150, // most it pays for inputs, % of reference
  wageReserveSessions: 1, // cash kept back for this many sessions of wages
  inputSessions: 1, // buys inputs for this many sessions of production
  minShipment: 20, // smallest lot worth shipping
  shipDays: 10, // days it pays for (slower = cheaper), kept within the GM's shipping limits
};

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** GM-edited policy → safe policy. */
export function cleanPolicy(b = {}) {
  const d = DEFAULT_POLICY;
  const p = {
    staff: b.staff !== false, buyInputs: b.buyInputs !== false, sell: b.sell !== false, ship: b.ship !== false,
    margin: clampNum(b.margin, -50, 500, d.margin),
    floorPct: clampNum(b.floorPct, 1, 1000, d.floorPct),
    ceilPct: clampNum(b.ceilPct, 1, 5000, d.ceilPct),
    stepPct: clampNum(b.stepPct, 0, 50, d.stepPct),
    reviewDays: Math.round(clampNum(b.reviewDays, 1, 3650, d.reviewDays)),
    maxBuyPct: clampNum(b.maxBuyPct, 1, 5000, d.maxBuyPct),
    wageReserveSessions: clampNum(b.wageReserveSessions, 0, 20, d.wageReserveSessions),
    inputSessions: clampNum(b.inputSessions, 0.1, 10, d.inputSessions),
    minShipment: Math.round(clampNum(b.minShipment, 1, 1e9, d.minShipment)),
    shipDays: Math.round(clampNum(b.shipDays, 1, 365, d.shipDays)),
  };
  if (p.floorPct > p.ceilPct) [p.floorPct, p.ceilPct] = [p.ceilPct, p.floorPct];
  return p;
}
export const policyOf = (c) => ({ ...DEFAULT_POLICY, ...(c.npc_policy ?? {}) });

async function npcCompanies(q) {
  return q`select * from companies where kind = 'npc' and active order by id`;
}

/** Everything a company owns, loaded once per step. */
async function companyState(q, c) {
  const [workplaces, crews, piles, stock] = await Promise.all([
    q`select * from workplaces where owner_type = 'company' and owner_id = ${c.id} and active order by id`,
    q`select e.* from employment e join workplaces w on w.id = e.workplace_id where w.owner_type = 'company' and w.owner_id = ${c.id}`,
    q`select s.*, ${c.name}::text as owner_name from stockpiles s where s.owner_type = 'company' and s.owner_id = ${c.id} and s.active and s.kind <> 'personal' order by s.id`,
    q`select k.stockpile_id, k.good_id, k.qty, g.name from stock k join goods g on g.id = k.good_id
      join stockpiles s on s.id = k.stockpile_id where s.owner_type = 'company' and s.owner_id = ${c.id} and s.active and k.qty > 0`,
  ]);
  const recipeIds = [...new Set(workplaces.filter((w) => w.production_mode === 'process' && w.recipe_id).map((w) => w.recipe_id))];
  const items = recipeIds.length ? await q`select ri.*, g.name from recipe_items ri join goods g on g.id = ri.good_id where ri.recipe_id = any(${recipeIds}::int[])` : [];
  return { workplaces, crews, piles, stock, items };
}

/** Wage bill of the company's current crews for `sessions` sessions, by currency. */
function wageBill(crews, weeksPerSession, sessions) {
  const bill = new Map();
  for (const cr of crews) bill.set(cr.currency_id, (bill.get(cr.currency_id) ?? 0) + Number(cr.weekly_wage_minor) * cr.count * weeksPerSession * sessions);
  return bill;
}

/* ── Before production ─────────────────────────────────────────── */

export async function npcPrepare(q, { fromDay, toDay }) {
  const companies = await npcCompanies(q);
  if (!companies.length) return [];
  const days = toDay - fromDay;
  const weeksPerSession = Number(await getSetting('weeks_per_session', 13, q));
  const sessionDays = Number(await getSetting('session_days', 90, q));
  const totals = { hired: 0, inputs: 0, spent: 0 };
  for (const c of companies) {
    const policy = policyOf(c);
    const log = [];
    const st = await companyState(q, c);
    // Wages for this advance are paid right after this step, so always keep at least that much.
    const reserveSessions = Math.max(policy.wageReserveSessions, days / sessionDays);

    /* 1. Staffing */
    if (policy.staff) {
      for (const w of st.workplaces) {
        const req = { general: w.req_general, skilled: w.req_skilled, specialist: w.req_specialist };
        for (const tier of ['specialist', 'skilled', 'general']) {
          const filled = st.crews.filter((x) => x.workplace_id === w.id && x.position_tier === tier).reduce((s, x) => s + x.count, 0);
          const need = (Number(req[tier]) || 0) - filled;
          if (need <= 0) continue;
          const rate = await wageRate(q, w.settlement_id, tier);
          if (!rate) { log.push(`${w.name}: no standard ${tier} wage set for this town — can't hire.`); continue; }
          await ensurePool(q, w.settlement_id);
          const [pool] = await q`select available from labor_pools where settlement_id = ${w.settlement_id} and tier = ${tier}`;
          const available = Number(pool?.available ?? 0);
          // Keep enough cash for the whole payroll (after hiring) for the reserve period.
          const bill = wageBill(st.crews, weeksPerSession, reserveSessions).get(rate.currencyId) ?? 0;
          const perHead = rate.weeklyWage * weeksPerSession * reserveSessions;
          const cash = await balanceOf(q, { type: 'company', id: c.id }, rate.currencyId);
          const affordable = perHead > 0 ? Math.floor((cash - bill) / perHead) : need;
          const n = Math.max(0, Math.min(need, available, affordable));
          if (n <= 0) {
            log.push(`${w.name}: ${need} ${tier} short — ${!available ? 'none available in town' : 'treasury too thin to hire'}.`);
            continue;
          }
          await hire(q, { workplace: w, positionTier: tier, workerTier: tier, count: n, weeklyWage: rate.weeklyWage, currencyId: rate.currencyId });
          st.crews.push({ workplace_id: w.id, position_tier: tier, count: n, weekly_wage_minor: rate.weeklyWage, currency_id: rate.currencyId });
          totals.hired += n;
          log.push(`${w.name}: hired ${n} ${tier}${n < need ? ` (${need - n} still short)` : ''}.`);
        }
        if (!w.producing) await q`update workplaces set producing = true where id = ${w.id}`;
      }
    }

    /* 2. Stock the factories */
    if (policy.buyInputs) {
      for (const w of st.workplaces.filter((x) => x.production_mode === 'process' && x.recipe_id && x.stockpile_id)) {
        const store = st.piles.find((p) => p.id === w.stockpile_id);
        if (!store) continue;
        const req = { general: w.req_general, skilled: w.req_skilled, specialist: w.req_specialist };
        const bandNow = staffing(req, st.crews.filter((x) => x.workplace_id === w.id).map((x) => ({ positionTier: x.position_tier, count: x.count }))).output ?? 0;
        if (!bandNow) continue;
        // Enough for the coming advance (at least this one's length) or the policy's sessions, whichever is more.
        const sessions = Math.max(policy.inputSessions, days / sessionDays);
        const batches = Math.ceil(Number(w.base_output) * bandNow * sessions);
        for (const inp of st.items.filter((i) => i.recipe_id === w.recipe_id && i.role === 'in')) {
          const want = inp.qty * batches;
          const have = Number(st.stock.find((k) => k.stockpile_id === store.id && k.good_id === inp.good_id)?.qty ?? 0);
          let short = want - have;
          if (short <= 0) continue;
          const good = { id: inp.good_id, name: inp.name };
          // a) from its own stockpiles in the same town
          for (const k of st.stock.filter((x) => x.good_id === inp.good_id && x.stockpile_id !== store.id)) {
            if (short <= 0) break;
            const from = st.piles.find((p) => p.id === k.stockpile_id);
            if (!from || from.settlement_id !== store.settlement_id) continue;
            if (st.workplaces.some((o) => o.id !== w.id && o.stockpile_id === from.id && o.production_mode === 'process')) continue; // another factory's inputs
            const n = Math.min(short, Number(k.qty));
            await moveItems(q, { from, to: { ...store, capacity: null }, good, qty: n, kind: 'move', memo: `Supplied to ${w.name}` });
            k.qty = Number(k.qty) - n;
            short -= n;
            totals.inputs += n;
            log.push(`${w.name}: moved ${n} ${inp.name} from ${from.name}.`);
          }
          // b) buy the rest on the town's bulk market
          if (short > 0) {
            const markets = await q`
              select m.id, m.name, m.currency_id, m.fee_pct, l.base_price from markets m
              join listings l on l.market_id = m.id and l.good_id = ${inp.good_id} and l.active
              where m.kind = 'bulk' and m.active and m.settlement_id = ${store.settlement_id} order by m.sort_order, m.id`;
            for (const m of markets) {
              if (short <= 0) break;
              const maxPrice = Math.max(1, Math.floor(Number(m.base_price) * policy.maxBuyPct / 100));
              const reserve = wageBill(st.crews, weeksPerSession, reserveSessions).get(m.currency_id) ?? 0;
              const cash = await balanceOf(q, { type: 'company', id: c.id }, m.currency_id);
              const spendable = cash - reserve;
              const qty = Math.min(short, Math.floor(spendable / maxPrice));
              if (qty <= 0) { log.push(`${w.name}: can't afford ${inp.name} (keeping wages in reserve).`); break; }
              const r = await takeAsks(q, { market: m, good, qty, maxPrice, buyer: { kind: 'company', owner: { type: 'company', id: c.id, label: c.name }, pile: store } });
              if (r.filled) {
                short -= r.filled;
                totals.inputs += r.filled;
                totals.spent += r.spent;
                log.push(`${w.name}: bought ${r.filled} ${inp.name} on ${m.name}.`);
              }
            }
            if (short > 0) log.push(`${w.name}: still short of ${short} ${inp.name}.`);
          }
        }
      }
    }
    await q`update companies set npc_last = ${JSON.stringify({ day: toDay, prepare: log })}::jsonb where id = ${c.id}`;
  }
  const parts = [totals.hired && `hired ${totals.hired.toLocaleString()} workers`, totals.inputs && `stocked ${totals.inputs.toLocaleString()} units of inputs`].filter(Boolean);
  return parts.length ? [`NPC companies (${companies.length}): ${parts.join(', ')}.`] : [];
}

/* ── After production ──────────────────────────────────────────── */

export async function npcSell(q, { fromDay, toDay }) {
  const companies = await npcCompanies(q);
  if (!companies.length) return [];
  const npcMe = { id: null };
  const totals = { listed: 0, repriced: 0, shipped: 0 };
  const shipping = await loadShipping(q);
  for (const c of companies) {
    const policy = policyOf(c);
    const [prev] = await q`select npc_last from companies where id = ${c.id}`;
    const log = [];
    const st = await companyState(q, c);
    const ownInputs = new Set(st.items.filter((i) => i.role === 'in').map((i) => i.good_id));

    /* 3. Reprice its own listings */
    if (policy.sell) {
      const asks = await q`select o.*, l.base_price from market_orders o join listings l on l.market_id = o.market_id and l.good_id = o.good_id
                           where o.owner_type = 'company' and o.owner_id = ${c.id} and o.side = 'sell' and o.status = 'active'`;
      for (const a of asks) {
        // Review each listing's price every `reviewDays`: unsold since the last review → cheaper;
        // more than half gone → dearer. Kept between the floor and ceiling (% of the reference price).
        const since = a.repriced_day ?? a.created_day;
        if (toDay - since < policy.reviewDays) continue;
        const ref = Number(a.base_price);
        const soldLately = a.last_fill && Number(a.last_fill.day) >= since;
        const old = Number(a.limit_price);
        let next = old;
        if (!soldLately) next = Math.min(old - 1, Math.floor(old * (1 - policy.stepPct / 100)));
        else if (Number(a.qty_left) < Number(a.qty_total) / 2) next = Math.max(old + 1, Math.ceil(old * (1 + policy.stepPct / 100)));
        if (policy.stepPct === 0) next = old;
        next = Math.max(1, Math.min(Math.round(ref * policy.ceilPct / 100), Math.max(Math.round(ref * policy.floorPct / 100), next)));
        await q`update market_orders set repriced_day = ${toDay} where id = ${a.id}`;
        if (next !== old) {
          await q`update market_orders set limit_price = ${next} where id = ${a.id}`;
          await refreshListing(q, a.market_id, a.good_id);
          totals.repriced += 1;
        }
      }
    }

    /* 4. List what it holds (except its own inputs) where the town's bulk market trades it */
    for (const k of st.stock) {
      if (ownInputs.has(k.good_id) || Number(k.qty) <= 0) continue;
      const pile = st.piles.find((p) => p.id === k.stockpile_id);
      if (!pile) continue;
      const good = { id: k.good_id, name: k.name };
      const [m] = policy.sell ? await q`
        select m.id, m.name, m.currency_id, m.fee_pct, l.base_price from markets m
        join listings l on l.market_id = m.id and l.good_id = ${k.good_id} and l.active
        where m.kind = 'bulk' and m.active and m.settlement_id = ${pile.settlement_id} order by m.sort_order, m.id limit 1` : [];
      if (m) {
        const qty = Number(k.qty);
        const [mine] = await q`select * from market_orders where owner_type = 'company' and owner_id = ${c.id} and market_id = ${m.id}
                               and good_id = ${k.good_id} and side = 'sell' and status = 'active' order by id limit 1 for update`;
        if (mine) {
          // Top up the existing listing rather than scattering many small ones.
          await moveItems(q, { from: pile, to: null, good, qty, kind: 'list', marketId: m.id, unitPrice: Number(mine.limit_price),
            currencyId: m.currency_id, memo: `Listed on ${m.name}` });
          await q`update market_orders set qty_total = qty_total + ${qty}, qty_left = qty_left + ${qty} where id = ${mine.id}`;
          await refreshListing(q, m.id, k.good_id);
        } else {
          const price = Math.max(1, Math.round(Number(m.base_price) * (1 + policy.margin / 100)));
          await placeListing(q, { me: npcMe, market: m, good, pile, qty, price });
        }
        totals.listed += qty;
        log.push(`Listed ${qty} ${k.name} on ${m.name}.`);
        continue;
      }
      /* 5. No market for it here: ship it to one of its depots in a town that trades it */
      if (!policy.ship || Number(k.qty) < policy.minShipment) continue;
      const depots = st.piles.filter((p) => p.active && p.settlement_id !== pile.settlement_id && !st.workplaces.some((w) => w.stockpile_id === p.id));
      for (const depot of depots) {
        const [trades] = await q`select 1 from markets m join listings l on l.market_id = m.id and l.good_id = ${k.good_id} and l.active
                                 where m.kind = 'bulk' and m.active and m.settlement_id = ${depot.settlement_id} limit 1`;
        if (!trades) continue;
        const qty = Number(k.qty);
        const days = Math.min(shipping.maxDays, Math.max(shipping.minDays, policy.shipDays));
        const fee = freight(shipping, qty, days);
        const [base] = await q`select id from currencies where is_base`;
        if (fee > 0 && (await balanceOf(q, { type: 'company', id: c.id }, base.id)) < fee) { log.push(`Can't afford freight for ${qty} ${k.name}.`); break; }
        try {
          await sendShipment(q, { me: npcMe, from: pile, to: depot, cargo: [{ goodId: k.good_id, qty }], days, rules: shipping });
          totals.shipped += qty;
          log.push(`Shipped ${qty} ${k.name} to ${depot.name} (${days} days).`);
        } catch (err) {
          log.push(`Couldn't ship ${k.name}: ${err.message}`);
        }
        break;
      }
    }
    await q`update companies set npc_last = ${JSON.stringify({ ...(prev?.npc_last ?? {}), day: toDay, sell: log })}::jsonb where id = ${c.id}`;
  }
  const parts = [totals.listed && `listed ${totals.listed.toLocaleString()} units`, totals.repriced && `repriced ${totals.repriced} listing${totals.repriced === 1 ? '' : 's'}`,
    totals.shipped && `shipped ${totals.shipped.toLocaleString()} units`].filter(Boolean);
  return parts.length ? [`NPC sales: ${parts.join(', ')}.`] : [];
}

/** Expected production per session for a workplace at full staff (for the GM's overview). */
export function fullOutput(w, node) {
  if (w.production_mode === 'extract' && node) return Number(w.base_output) * nodeMultiplier(node);
  return Number(w.base_output);
}
export { TIERS };
