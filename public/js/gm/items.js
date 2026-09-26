// GM Console → Treasury → Items: grant/seize goods into any stockpile, view holdings, goods log.
import { api } from '../api.js';
import { esc, toast, busy, getClock, confirmBox } from '../common.js';
import { itemRow, stockpileBlock } from '../tx-format.js';

export function init({ $, on }) {
  const st = {
    goods: [], players: [], companies: [], stockpiles: [], entries: [], nextBefore: null, calendar: null,
  };
  const owner = () => {
    const [type, id] = ($('it-user').value || '').split(':');
    return id ? { type, id: Number(id) } : null;
  };
  const qs = () => (owner() ? `?ownerType=${owner().type}&ownerId=${owner().id}` : '');

  function apply(r) {
    Object.assign(st, { stockpiles: r.stockpiles, entries: r.entries, nextBefore: r.nextBefore });
    render();
  }
  const load = () => api(`gm/items${qs()}`).then(apply).catch((err) => toast(err.message, true));

  function render() {
    const who = $('it-user').selectedOptions[0]?.textContent ?? '';
    $('it-hold-title').textContent = who ? `${who} holds` : 'Holdings';
    $('it-holdings').innerHTML = st.stockpiles.map(stockpileBlock).join('') || '<p class="muted">No stockpiles.</p>';
    const keep = $('it-pile').value;
    $('it-pile').innerHTML = st.stockpiles.map((p) => `<option value="${p.id}">${esc(p.kind === 'personal' ? 'Personal pack'
      : `${p.name} (${p.settlementName})`)}</option>`).join('') || '<option value="">— no stockpiles; assign one in Companies —</option>';
    if ([...$('it-pile').options].some((o) => o.value === keep)) $('it-pile').value = keep;
    $('it-submit').disabled = !st.stockpiles.length;
    $('it-log').innerHTML = st.entries.map((e) => itemRow(e, null, st.calendar, { showParties: true })).join('')
      || '<tr><td colspan="3" class="muted">No goods have moved yet.</td></tr>';
    $('it-more').classList.toggle('hidden', !st.nextBefore);
  }

  function renderSelects() {
    const keepU = $('it-user').value;
    $('it-user').innerHTML = `<optgroup label="Players">${st.players.map((p) => `<option value="user:${p.id}">${esc(p.rpName)}</option>`).join('')}</optgroup>`
      + (st.companies.length ? `<optgroup label="Companies">${st.companies.map((c) => `<option value="company:${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>` : '');
    if ([...$('it-user').options].some((o) => o.value === keepU)) $('it-user').value = keepU;
    const keepG = $('it-good').value;
    $('it-good').innerHTML = st.goods.map((g) => `<option value="${g.id}">${esc(g.name)} (${esc(g.unit)})</option>`).join('')
      || '<option value="">— add goods in the Markets tab —</option>';
    if (keepG) $('it-good').value = keepG;
    if ($('it-user').value !== keepU) load();
  }

  $('it-action').addEventListener('change', () => {
    $('it-submit').textContent = $('it-action').value === 'grant' ? 'Grant' : 'Seize';
  });
  $('it-user').addEventListener('change', load);

  $('it-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = $('it-action').value;
    const g = st.goods.find((x) => x.id === Number($('it-good').value));
    const qty = Number($('it-qty').value);
    const pile = $('it-pile').selectedOptions[0];
    if (!g || !pile?.value) return;
    const who = $('it-user').selectedOptions[0].textContent;
    if (!await confirmBox(`${action === 'grant' ? 'Grant' : 'Seize'} ${qty} ${g.unit} of ${g.name} ${action === 'grant' ? 'to' : 'from'} ${who} (${pile.textContent})?`)) return;
    busy(e.submitter, () => api(`gm/items${qs()}`, {
      method: 'POST', body: { action, stockpileId: Number(pile.value), goodId: g.id, qty, memo: $('it-memo').value },
    })).then((r) => { apply(r); $('it-memo').value = ''; toast('Items updated.'); }).catch(() => {});
  });

  $('it-more').addEventListener('click', (e) => {
    const sep = owner() ? '&' : '?';
    busy(e.currentTarget, () => api(`gm/items${qs()}${sep}before=${st.nextBefore}`)).then((r) => {
      st.entries.push(...r.entries);
      st.nextBefore = r.nextBefore;
      render();
    }).catch(() => {});
  });

  on('catalog', ({ goods }) => { st.goods = goods; renderSelects(); });
  on('players', (players) => { st.players = players.filter((x) => !x.disabled); renderSelects(); });
  on('companies', (companies) => { st.companies = companies.filter((c) => c.active); renderSelects(); load(); });
  on('clock', (s) => { st.calendar = s.calendar; render(); });

  Promise.all([getClock(), api('players')]).then(([c, p]) => {
    st.calendar = c.calendar;
    st.players = p.players;
    renderSelects();
    return load();
  }).catch((err) => toast(err.message, true));
}
