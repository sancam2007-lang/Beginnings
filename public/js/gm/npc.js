// GM Console → NPCs (script 12): every NPC-run company at a glance, one behaviour for all, and a
// spreadsheet import that sets up NPC companies with their workplaces, stores and depots.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox, attachFilter } from '../common.js';
import { formatMoney } from '../money.js';
import { parseTable } from './import.js';
import { policyFields, readPolicy, policySummary, lastActivity } from './npc-policy.js';

// Header text (squashed) → field; mirrors netlify/lib/npc-import.js.
const ALIASES = {
  company: ['company', 'companyname', 'owner', 'npccompany', 'business'],
  ticker: ['ticker', 'symbol', 'code'],
  town: ['town', 'settlement', 'city', 'place', 'location'],
  workplace: ['workplace', 'site', 'building', 'workplacename', 'facility'],
  mode: ['mode', 'type', 'productionmode', 'kind'],
  source: ['source', 'node', 'recipe', 'resourcenode', 'nodeorrecipe', 'extracts', 'makes'],
  output: ['output', 'baseoutput', 'batches', 'rate', 'outputpersession'],
  general: ['general', 'generallabor', 'laborers', 'labourers', 'reqgeneral'],
  skilled: ['skilled', 'skilledlabor', 'reqskilled'],
  specialist: ['specialist', 'specialists', 'reqspecialist'],
  size: ['size', 'workplacesize'],
  capacity: ['capacity', 'storecapacity', 'storage', 'store'],
  depot: ['depot', 'depotname', 'warehouse'],
  cash: ['cash', 'startingcash', 'capital', 'funds', 'treasury'],
};
const squash = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const fieldFor = (h) => Object.keys(ALIASES).find((f) => ALIASES[f].includes(squash(h))) ?? null;

const TEMPLATE = [
  ['Company', 'Ticker', 'Town', 'Workplace', 'Mode', 'Source', 'Output', 'General', 'Skilled', 'Specialist', 'Size', 'Store capacity', 'Depot', 'Cash'],
  ['Hillmen Mining', 'HILL', 'Grand Market', 'Iron Hill Mine', 'extract', 'Grand Iron Hill', '100', '10', '0', '0', 'Small Facility', '', 'Hill Yard', '3000'],
  ['Hillmen Mining', '', 'Grand Market', 'Coal Pit', 'extract', 'Coal', '60', '6', '0', '0', 'Small Workshop', '', 'Hill Yard', ''],
  ['Smelters Guild', 'SMG', 'Grand Market', 'Bloomery', 'process', 'Bloomery Smelting', '30', '4', '1', '0', 'Small Workshop', '500', '', '2000'],
];

export function init({ $, on, openProfile }) {
  let d = null;
  const cur = (id) => d.currencies.find((c) => c.id === Number(id)) ?? d.currencies[0];

  function apply(r) {
    d = r;
    renderRows();
    renderAll();
    return r;
  }
  const reload = () => api('gm/npc').then(apply).catch((err) => toast(err.message, true));

  function renderRows() {
    $('npc-rows').innerHTML = d.companies.map((c) => {
      const cash = Object.entries(c.balances).filter(([, v]) => v).map(([id, v]) => esc(formatMoney(v, cur(id)))).join('<br>') || '<span class="muted">—</span>';
      const sites = c.workplaces.map((w) => {
        const pct = w.required ? Math.round((w.staffed / w.required) * 100) : 0;
        const cls = !w.band ? 'debit' : w.band < 1 ? '' : 'credit';
        const made = (w.last?.produced ?? []).map((p) => `${p.qty.toLocaleString()} ${esc(p.name)}`).join(', ');
        return `<div class="small"><strong>${esc(w.name)}</strong> <span class="muted">${esc(w.town)} · ${esc(w.mode)} ${esc(w.source ?? '')}</span>
          · <span class="${cls}">${w.staffed}/${w.required} staff (${pct}%)</span>${made ? ` · made ${made}` : w.last?.note ? ` · <span class="muted">${esc(w.last.note)}</span>` : ''}</div>`;
      }).join('') || '<span class="muted small">no workplaces</span>';
      const last = c.last ? [...(c.last.prepare ?? []), ...(c.last.sell ?? [])] : [];
      return `<tr class="${c.active ? '' : 'inactive'} clickable" data-co="${c.id}">
        <td><button type="button" class="linkish" data-co="${c.id}"><strong>${esc(c.name)}</strong></button> <span class="mono small">${esc(c.ticker)}</span>
          <div class="small muted">${esc(policySummary(c.policy))}${c.custom ? '' : ' <span class="tag">default</span>'}</div></td>
        <td>${sites}</td>
        <td class="num">${cash}</td>
        <td class="num">${c.listings.count ? `${c.listings.units.toLocaleString()} units<div class="small muted">${c.listings.count} listing${c.listings.count === 1 ? '' : 's'}</div>` : '<span class="muted">—</span>'}</td>
        <td>${last.length ? `<details class="small"><summary>${last.length} action${last.length === 1 ? '' : 's'}</summary>${lastActivity(c.last)}</details>` : '<span class="muted small">not yet</span>'}</td></tr>`;
    }).join('') || `<tr data-no-filter><td colspan="5" class="muted">No NPC companies yet. Import some below, or set a company's <strong>Run by</strong> to NPCs.</td></tr>`;
  }
  $('npc-rows').addEventListener('click', (e) => {
    if (e.target.closest('details')) return;
    const row = e.target.closest('[data-co]');
    if (row) openProfile('company', Number(row.dataset.co));
  });
  attachFilter($('npc-filter'), $('npc-rows'));

  /* ── One behaviour for all ── */
  function renderAll() {
    if ($('npc-all').dataset.ready) return; // don't wipe what the GM is typing
    $('npc-all').innerHTML = `${policyFields(d.defaults)}
      <div class="actions"><button type="submit">Apply to all NPC companies</button></div>`;
    $('npc-all').dataset.ready = '1';
  }
  $('npc-all').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = d.companies.length;
    if (!n) { toast('There are no NPC companies yet.', true); return; }
    if (!(await confirmBox(`Apply this behaviour to all ${n} NPC compan${n === 1 ? 'y' : 'ies'}?`, { ok: 'Apply to all', detail: 'Their own settings are replaced.' }))) return;
    busy(e.submitter, () => api('gm/npc', { method: 'POST', body: { action: 'savePolicyAll', policy: readPolicy(e.target) } }).then(apply))
      .then(() => toast('Behaviour applied to every NPC company.')).catch(() => {});
  });

  /* ── Import ── */
  let parsed = { rows: [] };
  function readInput() {
    const table = parseTable($('ni-text').value);
    $('ni-errors').classList.add('hidden');
    if (table.length < 2) {
      parsed = { rows: [] };
      $('ni-status').textContent = table.length === 1 ? 'Add at least one row under the header.' : '';
      $('ni-preview-wrap').classList.add('hidden');
      $('ni-check').disabled = true;
      $('ni-go').disabled = true;
      return;
    }
    const [headers, ...body] = table;
    const fields = headers.map(fieldFor);
    const rows = body.map((cells) => {
      const o = {};
      fields.forEach((f, i) => { if (f && o[f] === undefined) o[f] = (cells[i] ?? '').trim(); });
      return o;
    });
    parsed = { rows };
    const need = ['company', 'town', 'workplace', 'mode', 'source', 'output'].filter((f) => !fields.includes(f));
    $('ni-status').innerHTML = `${rows.length} row${rows.length === 1 ? '' : 's'} · columns: `
      + headers.map((h, i) => (fields[i] ? `<span class="credit">${esc(h)}</span>` : `<span class="muted" title="Not recognised — ignored"><s>${esc(h)}</s></span>`)).join(', ')
      + (need.length ? ` <strong class="debit">— missing: ${need.join(', ')}</strong>` : '');
    const cols = [...new Set(fields.filter(Boolean))];
    $('ni-head').innerHTML = `<tr><th class="num">Row</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    $('ni-rows').innerHTML = rows.slice(0, 200).map((r, i) => `<tr><td class="num small muted">${i + 2}</td>${cols.map((c) => `<td class="small">${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('');
    $('ni-preview-wrap').classList.remove('hidden');
    $('ni-check').disabled = Boolean(need.length);
    $('ni-go').disabled = Boolean(need.length);
  }
  const describe = (s) => [
    s.companiesCreated && `${s.companiesCreated} new compan${s.companiesCreated === 1 ? 'y' : 'ies'}`,
    s.companiesExisting && `${s.companiesExisting} existing`,
    s.workplacesCreated && `${s.workplacesCreated} workplace${s.workplacesCreated === 1 ? '' : 's'}`,
    s.workplacesSkipped && `${s.workplacesSkipped} already there (skipped)`,
    s.depots && `${s.depots} depot${s.depots === 1 ? '' : 's'}`,
  ].filter(Boolean).join(', ') || 'nothing to change';
  async function send(dryRun, btn) {
    btn.disabled = true;
    try {
      const r = await api('gm/npc', { method: 'POST', body: { action: 'import', rows: parsed.rows, dryRun } });
      $('ni-errors').classList.add('hidden');
      if (dryRun) {
        $('ni-status').innerHTML += `<br><strong class="credit">Looks good:</strong> ${esc(describe(r.imported))}. Press Import to apply.`;
      } else {
        apply(r);
        toast(`Imported: ${describe(r.imported)}. They start hiring and producing when you advance time.`);
        $('ni-text').value = '';
        readInput();
      }
    } catch (err) {
      const list = err.data?.rowErrors ?? [];
      $('ni-errors').innerHTML = list.map((x) => `<li>${esc(x)}</li>`).join('');
      $('ni-errors').classList.toggle('hidden', !list.length);
      toast(err.message, true);
    } finally {
      btn.disabled = !parsed.rows.length;
    }
  }
  $('ni-text').addEventListener('input', readInput);
  $('ni-check').addEventListener('click', (e) => send(true, e.currentTarget));
  $('ni-go').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // gone once the confirm box has been awaited
    if (!await confirmBox(`Import ${parsed.rows.length} workplace row${parsed.rows.length === 1 ? '' : 's'}?`)) return;
    send(false, btn);
  });
  $('ni-clear').addEventListener('click', () => { $('ni-text').value = ''; readInput(); });
  $('ni-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('ni-text').value = await file.text();
    e.target.value = '';
    readInput();
  });
  $('ni-template').addEventListener('click', () => {
    const csv = TEMPLATE.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'npc-companies-template.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  on('tab', (name) => { if (name === 'npc') reload(); });
  on('refresh', () => { if (d) reload(); });
}
