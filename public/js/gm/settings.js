// GM Console → Settings: join code, registration, site name, money-changer fee.
import { api } from '../api.js';
import { toast, busy, confirmBox } from '../common.js';

export function init({ $ }) {
  function render(s) {
    $('joincode').textContent = s.joinCode || '—';
    $('reg-open').checked = s.registrationOpen;
    $('site-name').value = s.siteName;
    $('fee-pct').value = s.exchangeFeePct;
  }
  const post = (body) => api('gm/settings', { method: 'POST', body }).then(render);

  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('joincode').textContent); toast('Join code copied.'); }
    catch { toast('Copy failed — select the code and copy it manually.', true); }
  });

  $('new-code').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // gone once the confirm box has been awaited
    if (!await confirmBox('Generate a new code? The old one stops working immediately (existing accounts are unaffected).')) return;
    busy(btn, () => post({ action: 'regenerateJoinCode' })).then(() => toast('New join code issued.')).catch(() => {});
  });

  $('reg-open').addEventListener('change', (e) => {
    busy(null, () => post({ action: 'setRegistration', open: e.target.checked }))
      .then(() => toast(e.target.checked ? 'Registration opened.' : 'Registration closed.')).catch(() => {});
  });

  $('site-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => post({ action: 'setSiteName', name: $('site-name').value }))
      .then(() => toast('Site name saved. Reload to see it in the header.')).catch(() => {});
  });

  $('fee-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => post({ action: 'setExchangeFee', pct: Number($('fee-pct').value) || 0 }))
      .then(() => toast('Money-changer fee saved.')).catch(() => {});
  });

  api('gm/settings').then(render).catch((err) => toast(err.message, true));
}
