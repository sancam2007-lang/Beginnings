// GM Console → Time: advance the clock, jump to a date, edit the calendar.
import { api } from '../api.js';
import { esc, toast, busy, setTopbarDate, confirmBox } from '../common.js';
import { formatMoney } from '../money.js';

export function init({ $, emit, on }) {
  let snap = null;
  let currencies = [];
  let draft = []; // months being edited

  function render(s) {
    snap = s;
    const cal = s.calendar;
    const monthLen = cal.months[s.date.month].days;
    $('t-date').textContent = s.date.text;
    $('t-daynum').textContent = `World day ${s.day.toLocaleString()} · ${cal.months[s.date.month].name} has ${monthLen} days`;
    $('t-month-btn').dataset.monthDays = monthLen;
    $('t-month-btn').title = `${monthLen} days`;
    setTopbarDate(s.date.text, s.session);
    $('t-session').textContent = `Session ${s.session.number} · day ${s.session.day} of ${s.session.length}`;
    $('sess-days').value = s.session.length;
    renderEconomy(s.economy);

    $('t-set-month').innerHTML = cal.months.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join('');
    $('t-set-month').value = s.date.month;
    $('t-set-day').value = s.date.day;
    $('t-set-year').value = s.date.year;
    syncDayMax();

    $('t-log').innerHTML = s.log.map((l) => {
      const diff = l.toDay - l.fromDay;
      return `<tr>
        <td class="small">${esc(l.fromText)} → <strong>${esc(l.toText)}</strong>
          ${l.kind === 'set' ? '<span class="tag gm">set</span>' : ''}
          ${l.toSession !== l.fromSession ? `<span class="tag base">session ${l.toSession}</span>` : ''}
          <div class="muted small">${diff > 0 ? '+' : '−'}${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'}${l.actorName ? ` · ${esc(l.actorName)}` : ''}${moneyLine(l.money)}</div>
          ${l.seed ? `<div class="muted small mono" title="Random seed — lets this advance be replayed exactly">seed ${esc(l.seed)}</div>` : ''}</td>
        <td class="memo">${esc(l.note ?? '')}</td></tr>`;
    }).join('') || '<tr><td colspan="2" class="muted">Time has not yet moved.</td></tr>';

    emit('clock', s);
  }

  const cur = (id) => currencies.find((c) => c.id === id);
  const fmt = (v, c) => (c ? formatMoney(v, c, { sign: true }) : String(v));

  function moneyLine(m) {
    const base = m?.currencies?.[0];
    if (!base || (!base.created && !base.destroyed)) return '';
    return ` · money ${esc(fmt(base.net, cur(base.currencyId)))} ${esc(base.code)}`;
  }

  function renderEconomy(eco) {
    if (!eco) return;
    $('t-econ').innerHTML = eco.currencies.filter((c) => c.supply || c.created || c.destroyed).map((c) => {
      const x = cur(c.currencyId);
      const f = (v, sign = false) => esc(x ? formatMoney(v, x, { sign }) : String(v));
      const kinds = Object.entries(c.byKind).map(([k, v]) => `${esc(k)} ${f(v, true)}`).join(' · ');
      return `<h3 style="margin:.6rem 0 .2rem">${esc(c.code)}</h3>
        <div class="econ-grid">
          <div class="stat"><div class="k">In circulation</div><div class="v">${f(c.supply)}</div></div>
          <div class="stat"><div class="k">Held by players</div><div class="v">${f(c.heldByPlayers)}</div></div>
          <div class="stat"><div class="k">Held by companies</div><div class="v">${f(c.heldByCompanies)}</div></div>
          <div class="stat"><div class="k">Created</div><div class="v credit">${f(c.created)}</div></div>
          <div class="stat"><div class="k">Destroyed</div><div class="v debit">${f(c.destroyed)}</div></div>
          <div class="stat"><div class="k">Net</div><div class="v">${f(c.net, true)}</div></div>
        </div>
        ${kinds ? `<p class="small muted">By kind: ${kinds}</p>` : ''}`;
    }).join('') || '<p class="muted">No money in circulation yet.</p>';
  }

  $('sess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => api('gm/clock', { method: 'POST', body: { action: 'setSessionDays', days: Number($('sess-days').value) } }))
      .then((s) => { render(s); toast(`A session is now ${s.session.length} days.`); }).catch(() => {});
  });

  on('currencies', (list) => { currencies = list; if (snap) render(snap); });
  api('currencies').then((r) => { currencies = r.currencies; if (snap) render(snap); }).catch(() => {});

  function showSummary(lines) {
    $('t-summary').innerHTML = (lines ?? []).map((l) => `<li>${esc(l)}</li>`).join('');
    $('t-summary').classList.toggle('hidden', !lines?.length);
  }

  async function advance(days, note, btn) {
    if (days > 90 && !await confirmBox(`Advance ${days} days? This is a big jump.`)) return;
    busy(btn, () => api('gm/clock', { method: 'POST', body: { action: 'advance', days, note } }))
      .then((s) => {
        render(s);
        showSummary(s.summary);
        toast(`Advanced ${days} day${days === 1 ? '' : 's'} — it is now ${s.date.text}.`);
      }).catch(() => {});
  }

  document.querySelectorAll('.advance-row button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = btn.dataset.days === 'month' ? Number(btn.dataset.monthDays) : Number(btn.dataset.days);
      advance(days, null, btn);
    });
  });

  $('t-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    advance(Number($('t-days').value), $('t-note').value, e.submitter);
    $('t-note').value = '';
  });

  /* ── Set date ── */
  function syncDayMax() {
    const m = snap?.calendar.months[Number($('t-set-month').value)];
    if (m) $('t-set-day').max = m.days;
  }
  $('t-set-month').addEventListener('change', syncDayMax);

  $('t-set').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      action: 'setDate',
      day: Number($('t-set-day').value),
      month: Number($('t-set-month').value),
      year: Number($('t-set-year').value),
    };
    if (!await confirmBox('Jump to this date? Markets will not be simulated for the skipped time.')) return;
    busy(e.submitter, () => api('gm/clock', { method: 'POST', body }))
      .then((s) => { render(s); showSummary([]); toast(`Date set to ${s.date.text}.`); }).catch(() => {});
  });

  /* ── Calendar editor ── */
  function renderCalendar(cal) {
    $('cal-epoch').value = cal.epochYear;
    $('cal-era').value = cal.era ?? '';
    draft = cal.months.map((m) => ({ ...m }));
    renderMonths();
  }

  function renderMonths() {
    $('cal-months').innerHTML = draft.map((m, i) => `
      <div class="cal-month">
        <span class="idx">${i + 1}</span>
        <input data-i="${i}" data-f="name" value="${esc(m.name)}" maxlength="24" aria-label="Month ${i + 1} name">
        <input data-i="${i}" data-f="days" type="number" min="1" max="100" value="${m.days}" aria-label="Days in month ${i + 1}">
      </div>`).join('');
    const total = draft.reduce((s, m) => s + (Number(m.days) || 0), 0);
    $('cal-yearlen').textContent = `— ${draft.length} months, ${total} days a year`;
  }

  $('cal-months').addEventListener('input', (e) => {
    const { i, f } = e.target.dataset;
    if (i === undefined) return;
    draft[i][f] = f === 'days' ? Number(e.target.value) : e.target.value;
    const total = draft.reduce((s, m) => s + (Number(m.days) || 0), 0);
    $('cal-yearlen').textContent = `— ${draft.length} months, ${total} days a year`;
  });
  $('cal-add').addEventListener('click', () => {
    if (draft.length >= 24) return toast('A year can have at most 24 months.', true);
    draft.push({ name: `Month ${draft.length + 1}`, days: 30 });
    renderMonths();
  });
  $('cal-remove').addEventListener('click', () => {
    if (draft.length <= 1) return;
    draft.pop();
    renderMonths();
  });

  $('cal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const calendar = { epochYear: Number($('cal-epoch').value), era: $('cal-era').value, months: draft };
    busy(e.submitter, () => api('gm/clock', { method: 'POST', body: { action: 'setCalendar', calendar } }))
      .then((s) => { render(s); renderCalendar(s.calendar); toast('Calendar saved.'); }).catch(() => {});
  });

  api('gm/clock').then((s) => { render(s); renderCalendar(s.calendar); }).catch((err) => toast(err.message, true));
}
