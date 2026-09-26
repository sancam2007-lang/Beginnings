// GM Console → Construction: blueprints (milestones of materials) and project oversight.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox } from '../common.js';

export function init({ $, on }) {
  let d = null;
  const post = (body) => api('gm/construction', { method: 'POST', body }).then(apply);
  const goodName = (id) => d.goods.find((g) => g.id === id)?.name ?? `#${id}`;

  function apply(r) {
    d = r;
    renderProjects();
    renderBlueprints();
    renderSelects();
  }

  /* ── Projects ── */
  function renderProjects() {
    $('cp-rows').innerHTML = d.projects.filter((p) => p.status !== 'cancelled').map((p) => {
      const m = p.milestones[p.current];
      return `<tr class="${p.status === 'active' ? '' : 'inactive'}">
        <td>${esc(p.name)} ${p.status === 'complete' ? '<span class="tag base">finished</span>' : ''}</td>
        <td>${esc(p.ownerName)}</td><td>${esc(p.settlementName)}</td>
        <td class="small">${p.status === 'active' ? `${p.current + 1}/${p.milestones.length}: ${esc(m.name)}
          <div class="muted">${m.materials.map((x) => `${x.delivered.toLocaleString()}/${x.qty.toLocaleString()} ${esc(x.name)}`).join(' · ')}</div>` : '—'}</td>
        <td class="num">${Math.floor(p.percent * 100)}%</td>
        <td class="num nowrap">${p.status === 'active' ? `
          <button class="ghost small" data-force="${p.id}">Complete milestone</button>
          <button class="ghost small" data-kill="${p.id}">Cancel</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">No projects yet.</td></tr>';
  }

  $('cp-rows').addEventListener('click', async (e) => {
    const f = e.target.closest('button[data-force]');
    const k = e.target.closest('button[data-kill]');
    if (f && await confirmBox('Mark the current milestone as fully delivered (no materials used)?')) {
      busy(f, () => post({ action: 'completeMilestone', projectId: Number(f.dataset.force) })).then(() => toast('Milestone completed.')).catch(() => {});
    }
    if (k && await confirmBox('Cancel this project? Delivered materials are not returned.')) {
      busy(k, () => post({ action: 'cancel', projectId: Number(k.dataset.kill) })).then(() => toast('Project cancelled.')).catch(() => {});
    }
  });

  /* ── Blueprints ── */
  const builds = (b) => ({ workplace: 'Workplace', stockpile: 'Warehouse', none: 'Building' }[b.resultType] ?? b.resultType);
  function renderBlueprints() {
    $('bp-rows').innerHTML = d.blueprints.map((b) => `
      <tr class="${b.active ? '' : 'inactive'}">
        <td><strong>${esc(b.name)}</strong>${b.description ? `<div class="small muted">${esc(b.description)}</div>` : ''}</td>
        <td>${builds(b)}</td>
        <td class="small">${b.milestones.map((m, i) => `${i + 1}. ${esc(m.name)}: ${m.materials.map((x) => `${x.qty.toLocaleString()} ${esc(goodName(x.goodId))}`).join(', ')}`).join('<br>')}</td>
        <td class="num">${b.inUse}</td>
        <td class="num"><button class="ghost small" data-bp="${b.id}">Edit</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No blueprints yet.</td></tr>';
  }

  const goodOptions = () => d.goods.filter((g) => g.active)
    .map((g) => `<option value="${g.id}">${esc(g.name)}${g.playerMade ? ' †' : ''} (${esc(g.unit)})</option>`).join('');
  const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; };

  function renderSelects() {
    keep($('bp-size'), d.sizes.map((z) => `<option value="${z.id}">${esc(z.label)} (${z.min}–${z.max})</option>`).join(''));
    keep($('bp-recipe'), '<option value="">— none (GM sets later) —</option>' + d.recipes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join(''));
    document.querySelectorAll('#bp-ms .mat select').forEach((sel) => keep(sel, goodOptions()));
  }

  const syncType = () => {
    const t = $('bp-type').value;
    document.querySelector('.bp-workplace').classList.toggle('hidden', t !== 'workplace');
    document.querySelector('.bp-stockpile').classList.toggle('hidden', t !== 'stockpile');
  };
  $('bp-type').addEventListener('change', syncType);

  /* milestone editor */
  function matRow(m = {}) {
    return `<div class="row tight mat" style="gap:.4rem;margin:.25rem 0;align-items:center">
      <select style="flex:1">${goodOptions()}</select>
      <input type="number" min="1" value="${m.qty ?? 1000}" style="width:7rem" aria-label="Quantity">
      <button type="button" class="ghost small" data-rm-mat>✕</button></div>`;
  }
  function addMilestone(ms = { name: '', materials: [{}] }) {
    const box = document.createElement('div');
    box.className = 'ms-editor';
    box.innerHTML = `<div class="ms-head"><span class="small muted ms-num"></span>
        <input class="ms-name" maxlength="60" placeholder="Foundations" value="${esc(ms.name)}">
        <button type="button" class="ghost small" data-up>↑</button>
        <button type="button" class="ghost small" data-rm-ms>Remove</button></div>
      <div class="mats">${ms.materials.map(matRow).join('')}</div>
      <button type="button" class="ghost small" data-add-mat>+ Material</button>`;
    ms.materials.forEach((m, i) => { if (m.goodId) box.querySelectorAll('.mat select')[i].value = m.goodId; });
    $('bp-ms').append(box);
    number();
  }
  const number = () => [...$('bp-ms').children].forEach((el, i) => { el.querySelector('.ms-num').textContent = `${i + 1}.`; });

  $('bp-add-ms').addEventListener('click', () => addMilestone());
  $('bp-ms').addEventListener('click', (e) => {
    const t = e.target;
    const box = t.closest('.ms-editor');
    if (t.matches('[data-add-mat]')) box.querySelector('.mats').insertAdjacentHTML('beforeend', matRow());
    if (t.matches('[data-rm-mat]')) t.closest('.mat').remove();
    if (t.matches('[data-rm-ms]')) { box.remove(); number(); }
    if (t.matches('[data-up]') && box.previousElementSibling) { box.parentNode.insertBefore(box, box.previousElementSibling); number(); }
  });
  const readMilestones = () => [...$('bp-ms').children].map((box) => ({
    name: box.querySelector('.ms-name').value,
    materials: [...box.querySelectorAll('.mat')].map((r) => ({ goodId: Number(r.querySelector('select').value), qty: Number(r.querySelector('input').value) })),
  }));

  function resetForm() {
    $('bp-form').reset();
    $('bp-id').value = '';
    $('bp-ms').innerHTML = '';
    addMilestone({ name: 'Foundations', materials: [{}] });
    $('bp-form-title').textContent = 'New Blueprint';
    $('bp-cancel').classList.add('hidden');
    syncType();
  }
  $('bp-cancel').addEventListener('click', resetForm);

  $('bp-rows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bp]');
    if (!btn) return;
    const b = d.blueprints.find((x) => x.id === Number(btn.dataset.bp));
    const s = b.resultSpec ?? {};
    $('bp-id').value = b.id;
    $('bp-name').value = b.name;
    $('bp-desc').value = b.description ?? '';
    $('bp-type').value = b.resultType;
    $('bp-size').value = s.size ?? 'small_workshop';
    $('bp-g').value = s.reqGeneral ?? 0;
    $('bp-s').value = s.reqSkilled ?? 0;
    $('bp-sp').value = s.reqSpecialist ?? 0;
    $('bp-recipe').value = s.recipeId ?? '';
    $('bp-base').value = s.baseOutput ?? 0;
    $('bp-store').checked = s.withStore !== false;
    $('bp-storecap').value = s.storeCapacity ?? '';
    $('bp-kind').value = s.kind ?? 'warehouse';
    $('bp-cap').value = s.capacity ?? '';
    $('bp-active').checked = b.active;
    $('bp-ms').innerHTML = '';
    b.milestones.forEach((m) => addMilestone(m));
    syncType();
    $('bp-form-title').textContent = `Edit ${b.name}`;
    $('bp-cancel').classList.remove('hidden');
    $('bp-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('bp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const type = $('bp-type').value;
    const id = Number($('bp-id').value) || null;
    const body = {
      action: 'saveBlueprint', id, name: $('bp-name').value, description: $('bp-desc').value, resultType: type,
      resultSpec: type === 'workplace' ? {
        size: $('bp-size').value, reqGeneral: $('bp-g').value, reqSkilled: $('bp-s').value, reqSpecialist: $('bp-sp').value,
        recipeId: Number($('bp-recipe').value) || null, baseOutput: $('bp-base').value,
        withStore: $('bp-store').checked, storeCapacity: $('bp-storecap').value,
      } : type === 'stockpile' ? { kind: $('bp-kind').value, capacity: $('bp-cap').value } : {},
      milestones: readMilestones(),
      active: $('bp-active').checked,
    };
    busy(e.submitter, () => post(body)).then(() => { resetForm(); toast(id ? 'Blueprint saved.' : `${body.name} published.`); }).catch(() => {});
  });

  const reload = () => api('gm/construction').then(apply).catch(() => {});
  on('tab', (name) => { if (name === 'construction') reload(); });
  on('markets-data', reload);
  on('catalog', () => { if (d) reload(); });
  on('resources', () => { if (d) reload(); });

  api('gm/construction').then((r) => { apply(r); resetForm(); }).catch((err) => toast(err.message, true));
}
