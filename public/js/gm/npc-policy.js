// The NPC behaviour form (script 12), shared by the NPCs tab and the profile panel.
import { esc } from '../common.js';

const CHECKS = [
  ['staff', 'Hire workers', 'Fill empty positions from the town at its standard wage.'],
  ['buyInputs', 'Buy inputs', 'Stock its factories from its own depots, then the bulk market.'],
  ['sell', 'Sell output', 'List what it makes on the town’s bulk market and adjust prices.'],
  ['ship', 'Ship to other towns', 'Ship goods with no local market to one of its depots in a town that trades them.'],
];
const NUMS = [
  ['margin', 'Markup on new listings', '%', 'Over the listing’s reference price.'],
  ['floorPct', 'Lowest price', '% of ref.', 'It never asks less than this.'],
  ['ceilPct', 'Highest price', '% of ref.', 'It never asks more than this.'],
  ['stepPct', 'Price step', '%', 'Change at each review: down if nothing sold, up if over half sold.'],
  ['reviewDays', 'Review prices every', 'days', ''],
  ['maxBuyPct', 'Most it pays for inputs', '% of ref.', ''],
  ['wageReserveSessions', 'Keep for wages', 'sessions', 'Cash it won’t spend on inputs or new hires.'],
  ['inputSessions', 'Input stock', 'sessions', 'How much input it keeps on hand.'],
  ['minShipment', 'Smallest shipment', 'units', ''],
  ['shipDays', 'Shipping time', 'days', 'Slower is cheaper. Kept within the GM’s shipping limits (5–10 days by default).'],
];

/** Inner HTML for a <form>: checkboxes then number fields. */
export function policyFields(p) {
  return `<div class="npc-checks">${CHECKS.map(([k, label, help]) => `
      <label class="inline-check" title="${esc(help)}"><input type="checkbox" name="${k}" ${p[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
    <div class="param-grid npc-nums">${NUMS.map(([k, label, unit, help]) => `
      <div><label title="${esc(help)}">${esc(label)} <span class="muted small">(${esc(unit)})</span></label>
        <input type="number" class="small" name="${k}" value="${esc(p[k])}" step="any" min="0"></div>`).join('')}</div>`;
}

/** Reads a form built with policyFields back into a policy object. */
export function readPolicy(form) {
  const p = {};
  for (const [k] of CHECKS) p[k] = form[k].checked;
  for (const [k] of NUMS) p[k] = form[k].value === '' ? undefined : Number(form[k].value);
  return p;
}

/** One-line summary: "Sells at +10% · 60–250% · reviews weekly". */
export function policySummary(p) {
  const off = CHECKS.filter(([k]) => !p[k]).map(([, l]) => l.toLowerCase());
  return `+${p.margin}% markup · ${p.floorPct}–${p.ceilPct}% of ref. · ±${p.stepPct}% every ${p.reviewDays} day${p.reviewDays === 1 ? '' : 's'}`
    + (off.length ? ` · off: ${off.join(', ')}` : '');
}

/** The "what it did last advance" list. */
export function lastActivity(last) {
  if (!last) return '<p class="muted small">Nothing yet — it acts when you advance time.</p>';
  const lines = [...(last.prepare ?? []), ...(last.sell ?? [])];
  return `<ul class="small npc-log">${lines.map((l) => `<li>${esc(l)}</li>`).join('') || '<li class="muted">Nothing to do.</li>'}</ul>`;
}
