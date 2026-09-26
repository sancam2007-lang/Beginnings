// Runs every time the GM advances time, inside the same database transaction
// as the clock change. Each script adds its simulation here:
// Order follows the handbook-alignment review:
//   1 calendar/events (script 11) → NPC companies hire & buy inputs (12) → 2 labor & wages (script 5) → 3 construction (7)
//   → 4 extraction & 5 processing (6) → hauling → 6 shipments arriving (5–10 day shipping)
//   → NPC companies reprice, list, ship (12)
//   → 7 markets (3, 8): NPC demand → players' asks → shelf supply → standing buys → price → noise
//   → 8 taxes/upkeep → 9 valuation (10): book value × confidence → share price → 10 records
//
// Returns short human-readable lines for the GM's time log.
import { seededRandom } from './rng.js';
import { payWages } from './labor.js';
import { runProduction } from './production.js';
import { autoSupply } from './construction.js';
import { tickMarkets } from './npc-market.js';
import { tickShipments } from './transport.js';
import { revalue } from './shares.js';
import { haulAll } from './haul.js';
import { npcPrepare, npcSell } from './npc.js';
import { collectRent } from './realestate.js';

// `seed` makes the run reproducible: same seed + same starting data = same result.
export async function runTick(q, { fromDay, toDay, seed }) {
  const random = seededRandom(seed);
  const summary = [];
  // NPC companies hire and stock their factories first, so new hands are paid for the period they work (script 12).
  summary.push(...(await npcPrepare(q, { fromDay, toDay })));
  summary.push(...(await payWages(q, { fromDay, toDay })));
  summary.push(...(await collectRent(q, { fromDay, toDay }))); // leases: rent, evictions, terms ending
  summary.push(...(await autoSupply(q)));
  summary.push(...(await runProduction(q, { fromDay, toDay })));
  summary.push(...(await haulAll(q)));
  summary.push(...(await tickShipments(q, { toDay })));
  // NPC companies reprice, list and ship what they made or what just arrived (script 12).
  summary.push(...(await npcSell(q, { fromDay, toDay })));
  summary.push(...(await tickMarkets(q, fromDay, toDay, random)));
  summary.push(...(await revalue(q, { fromDay, toDay })));
  return summary;
}
