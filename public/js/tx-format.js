// Turns transaction records into readable ledger lines.
import { esc } from './common.js';
import { formatMoney } from './money.js';
import { formatDay } from './calendar.js';

const CROWN = 'the Crown';

/** A line from one account-holder's point of view (viewerType 'user' or 'company'). */
export function describeForViewer(t, viewerId, viewerType = 'user') {
  const incoming = t.to?.type === viewerType && t.to.id === viewerId;
  const other = incoming ? t.from : t.to;
  const name = other?.name ?? CROWN;
  let text;
  switch (t.kind) {
    case 'transfer': text = incoming ? `Received from ${name}` : `Sent to ${name}`; break;
    case 'grant': text = `Granted by ${CROWN}`; break;
    case 'seize': text = `Taken by ${CROWN}`; break;
    case 'exchange': text = incoming ? 'Money-changer — received' : 'Money-changer — paid'; break;
    case 'reversal': text = `Reversal of entry #${t.reversalOf}`; break;
    case 'purchase': text = 'Purchase'; break;
    case 'sale': text = 'Sale'; break;
    case 'wages': text = 'Wages paid'; break;
    case 'shares': text = incoming ? `Shares sold to ${name}` : `Shares bought from ${name}`; break;
    case 'dividend': text = incoming ? `Dividend from ${name}` : `Dividend paid to ${name}`; break;
    case 'freight': text = 'Shipping freight'; break;
    case 'property': text = name ? (incoming ? `Property sold to ${name}` : `Property bought from ${name}`) : (incoming ? 'Property sold' : 'Property bought from the Crown'); break;
    case 'rent': text = name ? (incoming ? `Rent from ${name}` : `Rent paid to ${name}`) : (incoming ? 'Rent received' : 'Rent paid to the Crown'); break;
    case 'fee': text = 'Market fee'; break;
    default: text = t.kind;
  }
  return { incoming, text };
}

/** Table row for a player's own history. */
export function viewerRow(t, viewerId, currencies, calendar, viewerType = 'user') {
  const cur = currencies.find((c) => c.id === t.currencyId);
  const { incoming, text } = describeForViewer(t, viewerId, viewerType);
  const amount = cur ? formatMoney(incoming ? t.amount : -t.amount, cur, { sign: true }) : t.amount;
  return `
    <tr class="${t.reversedBy ? 'reversed' : ''}">
      <td class="small nowrap">${esc(formatDay(t.worldDay, calendar, { short: true }))}</td>
      <td>${esc(text)}${t.memo ? `<div class="memo">${esc(t.memo)}</div>` : ''}
        ${t.reversedBy ? '<span class="tag off">reversed</span>' : ''}</td>
      <td class="num ${incoming ? 'credit' : 'debit'}">${esc(amount)}</td>
    </tr>`;
}

/** Table row for the GM's full ledger. */
export function gmRow(t, currencies, calendar) {
  const cur = currencies.find((c) => c.id === t.currencyId);
  const party = (p) => (p ? esc(p.name) : `<span class="muted">${CROWN}</span>`);
  const canReverse = !t.reversedBy && !t.reversalOf;
  return `
    <tr class="${t.reversedBy ? 'reversed' : ''}">
      <td class="mono small">#${t.id}</td>
      <td class="small nowrap">${esc(formatDay(t.worldDay, calendar, { short: true }))}</td>
      <td><span class="kind">${esc(t.kind)}</span></td>
      <td>${party(t.from)} → ${party(t.to)}${t.memo ? `<div class="memo">${esc(t.memo)}</div>` : ''}</td>
      <td class="num">${cur ? esc(formatMoney(t.amount, cur)) : t.amount}</td>
      <td class="num">${canReverse ? `<button class="ghost small" data-reverse="${t.id}">Reverse</button>`
        : t.reversedBy ? '<span class="tag off">reversed</span>' : ''}</td>
    </tr>`;
}

/** Where a stockpile is, e.g. "Varn Docks, Port Varn" or "" for a personal pack. */
const pileText = (p) => [p?.stockpile, p?.place].filter(Boolean).join(', ');

/** A goods-log line from one account-holder's point of view (viewerType 'user' or 'company'). */
export function itemRow(e, viewerId, calendar, { showParties = false, viewerType = 'user' } = {}) {
  const isMine = (p) => p?.type === viewerType && p.id === viewerId;
  const incoming = !showParties && isMine(e.to) && !isMine(e.from);
  const internal = !showParties && isMine(e.to) && isMine(e.from);
  const where = e.marketName ? ` — ${e.marketName}` : '';
  let text;
  if (showParties) {
    const p = (x) => (x ? `${esc(x.name)}${pileText(x) ? ` <span class="small muted">(${esc(pileText(x))})</span>` : ''}`
      : `<span class="muted">${e.marketName ? esc(e.marketName) : ['produce', 'consume'].includes(e.kind) ? 'production' : e.kind === 'construct' ? 'construction' : ['ship_out', 'ship_in'].includes(e.kind) ? 'shipping' : e.kind === 'lost' ? 'lost at sea'
        : ['list', 'unlist'].includes(e.kind) ? 'market floor' : e.kind === 'npc_sale' ? 'townsfolk' : e.kind === 'wholesale' ? 'shopkeeper' : CROWN}</span>`);
    text = `${p(e.from)} → ${p(e.to)}`;
  } else {
    switch (e.kind) {
      case 'buy': text = `Bought ${esc(e.goodName)}${esc(where)}`; break;
      case 'sell': text = `Sold ${esc(e.goodName)}${esc(where)}`; break;
      case 'ship_out': text = `Shipped ${esc(e.goodName)}${pileText(e.from) ? ` <span class="small muted">(from ${esc(pileText(e.from))})</span>` : ''}`; break;
      case 'ship_in': text = `${esc(e.goodName)} arrived by shipment${pileText(e.to) ? ` <span class="small muted">(into ${esc(pileText(e.to))})</span>` : ''}`; break;
      case 'lost': text = `${esc(e.goodName)} lost in transit`; break;
      case 'list': text = `Listed ${esc(e.goodName)} for sale${esc(where)}${pileText(e.from) ? ` <span class="small muted">(from ${esc(pileText(e.from))})</span>` : ''}`; break;
      case 'unlist': text = `Withdrew ${esc(e.goodName)} from sale${esc(where)}`; break;
      case 'wholesale': text = `Sold ${esc(e.goodName)} wholesale to a shopkeeper${esc(where)}`; break;
      case 'forfeit': text = `${esc(e.goodName)} left behind when a lease ended`; break;
      case 'haul': text = `Hauled ${esc(e.goodName)}: ${esc(pileText(e.from) || '?')} → ${esc(pileText(e.to) || '?')}`; break;
      case 'npc_sale': text = `Sold ${esc(e.goodName)} to townsfolk${esc(where)}${pileText(e.from) ? ` <span class="small muted">(${esc(pileText(e.from))})</span>` : ''}`; break;
      case 'npc_buy': text = `Bought ${esc(e.goodName)} by standing order${esc(where)}${pileText(e.to) ? ` <span class="small muted">(${esc(pileText(e.to))})</span>` : ''}`; break;
      case 'give': text = incoming ? `${esc(e.goodName)} from ${esc(e.from?.name)}` : `${esc(e.goodName)} to ${esc(e.to?.name)}`; break;
      case 'grant': text = `${esc(e.goodName)} granted by ${CROWN}`; break;
      case 'seize': text = `${esc(e.goodName)} taken by ${CROWN}`; break;
      case 'produce': text = `Produced ${esc(e.goodName)}${pileText(e.to) ? ` <span class="small muted">(${esc(pileText(e.to))})</span>` : ''}`; break;
      case 'construct': text = `Delivered ${esc(e.goodName)} to construction${pileText(e.from) ? ` <span class="small muted">(from ${esc(pileText(e.from))})</span>` : ''}`; break;
      case 'consume': text = `Used ${esc(e.goodName)} in production${pileText(e.from) ? ` <span class="small muted">(${esc(pileText(e.from))})</span>` : ''}`; break;
      case 'move': {
        // "pack" for your own carried goods, "Aldric's pack" for someone else's; warehouses by name + place.
        const side = (p) => pileText(p) || (isMine(p) ? 'pack' : `${p?.name}'s pack`);
        text = `Moved ${esc(e.goodName)}: ${esc(side(e.from))} → ${esc(side(e.to))}`;
        const other = isMine(e.to) ? e.from : e.to;
        if (!internal && pileText(other)) text += ` <span class="small muted">(${esc(other?.name)})</span>`;
        break;
      }
      default: text = `${esc(e.kind)} ${esc(e.goodName)}`;
    }
  }
  const sign = showParties || internal ? '' : incoming ? '+' : '−';
  const cls = showParties || internal ? '' : incoming ? 'credit' : 'debit';
  return `
    <tr>
      <td class="small nowrap">${esc(formatDay(e.worldDay, calendar, { short: true }))}</td>
      <td>${showParties ? `<span class="kind">${esc(e.kind)}</span> ${esc(e.goodName)} · ` : ''}${text}
        ${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}</td>
      <td class="num ${cls}">${sign}${e.qty.toLocaleString()} <span class="small muted">${esc(e.unit)}</span></td>
    </tr>`;
}

/** A stockpile as a titled list of its contents. */
export function stockpileBlock(p) {
  const title = p.kind === 'personal' ? 'Personal pack' : `${p.name}`;
  const meta = p.kind === 'personal' ? 'carried with you'
    : `${p.settlementName ?? '?'} · ${p.kind}${p.capacity != null ? ` · ${p.used.toLocaleString()} / ${p.capacity.toLocaleString()} units` : ''}`;
  return `<div class="pile">
    <div class="pile-head"><strong>${esc(title)}</strong> <span class="small muted">${esc(meta)}</span></div>
    <ul class="purse">${p.items.map((i) => `
      <li><span class="cname">${esc(i.name)} <span class="small muted">· ${esc(i.category)}</span></span>
        <span class="amt">${i.qty.toLocaleString()} <span class="small">${esc(i.unit)}</span></span></li>`).join('')
      || '<li class="muted small">Empty.</li>'}</ul></div>`;
}
