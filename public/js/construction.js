// Construction page: start projects from blueprints, deliver materials, auto-supply.
import { api } from './api.js';
import { requireSession, esc, toast, busy, getClock, confirmBox } from './common.js';
import { formatDay } from './calendar.js';

const $ = (id) => document.getElementById(id);
const me = await requireSession();
let d = null;
let calendar = null;

const RESULT = {
  workplace: (s) => `a workplace${s.reqGeneral || s.reqSkilled || s.reqSpecialist ? ` (needs ${[s.reqGeneral && `${s.reqGeneral} general`, s.reqSkilled && `${s.reqSkilled} skilled`, s.reqSpecialist && `${s.reqSpecialist} specialists`].filter(Boolean).join(', ')})` : ''}${s.withStore !== false ? ` with its own store${s.storeCapacity ? ` (${s.storeCapacity.toLocaleString()} units)` : ''}` : ''}`,
  stockpile: (s) => `a ${s.kind ?? 'warehouse'}${s.capacity ? ` holding ${s.capacity.toLocaleString()} units` : ''}`,
  none: () => 'a building (no workplace or storage)',
};
const materialsText = (m) => m.materials.map((x) => `${x.qty.toLocaleString()} ${esc(x.name)}${x.playerMade ? '<sup title="player-made">†</sup>' : ''}`).join(', ');

/* ── Blueprints & start form ── */
function renderBlueprints() {
  $('bp-list').innerHTML = d.blueprints.map((b) => `
    <div class="pile"><div class="pile-head"><strong>${esc(b.name)}</strong> <span class="muted">→ ${esc(RESULT[b.resultType](b.resultSpec))}</span></div>
      ${b.description ? `<p class="muted" style="margin:.2rem 0">${esc(b.description)}</p>` : ''}
      <ol style="margin:.2rem 0 0;padding-left:1.2rem">${b.milestones.map((m) => `<li><strong>${esc(m.name)}</strong>: ${materialsText(m)}</li>`).join('')}</ol>
    </div>`).join('') + (d.blueprints.some((b) => b.milestones.some((m) => m.materials.some((x) => x.playerMade))) ? '<p class="muted">† player-made: must be processed by players; NPC markets never restock it.</p>' : '')
    || '<p class="muted">The GM hasn\'t published any blueprints yet.</p>';

  $('st-bp').innerHTML = d.blueprints.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('st-place').innerHTML = d.settlements.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('st-owner').innerHTML = `<option value="user:${me.id}">Myself</option>`
    + d.myCompanies.map((c) => `<option value="company:${c.id}">${esc(c.name)}</option>`).join('');
  syncBp();
  $('start-form').querySelector('button').disabled = !d.blueprints.length;
}
function syncBp() {
  const b = d.blueprints.find((x) => x.id === Number($('st-bp').value));
  $('st-bp-desc').innerHTML = b ? `Builds ${esc(RESULT[b.resultType](b.resultSpec))} in ${b.milestones.length} milestone${b.milestones.length === 1 ? '' : 's'}.` : '';
  $('st-name').placeholder = b?.name ?? '';
}
$('st-bp').addEventListener('change', syncBp);

$('start-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const [ownerType, ownerId] = $('st-owner').value.split(':');
  const body = {
    action: 'start', blueprintId: Number($('st-bp').value), settlementId: Number($('st-place').value),
    ownerType, ownerId: Number(ownerId), name: $('st-name').value,
  };
  busy(e.submitter, () => api('construction', { method: 'POST', body }))
    .then(async () => { $('st-name').value = ''; toast('Ground broken! Deliver the first milestone\'s materials.'); await load(); }).catch(() => {});
});

/* ── Projects ── */
function projectCard(p) {
  const piles = d.myStockpiles.filter((s) => s.personal || s.settlementId === p.settlementId);
  const cur = p.milestones[p.current];
  const needed = cur ? cur.materials.filter((x) => x.delivered < x.qty) : [];
  const supplyPiles = d.myStockpiles.filter((s) => !s.personal && s.settlementId === p.settlementId
    && s.ownerType === p.ownerType && s.ownerId === p.ownerId);
  const status = p.status === 'complete'
    ? `<span class="tag base">finished ${esc(formatDay(p.completedDay, calendar, { short: true }))}</span>`
    : `<span class="mono">${Math.floor(p.percent * 100)}%</span>`;

  return `<section class="panel project" data-id="${p.id}" style="margin-bottom:1rem">
    <div class="shop-head">
      <div><h2 style="border:0;margin:0">${esc(p.name)}</h2>
        <p class="muted small">${esc(p.ownerName)} · ${esc(p.settlementName)} · builds ${esc(RESULT[p.resultType](p.resultSpec ?? {}))} · begun ${esc(formatDay(p.startedDay, calendar, { short: true }))}</p></div>
      <div class="shop-purse">${status}</div>
    </div>
    <div class="bar" style="margin:.2rem 0 .8rem"><span style="width:${(p.percent * 100).toFixed(1)}%"></span></div>
    <ol class="milestones">${p.milestones.map((m) => `
      <li class="ms-${m.state}"><strong>${esc(m.name)}</strong>
        ${m.state === 'done' ? '<span class="tag base">done</span>' : m.state === 'current' ? '<span class="tag gm">in progress</span>' : ''}
        <table class="small" style="margin:.2rem 0 .5rem"><tbody>${m.materials.map((x) => `
          <tr><td>${esc(x.name)}</td>
            <td class="num">${x.delivered.toLocaleString()} / ${x.qty.toLocaleString()} ${esc(x.unit)}</td>
            <td style="width:40%"><div class="bar"><span style="width:${Math.min(100, (x.delivered / x.qty) * 100).toFixed(1)}%"></span></div></td></tr>`).join('')}
        </tbody></table></li>`).join('')}</ol>
    ${p.status === 'active' ? `
      <form class="deliver-form row" style="align-items:flex-end;flex-wrap:wrap">
        <div><label>Deliver from</label><select name="pile">${piles.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
          || '<option value="">— nothing of yours here —</option>'}</select></div>
        <div><label>Material</label><select name="good">${needed.map((x) => `<option value="${x.goodId}">${esc(x.name)} (need ${(x.qty - x.delivered).toLocaleString()})</option>`).join('')}</select></div>
        <div style="flex:0 0 7rem"><label>Qty</label><input name="qty" type="number" min="1" value="${needed[0] ? needed[0].qty - needed[0].delivered : 1}"></div>
        <div style="flex:0 0 auto"><button type="submit" ${piles.length && needed.length ? '' : 'disabled'}>Deliver</button></div>
      </form>
      ${p.canManage ? `
        <div class="row tight" style="gap:.6rem;align-items:flex-end;margin-top:.6rem;flex-wrap:wrap">
          <div style="min-width:260px"><label>Auto-supply each advance from</label>
            <select class="supply">${'<option value="">— off —</option>' + supplyPiles.map((s) => `<option value="${s.id}" ${s.id === p.supplyStockpileId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <button type="button" class="ghost small" data-cancel="${p.id}">Cancel project</button>
        </div>` : ''}` : ''}
  </section>`;
}

function renderProjects() {
  const list = d.projects
    .filter((p) => !$('f-mine').checked || p.canManage)
    .filter((p) => $('f-done').checked || p.status === 'active');
  $('projects').innerHTML = list.map(projectCard).join('') || '<p class="muted">No projects under way.</p>';
}
['f-mine', 'f-done'].forEach((id) => $(id).addEventListener('change', renderProjects));

$('projects').addEventListener('submit', (e) => {
  const form = e.target.closest('.deliver-form');
  if (!form) return;
  e.preventDefault();
  const id = Number(form.closest('.project').dataset.id);
  const body = { action: 'deliver', projectId: id, stockpileId: Number(form.pile.value), goodId: Number(form.good.value), qty: Number(form.qty.value) };
  busy(e.submitter, () => api('construction', { method: 'POST', body }))
    .then(async (r) => { toast(r.events?.length ? r.events.join(' ') : `Delivered ${r.delivered.toLocaleString()}.`); await load(); }).catch(() => {});
});

$('projects').addEventListener('change', (e) => {
  if (!e.target.classList.contains('supply')) return;
  const id = Number(e.target.closest('.project').dataset.id);
  busy(null, () => api('construction', { method: 'POST', body: { action: 'setSupply', projectId: id, stockpileId: Number(e.target.value) || null } }))
    .then(() => toast(e.target.value ? 'Materials in that stockpile will be fed in every time the GM advances time.' : 'Auto-supply off.'))
    .catch(() => {});
});

$('projects').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-cancel]');
  if (!b) return;
  if (!await confirmBox('Cancel this project? Materials already delivered are NOT returned.')) return;
  busy(b, () => api('construction', { method: 'POST', body: { action: 'cancel', projectId: Number(b.dataset.cancel) } }))
    .then(async () => { toast('Project cancelled.'); await load(); }).catch(() => {});
});

async function load() {
  d = await api('construction');
  renderBlueprints();
  renderProjects();
}

try {
  calendar = (await getClock()).calendar;
  $('f-mine').checked = true;
  await load();
} catch (err) {
  toast(err.message, true);
}
