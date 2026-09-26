// GM Console → Labor: pools, standard wages, defaults, workplaces.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, getClock } from '../common.js';
import { formatDay } from '../calendar.js';
import { formatMoney, amountInput, currencyOptions } from '../money.js';

const TIERS = ['general', 'skilled', 'specialist'];
const SHORT = { general: 'General', skilled: 'Skilled', specialist: 'Specialist' };

export function init({ $, on }) {
  let d = null;
  let calendar = null;
  getClock().then((c) => { calendar = c.calendar; }).catch(() => {});
  const cur = (id) => d.currencies.find((c) => c.id === id);
  const post = (body) => api('gm/labor', { method: 'POST', body }).then(apply);

  function apply(r) {
    d = r;
    renderPools();
    renderRates();
    renderDefaults();
    renderWorkplaces();
    renderWorkplaceSelects();
    renderPick();
  }

  /* ── Pools ── */
  function renderPools() {
    $('lp-list').innerHTML = d.settlements.map((s) => `
      <div class="pile" style="margin-bottom:1.2rem">
        <div class="pile-head" style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:baseline">
          <span><strong>${esc(s.name)}</strong> <span class="small muted">population ${s.population.toLocaleString()} · working age ${s.workingAge.toLocaleString()}</span></span>
          <button class="ghost small" data-reset="${s.id}">Reset from population</button>
        </div>
        <div class="table-wrap"><table class="small pool-grid">
          <thead><tr><th>Tier</th><th class="num">Employed</th><th class="num">Available</th><th class="num">Unavailable</th><th class="num">Total</th><th class="num">On player payrolls</th><th></th></tr></thead>
          <tbody>${TIERS.map((t) => {
            const p = s.pool[t];
            return `<tr data-sid="${s.id}" data-tier="${t}">
              <td>${SHORT[t]}</td>
              <td class="num"><input type="number" min="0" name="employed" value="${p.employed}"></td>
              <td class="num"><input type="number" min="0" name="available" value="${p.available}"></td>
              <td class="num"><input type="number" min="0" name="unavailable" value="${p.unavailable}"></td>
              <td class="num">${(p.employed + p.available + p.unavailable).toLocaleString()}</td>
              <td class="num">${p.hiredByPlayers.toLocaleString()}</td>
              <td class="num"><button class="ghost small" data-save>Save</button></td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`).join('') || '<p class="muted">Found a settlement (World tab) and give it a population first.</p>';
  }

  $('lp-list').addEventListener('click', async (e) => {
    const save = e.target.closest('button[data-save]');
    const reset = e.target.closest('button[data-reset]');
    if (save) {
      const tr = save.closest('tr');
      const v = (n) => Number(tr.querySelector(`[name=${n}]`).value);
      busy(save, () => post({
        action: 'adjustPool', settlementId: Number(tr.dataset.sid), tier: tr.dataset.tier,
        employed: v('employed'), available: v('available'), unavailable: v('unavailable'),
      })).then(() => toast('Labor pool updated.')).catch(() => {});
    }
    if (reset) {
      if (!await confirmBox('Recompute this pool from the settlement\'s population and the default splits? Workers on player payrolls stay employed.')) return;
      busy(reset, () => post({ action: 'resetPool', settlementId: Number(reset.dataset.reset) }))
        .then(() => toast('Pool reset from population.')).catch(() => {});
    }
  });

  /* ── Standard wages ── */
  const wage = amountInput({
    select: $('wr-cur'), whole: $('wr-whole'), sub: $('wr-sub'), wholeLabel: $('wr-whole-label'), subLabel: $('wr-sub-label'),
  }, () => d?.currencies ?? []);

  function renderRates() {
    const where = (r) => (r.settlementId ? esc(r.settlementName) : '<em>Everywhere</em>');
    $('wr-rows').innerHTML = d.rates.map((r) => `
      <tr><td>${where(r)}</td><td>${SHORT[r.tier]}</td>
        <td class="num">${esc(formatMoney(r.weeklyWage, cur(r.currencyId)))}
          <div class="small muted">${esc(formatMoney(r.weeklyWage * d.weeksPerSession, cur(r.currencyId)))}/session</div></td>
        <td class="num"><button class="ghost small" data-rm="${r.settlementId ?? ''}:${r.tier}">Remove</button></td></tr>`).join('')
      + TIERS.filter((t) => !d.rates.some((r) => !r.settlementId && r.tier === t))
        .map((t) => `<tr><td><em>Everywhere</em></td><td>${SHORT[t]}</td><td class="num muted">not set</td><td></td></tr>`).join('');
    const keepScope = $('wr-scope').value;
    $('wr-scope').innerHTML = '<option value="">Everywhere</option>' + d.settlements.map((s) => `<option value="${s.id}">${esc(s.name)} only</option>`).join('');
    $('wr-scope').value = keepScope;
    const keepCur = $('wr-cur').value;
    $('wr-cur').innerHTML = currencyOptions(d.currencies.filter((c) => c.active));
    if (keepCur) $('wr-cur').value = keepCur;
    wage.refresh();
  }

  $('wr-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rm]');
    if (!b) return;
    const [sid, tier] = b.dataset.rm.split(':');
    busy(b, () => post({ action: 'setRate', settlementId: Number(sid) || null, tier, weeklyWage: null }))
      .then(() => toast('Wage removed.')).catch(() => {});
  });

  $('wr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('wr-whole').value === '' && $('wr-sub').value === '') return toast('Enter a weekly wage.', true);
    const c = wage.currency();
    busy(e.submitter, () => post({
      action: 'setRate', settlementId: Number($('wr-scope').value) || null, tier: $('wr-tier').value,
      weeklyWage: wage.read(), currencyId: c.id,
    })).then(() => { wage.clear(); toast('Standard wage set.'); }).catch(() => {});
  });

  /* ── Defaults ── */
  function renderDefaults() {
    const { status, tiers } = d.defaults;
    $('ld-emp').value = status.employed; $('ld-av').value = status.available; $('ld-un').value = status.unavailable;
    $('ld-g').value = tiers.general; $('ld-s').value = tiers.skilled; $('ld-sp').value = tiers.specialist;
    $('wk-weeks').value = d.weeksPerSession;
  }
  $('ld-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => post({
      action: 'setDefaults',
      status: { employed: Number($('ld-emp').value), available: Number($('ld-av').value), unavailable: Number($('ld-un').value) },
      tiers: { general: Number($('ld-g').value), skilled: Number($('ld-s').value), specialist: Number($('ld-sp').value) },
    })).then(() => toast('Defaults saved. Use "Reset from population" to apply them to a settlement.')).catch(() => {});
  });
  $('wk-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => post({ action: 'setWeeksPerSession', weeks: Number($('wk-weeks').value) }))
      .then(() => toast('Weeks per session saved.')).catch(() => {});
  });

  /* ── Workplaces ── */
  function renderWorkplaces() {
    $('wp-rows').innerHTML = d.workplaces.map((w) => {
      const st = w.staffing;
      const filled = TIERS.reduce((s, t) => s + st.tiers[t].filled, 0);
      const out = st.output == null ? '—' : st.output === 0 ? '<span class="tag off">idle</span>' : `${Math.round(st.output * 100)}%`;
      return `<tr class="${w.active ? '' : 'inactive'}">
        <td>${esc(w.name)} <span class="small muted">${esc(w.sizeLabel)}</span>${w.active ? '' : ' <span class="tag off">closed</span>'}
          <div class="small muted">${w.builtBy ? `built by “${esc(w.builtBy)}”` : 'placed by the GM'}</div>
          ${w.production.mode === 'extract' && w.production.node ? `<div class="small muted">extracts ${esc(w.production.node.goodName)} · ~${+w.production.perSession.toFixed(1)}/session</div>` : ''}
          ${w.production.mode === 'process' && w.production.recipe ? `<div class="small muted">runs ${esc(w.production.recipe.name)} · ~${+w.production.perSession.toFixed(1)} batches/session</div>` : ''}</td>
        <td>${esc(w.ownerName ?? '?')}</td><td>${esc(w.settlementName)}</td>
        <td class="num">${w.required.general} / ${w.required.skilled} / ${w.required.specialist}</td>
        <td class="num">${filled}</td><td class="num">${out}</td>
        <td class="num"><button class="ghost small" data-wp="${w.id}">Set up</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No workplaces yet.</td></tr>';
  }

  function keep(select, html) {
    const v = select.value;
    select.innerHTML = html;
    if ([...select.options].some((o) => o.value === v)) select.value = v;
  }

  function renderWorkplaceSelects() {
    keep($('wp-owner'), `<optgroup label="Companies">${d.owners.filter((o) => o.type === 'company').map((o) => `<option value="company:${o.id}">${esc(o.name)}</option>`).join('')}</optgroup>`
      + `<optgroup label="Players">${d.owners.filter((o) => o.type === 'user').map((o) => `<option value="user:${o.id}">${esc(o.name)}</option>`).join('')}</optgroup>`);
    keep($('wp-place'), d.settlements.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
    keep($('wp-size'), d.sizes.map((z) => `<option value="${z.id}">${esc(z.label)}</option>`).join(''));
    renderPileSelect();
    renderProdSelects();
    sizeHint();
  }

  /* production fields */
  function renderProdSelects() {
    const sid = Number($('wp-place').value);
    keep($('wp-node'), (d.nodes ?? []).filter((n) => n.settlementId === sid).map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')
      || '<option value="">— no nodes in this settlement (Resources tab) —</option>');
    keep($('wp-recipe'), (d.recipes ?? []).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')
      || '<option value="">— no recipes yet (Resources tab) —</option>');
    syncMode();
  }
  function syncMode() {
    const mode = $('wp-mode').value;
    document.querySelectorAll('.wp-extract').forEach((el) => el.classList.toggle('hidden', mode !== 'extract'));
    document.querySelectorAll('.wp-process').forEach((el) => el.classList.toggle('hidden', mode !== 'process'));
    document.querySelectorAll('.wp-prod').forEach((el) => el.classList.toggle('hidden', mode === 'none'));
    $('wp-base-label').textContent = mode === 'process' ? 'Base batches / session' : 'Base output (RU) / session';
  }
  $('wp-mode').addEventListener('change', syncMode);
  $('wp-place').addEventListener('change', renderProdSelects);

  function renderPileSelect() {
    const [type, id] = ($('wp-owner').value || ':').split(':');
    const sid = Number($('wp-place').value);
    const piles = d.stockpiles.filter((p) => p.ownerType === type && p.ownerId === Number(id) && p.settlementId === sid);
    keep($('wp-pile'), '<option value="">— none —</option>' + piles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(''));
  }
  const sizeHint = () => {
    const z = d.sizes.find((x) => x.id === $('wp-size').value);
    $('wp-size-hint').textContent = z ? `Typical ${z.label.toLowerCase()} workforce: ${z.min}–${z.max}${z.id === 'major_facility' ? '+' : ''} workers.` : '';
  };
  $('wp-owner').addEventListener('change', renderPileSelect);
  $('wp-place').addEventListener('change', renderPileSelect);
  $('wp-size').addEventListener('change', sizeHint);

  /* Workplaces are built through Construction; this form sets up an existing one. */
  const dayLabel = (n) => (n == null ? '' : formatDay(n, calendar, { short: true }));
  function renderPick() {
    const built = d.workplaces.filter((w) => w.builtBy);
    const older = d.workplaces.filter((w) => !w.builtBy);
    const opt = (w) => `<option value="${w.id}">${esc(w.name)} — ${esc(w.settlementName)} · ${esc(w.ownerName ?? '?')}${w.active ? '' : ' (closed)'}</option>`;
    keep($('wp-pick'), (built.length ? `<optgroup label="Built through construction">${built.map(opt).join('')}</optgroup>` : '')
      + (older.length ? `<optgroup label="Placed by the GM">${older.map(opt).join('')}</optgroup>` : ''));
    const none = !d.workplaces.length;
    $('wp-none').classList.toggle('hidden', !none);
    $('wp-form').classList.toggle('hidden', none);
    if (!none) load(Number($('wp-pick').value));
  }
  function load(id) {
    const w = d.workplaces.find((x) => x.id === id);
    if (!w) return;
    $('wp-pick').value = w.id;
    $('wp-id').value = w.id;
    $('wp-name').value = w.name;
    $('wp-owner').value = `${w.ownerType}:${w.ownerId}`;
    $('wp-place').value = w.settlementId;
    $('wp-size').value = w.size;
    $('wp-g').value = w.required.general;
    $('wp-s').value = w.required.skilled;
    $('wp-sp').value = w.required.specialist;
    renderPileSelect();
    $('wp-pile').value = w.stockpileId ?? '';
    $('wp-mode').value = w.production.mode;
    renderProdSelects();
    if (w.production.node) $('wp-node').value = w.production.node.id;
    if (w.production.recipe) $('wp-recipe').value = w.production.recipe.id;
    $('wp-base').value = w.production.baseOutput;
    $('wp-producing').checked = w.production.producing;
    syncMode();
    $('wp-notes').value = w.notes ?? '';
    $('wp-active').checked = w.active;
    sizeHint();
    $('wp-form-title').textContent = `Set up ${w.name}`;
    $('wp-origin').textContent = w.builtBy ? `Built by the project “${w.builtBy}”${w.builtDay != null ? `, finished ${dayLabel(w.builtDay)}` : ''}.` : 'Placed by the GM (from before construction existed, or by an NPC company import).';
  }
  $('wp-pick').addEventListener('change', () => load(Number($('wp-pick').value)));

  $('wp-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wp]');
    if (!b) return;
    load(Number(b.dataset.wp));
    $('wp-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('wp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const [ownerType, ownerId] = $('wp-owner').value.split(':');
    const id = Number($('wp-id').value) || null;
    const body = {
      action: 'saveWorkplace', id, ownerType, ownerId: Number(ownerId), settlementId: Number($('wp-place').value),
      name: $('wp-name').value, size: $('wp-size').value, reqGeneral: Number($('wp-g').value), reqSkilled: Number($('wp-s').value),
      reqSpecialist: Number($('wp-sp').value), stockpileId: Number($('wp-pile').value) || null, notes: $('wp-notes').value,
      active: $('wp-active').checked,
      productionMode: $('wp-mode').value, nodeId: Number($('wp-node').value) || null, recipeId: Number($('wp-recipe').value) || null,
      baseOutput: Number($('wp-base').value) || 0, producing: $('wp-producing').checked,
    };
    const was = d.workplaces.find((w) => w.id === id);
    if (was?.active && !body.active && !await confirmBox(`Close ${was.name}? All its workers return to the labor pool.`)) return;
    busy(e.submitter, () => post(body))
      .then(() => { load(id); toast(`${body.name} saved.`); }).catch(() => {});
  });

  /* ── Refresh when relevant things change elsewhere ── */
  const reload = () => api('gm/labor').then(apply).catch(() => {});
  on('tab', (name) => { if (name === 'labor') reload(); });
  on('world', reload);
  on('companies', reload);
  on('currencies', reload);
  on('resources', reload);

  reload();
}
