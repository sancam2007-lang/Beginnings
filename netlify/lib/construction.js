// Construction (script 7): buildings are raised by completing MILESTONES of materials,
// e.g. "Foundations: 1,000 Stone" then "Frame: 1,000 Wood, 200 Iron Nails".
//
// Materials must physically be delivered from a stockpile in the same settlement (or a
// player's pack) and are used up as they go in. A milestone completes when every material
// is fully delivered; the project completes after its last milestone and the building it
// describes (a workplace, a warehouse, or both) comes into being for the owner.
// A project can name a supply stockpile: each time the GM advances time, materials sitting
// there are fed in automatically.
import { registerBuilding } from './realestate.js';
import { HttpError } from './http.js';
import { currentDay } from './ledger.js';
import { moveItems } from './inventory.js';

/** Clean milestones from the GM form. Returns [{ name, materials: [{ goodId, qty }] }]. */
export function cleanMilestones(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'A blueprint needs at least one milestone.');
  if (list.length > 30) throw new HttpError(400, 'At most 30 milestones.');
  return list.map((m, i) => {
    const name = String(m?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || `Milestone ${i + 1}`;
    const seen = new Set();
    const materials = (Array.isArray(m?.materials) ? m.materials : []).filter((x) => x && x.goodId).map((x) => {
      const goodId = Number(x.goodId);
      const qty = Number(x.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 1e9) throw new HttpError(400, `${name}: quantities must be whole numbers from 1.`);
      if (seen.has(goodId)) throw new HttpError(400, `${name}: the same material is listed twice.`);
      seen.add(goodId);
      return { goodId, qty };
    });
    if (!materials.length) throw new HttpError(400, `${name} needs at least one material.`);
    return { name, materials };
  });
}

/** What a finished building becomes. */
export function cleanResultSpec(type, spec = {}) {
  const int = (v, max = 100000) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (type === 'workplace') {
    return {
      size: text(spec.size, 30) || 'small_workshop',
      reqGeneral: int(spec.reqGeneral), reqSkilled: int(spec.reqSkilled), reqSpecialist: int(spec.reqSpecialist),
      recipeId: Number(spec.recipeId) || null,
      baseOutput: Math.max(0, Number(spec.baseOutput) || 0),
      storeCapacity: spec.storeCapacity === '' || spec.storeCapacity == null ? null : int(spec.storeCapacity, 1e12),
      withStore: spec.withStore !== false,
    };
  }
  if (type === 'stockpile') {
    return {
      kind: ['warehouse', 'depot', 'facility', 'other'].includes(spec.kind) ? spec.kind : 'warehouse',
      capacity: spec.capacity === '' || spec.capacity == null ? null : int(spec.capacity, 1e12),
    };
  }
  return {};
}

export const remainingFor = (mat) => Math.max(0, mat.qty - (mat.delivered ?? 0));
const milestoneDone = (m) => m.materials.every((x) => remainingFor(x) === 0);

/** Loads a project row for update, with parsed milestones. */
export async function lockProject(q, id) {
  const [p] = await q`select * from construction_projects where id = ${Number(id) || 0} for update`;
  if (!p) throw new HttpError(404, 'Project not found.');
  return p;
}

async function saveProgress(q, p) {
  await q`update construction_projects set milestones = ${JSON.stringify(p.milestones)}::jsonb, current = ${p.current},
          status = ${p.status}, completed_day = ${p.completed_day ?? null}, result_ref = ${p.result_ref ? JSON.stringify(p.result_ref) : null}::jsonb
          where id = ${p.id}`;
}

/** Creates what the project describes, owned by the project's owner. */
async function build(q, p) {
  const spec = p.result_spec ?? {};
  const ref = {};
  if (p.result_type === 'stockpile' || (p.result_type === 'workplace' && spec.withStore !== false)) {
    const [pile] = await q`
      insert into stockpiles (owner_type, owner_id, settlement_id, name, kind, capacity)
      values (${p.owner_type}, ${p.owner_id}, ${p.settlement_id},
              ${p.result_type === 'workplace' ? `${p.name} Store` : p.name},
              ${p.result_type === 'workplace' ? 'facility' : spec.kind ?? 'warehouse'},
              ${p.result_type === 'workplace' ? spec.storeCapacity ?? null : spec.capacity ?? null})
      returning id`;
    ref.stockpileId = pile.id;
  }
  if (p.result_type === 'workplace') {
    const mode = spec.recipeId ? 'process' : 'none';
    const [w] = await q`
      insert into workplaces (owner_type, owner_id, settlement_id, name, size, req_general, req_skilled, req_specialist,
                              stockpile_id, production_mode, recipe_id, base_output, notes)
      values (${p.owner_type}, ${p.owner_id}, ${p.settlement_id}, ${p.name}, ${spec.size ?? 'small_workshop'},
              ${spec.reqGeneral ?? 0}, ${spec.reqSkilled ?? 0}, ${spec.reqSpecialist ?? 0}, ${ref.stockpileId ?? null},
              ${mode}, ${spec.recipeId ?? null}, ${spec.baseOutput ?? 0}, ${p.id ? `Built by construction project #${p.id}` : 'Placed by the GM'})
      returning id`;
    ref.workplaceId = w.id;
  }
  // Every finished project is a building in the registry (a plain building too).
  const kind = p.result_type === 'workplace' ? 'workplace' : p.result_type === 'stockpile' ? 'storage' : 'building';
  const b = await registerBuilding(q, {
    name: p.name, kind, settlementId: p.settlement_id, owner: { type: p.owner_type, id: p.owner_id },
    workplaceId: ref.workplaceId ?? null, stockpileId: ref.stockpileId ?? null,
    projectId: p.id ?? null, blueprintId: p.blueprint_id ?? null, origin: p.origin ?? 'construction',
  });
  ref.buildingId = b.id;
  return ref;
}

/**
 * GM: places a ready-made building from a blueprint (Crown property by default), without a project.
 * Returns the building row.
 */
export async function placePrebuilt(q, { blueprint, settlementId, owner, name }) {
  const ref = await build(q, {
    id: null, blueprint_id: blueprint.id, name, owner_type: owner.type, owner_id: owner.id, settlement_id: settlementId,
    result_type: blueprint.result_type, result_spec: blueprint.result_spec ?? {}, origin: 'placed',
  });
  const [b] = await q`select * from buildings where id = ${ref.buildingId}`;
  return b;
}

/** Closes finished milestones; finishes and builds the project after the last one. Returns lines. */
async function settle(q, p) {
  const lines = [];
  while (p.status === 'active' && p.current < p.milestones.length && milestoneDone(p.milestones[p.current])) {
    const m = p.milestones[p.current];
    m.completedDay = await currentDay(q);
    lines.push(`${p.name}: "${m.name}" complete.`);
    p.current += 1;
  }
  if (p.status === 'active' && p.current >= p.milestones.length) {
    p.status = 'complete';
    p.completed_day = await currentDay(q);
    p.result_ref = await build(q, p);
    lines.push(`${p.name} is finished!`);
  }
  return lines;
}

/**
 * Delivers up to `qty` of a good from a stockpile into the project's current milestone.
 * Never takes more than the milestone still needs. Returns { used, lines }.
 */
export async function deliver(q, p, pile, good, qty, actorId = null) {
  if (p.status !== 'active') throw new HttpError(400, `${p.name} is ${p.status}.`);
  const m = p.milestones[p.current];
  const mat = m?.materials.find((x) => x.goodId === good.id);
  if (!mat) throw new HttpError(400, `The current milestone ("${m?.name}") doesn't need ${good.name}.`);
  const used = Math.min(qty, remainingFor(mat));
  if (used <= 0) throw new HttpError(400, `"${m.name}" already has all the ${good.name} it needs.`);
  await moveItems(q, { from: pile, good, qty: used, kind: 'construct', memo: `${p.name} — ${m.name}`, actorId, projectId: p.id });
  mat.delivered = (mat.delivered ?? 0) + used;
  const lines = await settle(q, p);
  await saveProgress(q, p);
  return { used, lines };
}

/** Tick: feed every project from its supply stockpile. Returns summary lines. */
export async function autoSupply(q) {
  const projects = await q`select * from construction_projects where status = 'active' and supply_stockpile_id is not null
                           order by id for update`;
  const lines = [];
  for (const p of projects) {
    const [pile] = await q`select * from stockpiles where id = ${p.supply_stockpile_id} and active for update`;
    if (!pile || pile.settlement_id !== p.settlement_id) continue;
    let fed = 0;
    // Keep feeding while milestones keep completing and stock is on hand.
    for (let guard = 0; guard < 50 && p.status === 'active'; guard++) {
      const m = p.milestones[p.current];
      let progressed = false;
      for (const mat of m.materials) {
        const need = remainingFor(mat);
        if (!need) continue;
        const [row] = await q`select k.qty, g.name from stock k join goods g on g.id = k.good_id
                              where k.stockpile_id = ${pile.id} and k.good_id = ${mat.goodId}`;
        const take = Math.min(need, Number(row?.qty ?? 0));
        if (take > 0) {
          await moveItems(q, { from: pile, good: { id: mat.goodId, name: row.name }, qty: take, kind: 'construct', memo: `${p.name} — ${m.name} (auto-supply)`, projectId: p.id });
          mat.delivered = (mat.delivered ?? 0) + take;
          fed += take;
          progressed = true;
        }
      }
      const done = await settle(q, p);
      lines.push(...done);
      if (!done.length || !progressed) break;
    }
    if (fed) {
      await saveProgress(q, p);
      lines.push(`${p.name}: auto-supply delivered ${fed.toLocaleString()} units of material.`);
    }
  }
  return lines;
}

/** Progress summary for the browser. */
export function projectView(p, goodsById, extra = {}) {
  const ms = p.milestones.map((m, i) => ({
    name: m.name,
    completedDay: m.completedDay ?? null,
    state: i < p.current || p.status === 'complete' ? 'done' : i === p.current && p.status === 'active' ? 'current' : 'pending',
    materials: m.materials.map((x) => ({
      goodId: x.goodId, name: goodsById.get(x.goodId)?.name ?? `#${x.goodId}`, unit: goodsById.get(x.goodId)?.unit ?? '',
      qty: x.qty, delivered: x.delivered ?? 0,
    })),
  }));
  const total = ms.reduce((s, m) => s + m.materials.reduce((a, x) => a + x.qty, 0), 0);
  const done = ms.reduce((s, m) => s + m.materials.reduce((a, x) => a + Math.min(x.qty, x.delivered), 0), 0);
  return {
    id: p.id, name: p.name, blueprintId: p.blueprint_id, ownerType: p.owner_type, ownerId: p.owner_id,
    settlementId: p.settlement_id, resultType: p.result_type, resultSpec: p.result_spec, status: p.status,
    current: p.current, milestones: ms, percent: total ? done / total : 0, startedDay: p.started_day,
    completedDay: p.completed_day, supplyStockpileId: p.supply_stockpile_id, resultRef: p.result_ref, ...extra,
  };
}

/** GM override path: after marking materials delivered, close milestones / finish and save. */
export async function settleAndSave(q, p) {
  const lines = await settle(q, p);
  await saveProgress(q, p);
  return lines;
}
