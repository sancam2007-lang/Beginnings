// /api/gm/profile — GM only. Everything about one player or one company, for the profile panel.
//   GET ?type=user|company&id=
// Changes go through the existing endpoints (gm/users, gm/companies, gm/money, company).
import { sql } from '../lib/db.js';
import { route, json, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { publicCurrency } from '../lib/currency.js';
import { publicCompany, membersOf } from '../lib/company.js';
import { listTransactions, balancesOf } from '../lib/ledger.js';
import { holdings, itemLog } from '../lib/inventory.js';
import { DEFAULT_POLICY, policyOf } from '../lib/npc.js';

async function shared() {
  const [currencies, settlements, users, companies] = await Promise.all([
    sql`select * from currencies order by is_base desc, sort_order, name`,
    sql`select id, name from settlements where active order by lower(name)`,
    sql`select id, rp_name, username, role, disabled from users order by lower(rp_name)`,
    sql`select id, name, ticker, kind, active from companies where kind not in ('house', 'crown') order by lower(name)`,
  ]);
  return {
    currencies: currencies.map(publicCurrency),
    settlements: settlements.map((s) => ({ id: s.id, name: s.name })),
    users: users.map((u) => ({ id: u.id, rpName: u.rp_name, username: u.username, role: u.role, disabled: u.disabled })),
    companies: companies.map((c) => ({ id: c.id, name: c.name, ticker: c.ticker, kind: c.kind, active: c.active })),
  };
}

async function sharesOf(owner) {
  const rows = await sql`
    select h.company_id, h.qty, c.name, c.ticker, c.share_price from shareholdings h join companies c on c.id = h.company_id
    where h.owner_type = ${owner.type} and h.owner_id = ${owner.id} and h.qty > 0
      and not (h.owner_type = 'company' and h.owner_id = h.company_id)
    order by c.name`;
  return rows.map((r) => ({ companyId: r.company_id, name: r.name, ticker: r.ticker, qty: Number(r.qty), price: r.share_price == null ? null : Number(r.share_price) }));
}

/** Stockpiles that could be handed to this owner: someone else's, empty, not a workplace's store, no open orders. */
async function assignableTo(owner) {
  const rows = await sql`
    select s.id, s.name, s.kind, s.capacity, s.active, s.owner_type, s.owner_id, st.name as settlement_name,
           coalesce(u.rp_name, c.name) as owner_name,
           (select cp.name from construction_projects cp where cp.status = 'complete'
              and cp.result_ref->>'stockpileId' = s.id::text order by cp.id limit 1) as built_by
    from stockpiles s
    left join settlements st on st.id = s.settlement_id
    left join users u on s.owner_type = 'user' and u.id = s.owner_id
    left join companies c on s.owner_type = 'company' and c.id = s.owner_id
    where s.kind <> 'personal' and not (s.owner_type = ${owner.type} and s.owner_id = ${owner.id})
      and not exists (select 1 from stock k where k.stockpile_id = s.id and k.qty > 0)
      and not exists (select 1 from workplaces w where w.stockpile_id = s.id and w.active)
      and not exists (select 1 from market_orders o where o.stockpile_id = s.id and o.status = 'active')
    order by st.name, s.name`;
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, capacity: r.capacity == null ? null : Number(r.capacity), active: r.active,
    settlementName: r.settlement_name, ownerName: r.owner_name, builtBy: r.built_by ?? null,
  }));
}

export default route({
  GET: async (req) => {
    await requireGM(req);
    const p = new URL(req.url).searchParams;
    const type = p.get('type') === 'company' ? 'company' : 'user';
    const id = Number(p.get('id')) || 0;
    const owner = { type, id };
    const base = await shared();

    if (type === 'user') {
      const [u] = await sql`
        select id, username, rp_name, role, disabled, created_at, last_login_at,
               (locked_until is not null and locked_until > now()) as locked
        from users where id = ${id}`;
      if (!u) throw new HttpError(404, 'Account not found.');
      const [balances, memberships, stockpiles, shares, ledger, goods, assignable] = await Promise.all([
        balancesOf(sql, owner),
        sql`select m.company_id, m.role, m.since_day, c.name, c.ticker, c.active from company_members m
            join companies c on c.id = m.company_id where m.user_id = ${id} order by (m.role = 'director') desc, c.name`,
        holdings(sql, owner),
        sharesOf(owner),
        listTransactions(sql, { owner, limit: 8 }),
        itemLog(sql, { owner, limit: 8 }),
        assignableTo(owner),
      ]);
      return json({
        ...base,
        type,
        user: {
          id: u.id, username: u.username, rpName: u.rp_name, role: u.role, disabled: u.disabled, locked: u.locked,
          createdAt: u.created_at, lastLoginAt: u.last_login_at,
        },
        balances,
        memberships: memberships.map((m) => ({ companyId: m.company_id, name: m.name, ticker: m.ticker, role: m.role, sinceDay: m.since_day, active: m.active })),
        stockpiles, shares, transactions: ledger.transactions, goodsLog: goods.entries, assignable,
      });
    }

    const [c] = await sql`select c.*, s.name as home_name from companies c left join settlements s on s.id = c.home_settlement_id where c.id = ${id}`;
    if (!c) throw new HttpError(404, 'Company not found.');
    const [balances, members, stockpiles, shares, ledger, goods, workplaces, holders, assignable] = await Promise.all([
      balancesOf(sql, owner),
      membersOf(sql, id),
      holdings(sql, owner),
      sharesOf(owner),
      listTransactions(sql, { owner, limit: 8 }),
      itemLog(sql, { owner, limit: 8 }),
      sql`select w.id, w.name, w.production_mode, w.active, s.name as place from workplaces w
          left join settlements s on s.id = w.settlement_id where w.owner_type = 'company' and w.owner_id = ${id} order by w.name`,
      sql`select h.owner_type, h.owner_id, h.qty, coalesce(u.rp_name, co.name) as name from shareholdings h
          left join users u on h.owner_type = 'user' and u.id = h.owner_id
          left join companies co on h.owner_type = 'company' and co.id = h.owner_id
          where h.company_id = ${id} and h.qty > 0 order by h.qty desc limit 12`,
      assignableTo(owner),
    ]);
    return json({
      ...base,
      type,
      company: {
        ...publicCompany(c), sharesTotal: Number(c.shares_total ?? 0),
        sharePrice: c.share_price == null ? null : Number(c.share_price), bookValue: c.book_value == null ? null : Number(c.book_value),
      },
      balances, members, stockpiles, shares, transactions: ledger.transactions, goodsLog: goods.entries, assignable,
      workplaces: workplaces.map((w) => ({ id: w.id, name: w.name, mode: w.production_mode, active: w.active, place: w.place })),
      holders: holders.map((h) => ({ name: h.name, qty: Number(h.qty), treasury: h.owner_type === 'company' && h.owner_id === id })),
      npc: c.kind === 'npc' ? { policy: policyOf(c), defaults: DEFAULT_POLICY, last: c.npc_last ?? null } : null,
    });
  },
});

export const config = { path: '/api/gm/profile' };
