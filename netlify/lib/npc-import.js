// Bulk set-up of NPC companies from a spreadsheet (script 12). One row = one workplace.
// Rows with the same Company name build one company with several workplaces.
//
//   Company, Ticker?, Town, Workplace, Mode (extract|process), Source (node name or recipe name),
//   Output (base output per session), General, Skilled, Specialist, Size?, Store capacity?, Depot?, Cash?
//
// For each workplace it makes a "<Workplace> Store" facility (inputs and outputs live there) and,
// if a Depot is named, a company depot in the same town that the store auto-hauls its outputs to.
// Cash is whole units of the base currency, granted once to a NEW company (the GM's starting capital).
// All-or-nothing: any problem → nothing is imported.
import { SIZES } from './labor.js';
import { loadRules } from './shares.js';
import { currentDay, move } from './ledger.js';
import { registerBuilding } from './realestate.js';

export const IMPORT_ALIASES = {
  company: ['company', 'companyname', 'owner', 'npccompany', 'business'],
  ticker: ['ticker', 'symbol', 'code'],
  town: ['town', 'settlement', 'city', 'place', 'location'],
  workplace: ['workplace', 'site', 'building', 'workplacename', 'facility'],
  mode: ['mode', 'type', 'productionmode', 'kind'],
  source: ['source', 'node', 'recipe', 'resourcenode', 'noderecipe', 'noderorrecipe', 'nodeorrecipe', 'extracts', 'makes'],
  output: ['output', 'baseoutput', 'batches', 'rate', 'outputpersession'],
  general: ['general', 'generallabor', 'laborers', 'labourers', 'reqgeneral'],
  skilled: ['skilled', 'skilledlabor', 'reqskilled'],
  specialist: ['specialist', 'specialists', 'reqspecialist'],
  size: ['size', 'workplacesize'],
  capacity: ['capacity', 'storecapacity', 'storage', 'store'],
  depot: ['depot', 'depotname', 'warehouse'],
  cash: ['cash', 'startingcash', 'capital', 'funds', 'treasury'],
};

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lc = (s) => String(s ?? '').trim().toLowerCase();

function sizeKey(v) {
  const s = squash(v);
  if (!s) return 'small_workshop';
  return Object.keys(SIZES).find((k) => squash(k) === s || squash(SIZES[k].label) === s) ?? null;
}

function tickerFrom(name, taken) {
  const letters = String(name).toUpperCase().replace(/[^A-Z]/g, '');
  const base = (letters || 'NPC').slice(0, 4).padEnd(2, 'X');
  let t = base;
  for (let i = 2; taken.has(t); i++) t = `${base.slice(0, 4)}${i}`.slice(0, 6);
  taken.add(t);
  return t;
}

/**
 * Checks every row against the world. lookups: { settlements, nodes, recipes, companies, workplaces, stockpiles, base }
 * Returns { plan, errors }.
 */
export function planNpcImport(rows, lookups) {
  const errors = [];
  if (!Array.isArray(rows) || !rows.length) return { plan: null, errors: ['Nothing to import.'] };
  if (rows.length > 500) return { plan: null, errors: ['At most 500 rows at a time.'] };
  const takenTickers = new Set(lookups.companies.map((c) => c.ticker.toUpperCase()));
  const companies = new Map(); // lower name → { name, ticker, existing, home, cash, workplaces: [] }
  const seenSites = new Set();

  rows.forEach((r, i) => {
    const line = i + 2;
    const err = (m) => errors.push(`Row ${line}: ${m}`);
    const name = String(r.company ?? '').trim();
    if (!name) return err('Company is empty.');
    if (name.length > 80) return err('Company name is too long.');
    const town = lookups.settlements.find((s) => lc(s.name) === lc(r.town));
    if (!town) return err(`Town "${r.town ?? ''}" not found.`);
    const site = String(r.workplace ?? '').trim();
    if (!site) return err('Workplace is empty.');
    const mode = lc(r.mode).startsWith('ext') ? 'extract' : lc(r.mode).startsWith('pro') || lc(r.mode).startsWith('man') ? 'process' : null;
    if (!mode) return err('Mode must be extract or process.');
    let nodeId = null;
    let recipeId = null;
    if (mode === 'extract') {
      const node = lookups.nodes.find((n) => lc(n.name) === lc(r.source) && n.settlement_id === town.id)
        ?? lookups.nodes.find((n) => lc(n.good_name) === lc(r.source) && n.settlement_id === town.id);
      if (!node) return err(`No resource node "${r.source ?? ''}" in ${town.name}.`);
      nodeId = node.id;
    } else {
      const recipe = lookups.recipes.find((x) => lc(x.name) === lc(r.source));
      if (!recipe) return err(`Recipe "${r.source ?? ''}" not found.`);
      recipeId = recipe.id;
    }
    const output = Number(String(r.output ?? '').trim() || 0);
    if (!(output > 0 && output <= 1e9)) return err('Output must be a number above 0 (base output per session).');
    const req = {};
    for (const t of ['general', 'skilled', 'specialist']) {
      const v = String(r[t] ?? '').trim();
      const n = v === '' ? 0 : Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return err(`${t} must be a whole number of positions.`);
      req[t] = n;
    }
    if (!req.general && !req.skilled && !req.specialist) return err('Give it at least one position to staff.');
    const size = sizeKey(r.size);
    if (!size) return err(`Size "${r.size}" is not one of ${Object.values(SIZES).map((s) => s.label).join(', ')}.`);
    const capText = String(r.capacity ?? '').trim();
    const capacity = capText === '' ? null : Number(capText);
    if (capacity != null && !(Number.isInteger(capacity) && capacity >= 0)) return err('Store capacity must be a whole number (blank = unlimited).');
    const depot = String(r.depot ?? '').trim() || null;
    const cashText = String(r.cash ?? '').replace(/[, ]/g, '').trim();
    const cash = cashText === '' ? 0 : Number(cashText);
    if (!(cash >= 0 && cash <= 1e12)) return err('Cash must be zero or more.');

    const key = lc(name);
    let c = companies.get(key);
    if (!c) {
      const existing = lookups.companies.find((x) => lc(x.name) === key) ?? null;
      if (existing && existing.kind !== 'npc') return err(`${existing.name} exists and is not run by NPCs.`);
      let ticker = String(r.ticker ?? '').trim().toUpperCase();
      if (existing) ticker = existing.ticker;
      else if (ticker) {
        if (!/^[A-Z][A-Z0-9]{1,5}$/.test(ticker)) return err('Ticker must be 2–6 letters/digits, starting with a letter.');
        if (takenTickers.has(ticker)) return err(`Ticker ${ticker} is already taken.`);
        takenTickers.add(ticker);
      } else ticker = tickerFrom(name, takenTickers);
      c = { name, ticker, existing, home: town.id, cash: 0, workplaces: [] };
      companies.set(key, c);
    }
    c.cash += cash;
    const siteKey = `${key}|${lc(site)}`;
    if (seenSites.has(siteKey)) return err(`${site} is listed twice for ${name}.`);
    seenSites.add(siteKey);
    const exists = c.existing && lookups.workplaces.some((w) => w.owner_id === c.existing.id && lc(w.name) === lc(site));
    c.workplaces.push({ name: site, settlementId: town.id, mode, nodeId, recipeId, output, req, size, capacity, depot, exists });
  });
  return { plan: { companies: [...companies.values()], base: lookups.base }, errors };
}

export function summarize(plan) {
  const cos = plan.companies;
  const sites = cos.flatMap((c) => c.workplaces);
  return {
    companiesCreated: cos.filter((c) => !c.existing).length,
    companiesExisting: cos.filter((c) => c.existing).length,
    workplacesCreated: sites.filter((w) => !w.exists).length,
    workplacesSkipped: sites.filter((w) => w.exists).length,
    depots: new Set(sites.filter((w) => w.depot).map((w) => `${w.settlementId}|${lc(w.depot)}`)).size,
  };
}

export async function applyNpcImport(q, plan, actorId) {
  const day = await currentDay(q);
  const rules = await loadRules(q);
  for (const c of plan.companies) {
    let id = c.existing?.id;
    if (!id) {
      const [row] = await q`insert into companies (name, ticker, home_settlement_id, founded_day, active, shares_total, kind)
                            values (${c.name}, ${c.ticker}, ${c.home}, ${day}, true, ${rules.newCompanyShares}, 'npc') returning id`;
      id = row.id;
      await q`insert into shareholdings (company_id, owner_type, owner_id, qty) values (${id}, 'company', ${id}, ${rules.newCompanyShares})`;
      if (c.cash > 0 && plan.base) {
        await move(q, { from: null, to: { type: 'company', id, label: c.name }, currencyId: plan.base.id,
          amount: Math.round(c.cash * plan.base.subunits_per_unit), kind: 'grant', memo: 'Starting capital (NPC company import)', actorId, day });
      }
    }
    for (const w of c.workplaces.filter((x) => !x.exists)) {
      const [store] = await q`insert into stockpiles (owner_type, owner_id, settlement_id, name, kind, capacity, active)
                              values ('company', ${id}, ${w.settlementId}, ${`${w.name} Store`}, 'facility', ${w.capacity}, true) returning id`;
      if (w.depot) {
        let [dep] = await q`select id from stockpiles where owner_type = 'company' and owner_id = ${id} and settlement_id = ${w.settlementId}
                            and lower(name) = ${lc(w.depot)} and active`;
        if (!dep) {
          [dep] = await q`insert into stockpiles (owner_type, owner_id, settlement_id, name, kind, active)
                          values ('company', ${id}, ${w.settlementId}, ${w.depot}, 'depot', true) returning id`;
          await registerBuilding(q, { name: w.depot, kind: 'storage', settlementId: w.settlementId, owner: { type: 'company', id }, stockpileId: dep.id, origin: 'import' });
        }
        await q`update stockpiles set haul_to_id = ${dep.id} where id = ${store.id}`;
      }
      const [site] = await q`insert into workplaces (owner_type, owner_id, settlement_id, name, size, req_general, req_skilled, req_specialist,
                                      stockpile_id, active, production_mode, node_id, recipe_id, base_output, producing)
              values ('company', ${id}, ${w.settlementId}, ${w.name}, ${w.size}, ${w.req.general}, ${w.req.skilled}, ${w.req.specialist},
                      ${store.id}, true, ${w.mode}, ${w.nodeId}, ${w.recipeId}, ${w.output}, true) returning id`;
      await registerBuilding(q, { name: w.name, kind: 'workplace', settlementId: w.settlementId, owner: { type: 'company', id },
        workplaceId: site.id, stockpileId: store.id, origin: 'import' });
    }
  }
  return summarize(plan);
}
