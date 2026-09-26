// Labor page: the labor market and your workplaces (hire, release, wages).
import { api } from './api.js';
import { requireSession, esc, toast, busy, confirmBox, promptBox } from './common.js';
import { formatMoney, toMinor, currencyOptions } from './money.js';

const $ = (id) => document.getElementById(id);
await requireSession();

const RANK = { general: 0, skilled: 1, specialist: 2 };
const SHORT = { general: 'General', skilled: 'Skilled', specialist: 'Specialist' };
let data = null;
const cur = (id) => data.currencies.find((c) => c.id === id);
const place = (id) => data.settlements.find((s) => s.id === id);

/* ── Labor market ── */
function renderMarket() {
  const cell = (s, t) => {
    const p = s.pool[t];
    const r = s.rates[t];
    return `<td class="num"><strong>${p.available.toLocaleString()}</strong> <span class="small muted">available</span>
      <div class="small muted">${r ? `${esc(formatMoney(r.weeklyWage, cur(r.currencyId)))}/wk` : 'no standard wage'}</div></td>`;
  };
  $('market-rows').innerHTML = data.settlements.map((s) => `
    <tr><td><strong>${esc(s.name)}</strong><div class="small muted">working age ${s.workingAge.toLocaleString()}</div></td>
      ${cell(s, 'general')}${cell(s, 'skilled')}${cell(s, 'specialist')}</tr>`).join('')
    || '<tr><td colspan="4" class="muted">No settlements yet.</td></tr>';
}

/* ── Workplaces ── */
const OUTPUT_TEXT = (st) => {
  if (st.output == null) return '<span class="muted">no positions set</span>';
  if (st.output === 0) return `<span class="tag off">cannot operate</span>`;
  return `<span class="mono ${st.output === 1 ? 'credit' : ''}" style="font-size:1.35rem">${Math.round(st.output * 100)}%</span>`;
};

function staffRow(t, s) {
  const pct = s.required ? Math.min(1, s.filled / s.required) : 0;
  return `<tr><td>${SHORT[t]}</td><td class="num">${s.required}</td><td class="num">${s.filled}</td>
    <td>${s.required ? `<div class="bar"><span style="width:${(pct * 100).toFixed(0)}%"></span></div>` : ''}</td></tr>`;
}

function renderWorkplace(w) {
  const node = $('wp-template').content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  const s = place(w.settlementId);
  q('.wp-name').textContent = w.name;
  q('.wp-meta').textContent = `${w.ownerName} · ${w.settlementName} · ${w.sizeLabel}${w.notes ? ` · ${w.notes}` : ''}`;
  q('.wp-output').innerHTML = OUTPUT_TEXT(w.staffing)
    + (w.staffing.limitedBy && w.staffing.limitedBy !== 'overall' && w.staffing.output < 1
      ? `<div class="small debit">short of ${SHORT[w.staffing.limitedBy].toLowerCase()} workers</div>` : '');
  q('.wp-staff').innerHTML = ['general', 'skilled', 'specialist']
    .filter((t) => w.staffing.tiers[t].required || w.staffing.tiers[t].filled).map((t) => staffRow(t, w.staffing.tiers[t])).join('')
    || '<tr><td colspan="4" class="muted">The GM hasn\'t set required positions.</td></tr>';

  // Payroll per currency
  const weekly = new Map();
  for (const c of w.crews) weekly.set(c.currencyId, (weekly.get(c.currencyId) ?? 0) + c.weeklyWage * c.count);
  q('.wp-payroll').textContent = weekly.size
    ? `Payroll: ${[...weekly].map(([id, v]) => `${formatMoney(v, cur(id))}/week · ${formatMoney(v * data.weeksPerSession, cur(id))}/session`).join(' + ')}`
    : 'No one on the payroll yet.';

  q('.wp-production').innerHTML = productionBlock(w);
  q('.wp-crews').innerHTML = w.crews.map((c) => `
    <tr><td>${SHORT[c.positionTier]}</td><td>${SHORT[c.workerTier]}${c.workerTier !== c.positionTier ? ' <span class="small muted">(over-qualified)</span>' : ''}</td>
      <td class="num">${c.count}</td>
      <td class="num">${esc(formatMoney(c.weeklyWage, cur(c.currencyId)))}</td>
      <td class="num muted">${esc(formatMoney(c.weeklyWage * data.weeksPerSession, cur(c.currencyId)))}</td>
      <td class="num nowrap">
        <button class="ghost small" data-release="${c.id}" data-count="${c.count}">Release</button>
        <button class="ghost small" data-wage="${c.id}">Wage</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="muted">No crews.</td></tr>';

  // Hire form
  const f = q('.hire-form');
  const tiers = ['general', 'skilled', 'specialist'];
  f.position.innerHTML = tiers.map((t) => `<option value="${t}">${SHORT[t]}</option>`).join('');
  f.currency.innerHTML = currencyOptions(data.currencies.filter((c) => c.active));
  const refresh = (setWage) => {
    const pos = f.position.value;
    const keep = f.worker.value;
    f.worker.innerHTML = tiers.filter((t) => RANK[t] >= RANK[pos]).map((t) => `<option value="${t}">${SHORT[t]}</option>`).join('');
    if ([...f.worker.options].some((o) => o.value === keep)) f.worker.value = keep;
    const avail = s?.pool[f.worker.value]?.available ?? 0;
    const rate = s?.rates[pos];
    if (setWage) {
      if (rate) {
        const c = cur(rate.currencyId);
        f.currency.value = c.id;
        f.whole.value = Math.floor(rate.weeklyWage / c.subunitsPerUnit);
        f.sub.value = rate.weeklyWage % c.subunitsPerUnit;
      } else { f.whole.value = ''; f.sub.value = ''; }
    }
    const c = cur(Number(f.currency.value));
    q('.sub-label').textContent = c?.subunitName ?? 'sub-units';
    f.sub.disabled = c?.subunitsPerUnit === 1;
    q('.hire-note').textContent = `${avail.toLocaleString()} ${SHORT[f.worker.value].toLowerCase()} available in ${w.settlementName}. `
      + (rate ? `Standard ${SHORT[pos].toLowerCase()} wage: ${formatMoney(rate.weeklyWage, cur(rate.currencyId))}/week.` : `No standard ${SHORT[pos].toLowerCase()} wage — make an offer.`);
  };
  f.position.addEventListener('change', () => refresh(true));
  f.worker.addEventListener('change', () => refresh(false));
  f.currency.addEventListener('change', () => refresh(false));
  refresh(true);

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = cur(Number(f.currency.value));
    const weeklyWage = toMinor(f.whole.value, f.sub.value, c);
    const count = Number(f.count.value);
    if (f.whole.value === '' && f.sub.value === '') return toast('Offer a weekly wage.', true);
    const body = {
      action: 'hire', workplaceId: w.id, positionTier: f.position.value, workerTier: f.worker.value,
      count, weeklyWage, currencyId: c.id,
    };
    if (!await confirmBox(`Hire ${count} ${SHORT[body.workerTier].toLowerCase()} worker${count === 1 ? '' : 's'} at ${formatMoney(weeklyWage, c)}/week each?\n`
      + `That's ${formatMoney(weeklyWage * count * data.weeksPerSession, c)} per session from ${w.ownerName}.`)) return;
    busy(e.submitter, () => api('labor', { method: 'POST', body }))
      .then(async () => { toast(`Hired ${count} for ${w.name}.`); await load(); }).catch(() => {});
  });

  q('.wp-crews').addEventListener('click', async (e) => {
    const rel = e.target.closest('button[data-release]');
    const wage = e.target.closest('button[data-wage]');
    if (rel) {
      const n = await promptBox(`Release how many workers? (up to ${rel.dataset.count})`, rel.dataset.count);
      if (!n) return;
      busy(rel, () => api('labor', { method: 'POST', body: { action: 'release', crewId: Number(rel.dataset.release), count: Number(n) } }))
        .then(async (r) => { toast(`Released ${r.released}. They return to the labor pool.`); await load(); }).catch(() => {});
    }
    if (wage) {
      const crew = w.crews.find((c) => c.id === Number(wage.dataset.wage));
      const c = cur(crew.currencyId);
      const v = await promptBox(`New weekly wage per worker, in ${c.subunitName} (1 ${c.name} = ${c.subunitsPerUnit} ${c.subunitName}). Now: ${crew.weeklyWage}.`, crew.weeklyWage);
      if (v == null) return;
      busy(wage, () => api('labor', { method: 'POST', body: { action: 'setWage', crewId: crew.id, weeklyWage: Number(v) } }))
        .then(async () => { toast('Wage updated.'); await load(); }).catch(() => {});
    }
  });
  return node;
}

/* ── Resources & production ── */
const plural = (n, unit) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
const listGoods = (xs) => xs.map((x) => `${x.qty.toLocaleString()} ${x.name}`).join(', ');

function reserveText(n) {
  if (n.kind === 'finite') return `${n.remainingReserve.toLocaleString()} / ${n.originalReserve.toLocaleString()} RU left`;
  return `renewable · yield ${Math.round(n.yieldFactor * 100)}%${n.sustainableLimit != null ? ` · limit ${n.sustainableLimit}/session` : ''}`;
}

function renderResources() {
  $('res-rows').innerHTML = data.resources.map((n) => `
    <tr><td><strong>${esc(n.goodName)}</strong> <span class="muted">— ${esc(n.name)}</span></td>
      <td>${esc(n.settlementName)}</td>
      <td>${esc(n.qualityLabel)} <span class="muted">×${n.qualityMult}</span></td>
      <td>${esc(n.accessLabel)} <span class="muted">×${n.accessMult}</span></td>
      <td class="num">${esc(reserveText(n))}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No resources have been discovered yet.</td></tr>';
}

function productionBlock(w) {
  const p = w.production;
  if (p.mode === 'none') return '';
  const band = w.staffing.output ?? 0;
  let what = '';
  if (p.mode === 'extract' && p.node) {
    const n = p.node;
    what = `<p class="small">Extracts <strong>${esc(n.goodName)}</strong> from ${esc(n.name)}<br>
      <span class="muted">Base ${plural(p.baseOutput, 'RU')}/session × staffing ${Math.round(band * 100)}% × ${esc(n.qualityLabel)} ${n.qualityMult}
      × ${esc(n.accessLabel)} ${n.accessMult}${n.kind === 'renewable' ? ` × yield ${Math.round(n.yieldFactor * 100)}%` : ''}</span><br>
      <span class="muted">${esc(reserveText(n))}</span></p>`;
  } else if (p.mode === 'process' && p.recipe) {
    const r = p.recipe;
    what = `<p class="small">Runs <strong>${esc(r.name)}</strong>: ${esc(listGoods(r.inputs)) || 'nothing'} → ${esc(listGoods(r.outputs))} per batch<br>
      <span class="muted">Base ${plural(p.baseOutput, 'batches')}/session × staffing ${Math.round(band * 100)}%. Inputs must be in ${esc(w.stockpileName ?? 'its stockpile')}.</span>
      ${r.requirements ? `<br><span class="muted">Needs: ${esc(r.requirements)}</span>` : ''}</p>`;
  }
  const unit = p.mode === 'extract' ? (p.node?.unit ?? 'RU') : 'batches';
  const last = p.lastOutput;
  const lastText = last
    ? `Last advance (${last.days} day${last.days === 1 ? '' : 's'}): ${last.produced.length ? `<span class="credit">+${esc(listGoods(last.produced))}</span>` : 'nothing finished'}`
      + (last.consumed?.length ? ` <span class="debit">−${esc(listGoods(last.consumed))}</span>` : '')
      + (last.note ? ` <span class="tag off">${esc(last.note)}</span>` : '')
    : 'Nothing produced yet.';
  return `<h3 style="margin-top:1rem">Production ${p.producing ? '' : '<span class="tag off">paused</span>'}</h3>
    ${what}
    <p class="small">At current staffing: <strong>${plural(p.perSession, unit)}</strong> per session → ${esc(w.stockpileName ?? '—')}</p>
    <p class="small muted">${lastText}</p>
    <div class="actions" style="margin-top:.4rem"><button class="ghost small" data-producing="${w.id}" data-on="${p.producing ? 0 : 1}">${p.producing ? 'Pause production' : 'Resume production'}</button></div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-producing]');
  if (!b) return;
  busy(b, () => api('labor', { method: 'POST', body: { action: 'setProducing', workplaceId: Number(b.dataset.producing), producing: b.dataset.on === '1' } }))
    .then(async () => { toast(b.dataset.on === '1' ? 'Production resumed.' : 'Production paused.'); await load(); }).catch(() => {});
});

function renderWorkplaces() {
  const box = $('workplaces');
  box.innerHTML = '';
  if (!data.workplaces.length) {
    box.innerHTML = '<p class="muted">You don\'t manage any workplaces. Build one from a blueprint on the Construction page, or ask the GM to assign one.</p>';
    return;
  }
  for (const w of data.workplaces.filter((x) => x.active)) box.append(renderWorkplace(w));
}

async function load() {
  data = await api('labor');
  renderMarket();
  renderResources();
  renderWorkplaces();
}

load().catch((err) => toast(err.message, true));
