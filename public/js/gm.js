// GM Console entry point: tabs + shared state. Each tab lives in js/gm/<tab>.js.
//
// Every tab module is loaded on its own. If one file is missing or out of date (for example after
// a partial upload to GitHub), only that tab stops working, and a banner names the file to fix,
// instead of the whole console going blank.
import { requireSession } from './common.js';

const me = await requireSession({ gm: true });

// A tiny event bus so tabs can react to each other (e.g. a new currency → treasury dropdowns).
const bus = new EventTarget();
const ctx = {
  me,
  $: (id) => document.getElementById(id),
  emit: (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail })),
  on: (name, fn) => bus.addEventListener(name, (e) => fn(e.detail)),
  openProfile: () => {},
};

/* ── Problems loading the console, shown at the top ── */
const problems = [];
function report(file, err) {
  console.error(`GM Console: ${file}`, err);
  problems.push({ file, message: err?.message ?? String(err) });
  let box = document.getElementById('gm-load-errors');
  if (!box) {
    box = document.createElement('div');
    box.id = 'gm-load-errors';
    box.className = 'load-errors';
    box.setAttribute('role', 'alert');
    document.querySelector('.gm-tabs')?.before(box);
  }
  const first = (p) => /missing from the site|out of date on the site/.test(p.message);
  const list = [...problems].sort((a, b) => first(b) - first(a)).map((p) => `<li><code>public/${p.file}</code> — ${p.message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</li>`).join('');
  box.innerHTML = `<strong>Part of the GM Console couldn't load.</strong> The rest still works.
    Usually a file is missing or out of date on GitHub: re-upload the file(s) below from the latest zip
    (or upload the whole project), wait for Netlify to redeploy, then refresh.
    <ul>${list}</ul>`;
}

/* ── Tabs (remembered in the URL hash, e.g. gm.html#treasury) ── */
const tabs = [...document.querySelectorAll('.gm-tabs button')];
function showTab(name) {
  if (!tabs.some((t) => t.dataset.tab === name)) name = 'time';
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  history.replaceState(null, '', `#${name}`);
  ctx.emit('tab', name);
}
tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// Show the tab straight away, so the page is never blank while the modules load.
showTab(location.hash.slice(1));

// The profile panel: any tab can open a player's or company's profile with ctx.openProfile(type, id).
try {
  const { createProfile } = await import('./gm/profile.js');
  const profile = createProfile({ emit: ctx.emit, me });
  ctx.openProfile = (type, id) => profile.open(type, id);
} catch (err) {
  report('js/gm/profile.js', err);
}

// Tab modules, in the order they initialise (later tabs may listen for events from earlier ones).
const MODULES = ['time', 'treasury', 'items', 'world', 'companies', 'npc', 'labor', 'resources', 'construction', 'buildings', 'realestate',
  'transport', 'exchange', 'markets', 'import', 'currencies', 'accounts', 'settings'];
const loaded = await Promise.all(MODULES.map((name) => import(`./gm/${name}.js`).then(
  (mod) => ({ name, mod }),
  (err) => { report(`js/gm/${name}.js`, err); return null; },
)));
for (const entry of loaded) {
  if (!entry) continue;
  try {
    entry.mod.init(ctx);
  } catch (err) {
    report(`js/gm/${entry.name}.js`, new Error(`${err.message} (this file and gm.html don't match: one of them is out of date)`));
  }
}

// If anything failed, find exactly which files the server doesn't have (a browser only reports the
// module that failed to import, not the missing file it depends on).
const FILES = [...MODULES.map((n) => `js/gm/${n}.js`), 'js/gm/profile.js', 'js/gm/npc-policy.js',
  'js/api.js', 'js/common.js', 'js/money.js', 'js/calendar.js', 'js/tx-format.js'];
if (problems.length) {
  // "The requested module '../common.js' does not provide an export named 'x'" → that shared file is an old copy.
  const stale = new Map(); // file → names it lacks
  for (const p of problems) {
    const m = /module '([^']+)' does not provide an export named '([^']+)'/.exec(p.message);
    if (!m) continue;
    const from = p.file.split('/').slice(0, -1);
    for (const part of m[1].split('/')) {
      if (part === '..') from.pop();
      else if (part !== '.') from.push(part);
    }
    const file = from.join('/');
    stale.set(file, new Set([...(stale.get(file) ?? []), m[2]]));
  }
  for (const [file, names] of stale) {
    report(file, new Error(`this file is out of date on the site (it has no ${[...names].map((n) => `"${n}"`).join(' or ')}). Upload the current copy; the errors below it are caused by this.`));
  }
  const missing = [];
  await Promise.all(FILES.map((f) => fetch(`/${f}`, { method: 'HEAD', cache: 'no-store' })
    .then((r) => { if (!r.ok) missing.push(f); }).catch(() => {})));
  for (const f of missing.sort()) {
    if (!problems.some((p) => p.file === f)) report(f, new Error('this file is missing from the site'));
  }
}

// Now that every tab is listening, load the current one.
showTab(location.hash.slice(1) || 'time');
