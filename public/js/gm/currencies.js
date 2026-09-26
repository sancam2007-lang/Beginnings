// GM Console → Currencies: add, edit, retire, and choose the base currency.
import { api } from '../api.js';
import { esc, toast, busy, confirmBox } from '../common.js';
import { describeRate } from '../money.js';

export function init({ $, emit }) {
  let currencies = [];

  function set(list) {
    currencies = list;
    render();
    emit('currencies', list);
  }

  function render() {
    const base = currencies.find((c) => c.isBase);
    $('cur-rows').innerHTML = currencies.map((c) => `
      <tr class="${c.active ? '' : 'inactive'}">
        <td>${esc(c.symbol)} &nbsp;${esc(c.name)}
          ${c.isBase ? '<span class="tag base">base</span>' : ''}
          ${c.active ? '' : '<span class="tag off">inactive</span>'}</td>
        <td class="mono">${esc(c.code)}</td>
        <td>${esc(c.subunitName)} (${esc(c.subunitSymbol)})</td>
        <td class="num">${c.subunitsPerUnit}</td>
        <td class="num">${esc(describeRate(c, base))}</td>
        <td class="num">
          <button class="ghost small" data-act="edit" data-id="${c.id}">Edit</button>
          ${c.isBase ? '' : `
            <button class="ghost small" data-act="base" data-id="${c.id}">Make base</button>
            <button class="ghost small" data-act="toggle" data-id="${c.id}">${c.active ? 'Deactivate' : 'Activate'}</button>`}
        </td>
      </tr>`).join('');
    $('cur-rate-label').textContent = base ? `Worth of 1 unit, in ${base.name}` : 'Worth of 1 unit, in base units';
  }

  function resetForm() {
    $('cur-form').reset();
    $('cur-id').value = '';
    $('cur-per').value = 10;
    $('cur-rate').value = 1;
    $('cur-rate').disabled = false;
    $('cur-form-title').textContent = 'Add a Currency';
    $('cur-submit').textContent = 'Add Currency';
    $('cur-cancel').classList.add('hidden');
    $('cur-per-warning').classList.add('hidden');
  }

  function edit(c) {
    $('cur-id').value = c.id;
    $('cur-name').value = c.name;
    $('cur-code').value = c.code;
    $('cur-symbol').value = c.symbol;
    $('cur-subname').value = c.subunitName;
    $('cur-subsym').value = c.subunitSymbol;
    $('cur-per').value = c.subunitsPerUnit;
    $('cur-rate').value = c.rateToBase;
    $('cur-rate').disabled = c.isBase; // base is always 1
    $('cur-sort').value = c.sortOrder;
    $('cur-form-title').textContent = `Edit ${c.name}`;
    $('cur-submit').textContent = 'Save Changes';
    $('cur-cancel').classList.remove('hidden');
    $('cur-per-warning').classList.remove('hidden');
    $('cur-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('cur-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const c = currencies.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.act === 'edit') return edit(c);
    if (btn.dataset.act === 'base') {
      if (!await confirmBox(`Make ${c.name} the base currency? All rates will be re-expressed against it (real values stay the same).`)) return;
      busy(btn, () => api('currencies', { method: 'PUT', body: { id: c.id, action: 'setBase' } }))
        .then((r) => { set(r.currencies); toast(`${c.name} is now the base currency.`); }).catch(() => {});
    }
    if (btn.dataset.act === 'toggle') {
      busy(btn, () => api('currencies', { method: 'PUT', body: { id: c.id, action: 'setActive', active: !c.active } }))
        .then((r) => set(r.currencies)).catch(() => {});
    }
  });

  $('cur-cancel').addEventListener('click', resetForm);

  $('cur-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number($('cur-id').value) || null;
    const existing = currencies.find((c) => c.id === id);
    const per = Number($('cur-per').value);
    if (existing && existing.subunitsPerUnit !== per
      && !await confirmBox(`Change ${existing.name} from ${existing.subunitsPerUnit} to ${per} ${$('cur-subname').value} per unit? All balances in it will be rescaled to keep their value.`)) return;
    const body = {
      id,
      name: $('cur-name').value,
      code: $('cur-code').value,
      symbol: $('cur-symbol').value,
      subunitName: $('cur-subname').value,
      subunitSymbol: $('cur-subsym').value,
      subunitsPerUnit: per,
      rateToBase: Number($('cur-rate').value) || 1,
      sortOrder: Number($('cur-sort').value) || 0,
    };
    busy(e.submitter, () => api('currencies', { method: id ? 'PUT' : 'POST', body }))
      .then((r) => { set(r.currencies); resetForm(); toast(id ? 'Currency updated.' : 'Currency added.'); })
      .catch(() => {});
  });

  api('currencies').then((r) => { currencies = r.currencies; render(); }).catch((err) => toast(err.message, true));
}
