// GM Console → Markets → Bulk Import: paste spreadsheet cells or upload a CSV of goods.
import { api } from '../api.js';
import { esc, toast, confirmBox } from '../common.js';

// Header text (lower-case, spaces/punctuation squashed) → field name.
const ALIASES = {
  name: ['name', 'good', 'goods', 'item', 'goodname'],
  unit: ['unit', 'units', 'per'],
  category: ['category', 'cat', 'type', 'group'],
  description: ['description', 'desc', 'notes', 'note'],
  type: ['type', 'kind', 'goodtype', 'tier'],
  shop: ['shop', 'inshop', 'soldinshop', 'retail', 'goodsshop', 'soldtoplayers'],
  bulk: ['bulk', 'inbulk', 'tradedinbulk', 'wholesale', 'company', 'companies'],
  playerMade: ['playermade', 'processed', 'playersonly', 'madebyplayers', 'playermadeonly'],
  market: ['market', 'marketname', 'soldat'],
  price: ['price', 'normalprice', 'baseprice', 'basicprice', 'cost'],
  stock: ['stock', 'stocknow', 'currentstock', 'quantity', 'qty'],
  target: ['normalstock', 'targetstock', 'target', 'normal'],
  restock: ['restock', 'restockday', 'restockperday', 'restockrate'],
  swing: ['swing', 'dailyswing', 'volatility', 'vol'],
  pull: ['pull', 'pulltonormal', 'reversion'],
  scarcity: ['scarcity', 'scarcityeffect', 'elasticity', 'sensitivity'],
};
const squash = (h) => String(h).toLowerCase().replace(/[^a-z]/g, '');
const fieldFor = (header) => Object.keys(ALIASES).find((f) => ALIASES[f].includes(squash(header))) ?? null;

/** CSV / TSV parser that handles quoted cells, doubled quotes, and newlines inside quotes. */
export function parseTable(textIn) {
  const text = textIn.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = text.split('\n', 1)[0];
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const TEMPLATE = [
  ['Name', 'Unit', 'Category', 'Description', 'Type', 'Market', 'Price', 'Stock', 'Normal stock', 'Restock', 'Swing %', 'Pull %', 'Scarcity'],
  ['Timber', 'RU', 'Raw', 'Logs from the island woods', 'raw', 'Grand Market', '1.5', '', '', '0', '', '', ''],
  ['Planks', 'RU', 'Materials', 'Sawn boards', 'processed', 'Grand Market', '4', '', '', '0', '', '', ''],
  ['Chair', 'each', 'Furniture', 'A sturdy chair', 'consumer', 'Grand Stalls', '6', '0', '20', '5', '3', '5', '0.5'],
];

export function init({ $, emit }) {
  let parsed = { headers: [], fields: [], rows: [] };

  function readInput() {
    const table = parseTable($('im-text').value);
    $('im-errors').classList.add('hidden');
    if (table.length < 2) {
      parsed = { headers: [], fields: [], rows: [] };
      $('im-status').textContent = table.length === 1 ? 'Add at least one row under the header.' : '';
      $('im-preview-wrap').classList.add('hidden');
      $('im-check').disabled = true;
      $('im-go').disabled = true;
      return;
    }
    const [headers, ...body] = table;
    const fields = headers.map(fieldFor);
    const rows = body.map((cells) => {
      const o = {};
      fields.forEach((f, i) => { if (f && o[f] === undefined) o[f] = (cells[i] ?? '').trim(); });
      return o;
    });
    parsed = { headers, fields, rows };

    const unknown = headers.filter((h, i) => !fields[i] && h.trim());
    const hasName = fields.includes('name');
    $('im-status').innerHTML = `${rows.length} row${rows.length === 1 ? '' : 's'} · columns: `
      + headers.map((h, i) => (fields[i] ? `<span class="credit">${esc(h)}</span>` : `<span class="muted" title="Not recognised — ignored"><s>${esc(h)}</s></span>`)).join(', ')
      + (unknown.length ? ' <span class="muted">(struck-out columns are ignored)</span>' : '')
      + (hasName ? '' : ' <strong class="debit">— needs a Name column</strong>');

    const cols = [...new Set(fields.filter(Boolean))];
    $('im-head').innerHTML = `<tr><th class="num">Row</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    $('im-rows').innerHTML = rows.slice(0, 200).map((r, i) => `
      <tr><td class="num small muted">${i + 2}</td>${cols.map((c) => `<td class="small">${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')
      + (rows.length > 200 ? `<tr><td colspan="${cols.length + 1}" class="muted small">…and ${rows.length - 200} more</td></tr>` : '');
    $('im-preview-wrap').classList.remove('hidden');
    $('im-check').disabled = !hasName;
    $('im-go').disabled = !hasName;
  }

  function showErrors(list) {
    $('im-errors').innerHTML = list.map((e) => `<li>${esc(e)}</li>`).join('');
    $('im-errors').classList.toggle('hidden', !list.length);
  }

  function describe(s) {
    return [
      s.goodsCreated && `${s.goodsCreated} new good${s.goodsCreated === 1 ? '' : 's'}`,
      s.goodsUpdated && `${s.goodsUpdated} updated`,
      s.listingsCreated && `${s.listingsCreated} put on sale`,
      s.listingsUpdated && `${s.listingsUpdated} listing${s.listingsUpdated === 1 ? '' : 's'} updated`,
    ].filter(Boolean).join(', ') || 'nothing to change';
  }

  async function send(dryRun, btn) {
    btn.disabled = true;
    try {
      const r = await api('gm/markets', { method: 'POST', body: { action: 'bulkImport', rows: parsed.rows, dryRun } });
      showErrors([]);
      if (dryRun) {
        $('im-status').innerHTML += `<br><strong class="credit">Looks good:</strong> ${esc(describe(r.imported))}. Press Import to apply.`;
      } else {
        emit('markets-data', r);
        toast(`Imported: ${describe(r.imported)}.`);
        $('im-text').value = '';
        readInput();
      }
    } catch (err) {
      showErrors(err.data?.rowErrors ?? []);
      toast(err.message, true);
    } finally {
      btn.disabled = !parsed.rows.length;
    }
  }

  $('im-text').addEventListener('input', readInput);
  $('im-check').addEventListener('click', (e) => send(true, e.currentTarget));
  $('im-go').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // gone once the confirm box has been awaited
    if (!await confirmBox(`Import ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}?`)) return;
    send(false, btn);
  });
  $('im-clear').addEventListener('click', () => { $('im-text').value = ''; readInput(); });

  $('im-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('im-text').value = await file.text();
    e.target.value = '';
    readInput();
  });

  $('im-template').addEventListener('click', () => {
    const csv = TEMPLATE.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'goods-import-template.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
