// /api/gm/companies — GM only. Charter companies, their officers, and stockpiles.
//   GET  — every company with members, balances, stockpiles; plus all stockpiles in the world
//   POST { action: 'saveCompany', id?, name, ticker, description, charter, homeSettlementId, active }
//        { action: 'setMember', companyId, userId, role: 'director' | 'officer' | null }   (null = remove)
//        { action: 'saveStockpile', id, ownerType, ownerId, name, kind, capacity, active, haulToId? }
//              (existing stockpiles only — they are built through Construction; a stockpile never changes town)
import { sql, withTransaction, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM } from '../lib/auth.js';
import { cleanText } from '../lib/validate.js';
import { loadRules } from '../lib/shares.js';
import { setHaul } from '../lib/haul.js';
import { syncTitle } from '../lib/realestate.js';
import { currentDay } from '../lib/ledger.js';
import { publicCompany } from '../lib/company.js';

const KINDS = ['warehouse', 'depot', 'facility', 'other'];

async function snapshot() {
  const [companies, members, wallets, piles, stockTotals] = await Promise.all([
    sql`select c.*, s.name as home_name from companies c left join settlements s on s.id = c.home_settlement_id
        where c.kind <> 'crown' order by lower(c.name)`,
    sql`select m.*, u.rp_name from company_members m join users u on u.id = m.user_id order by (m.role = 'director') desc, lower(u.rp_name)`,
    sql`select owner_id, currency_id, balance_minor from wallets where owner_type = 'company' and balance_minor <> 0`,
    sql`select s.*, st.name as settlement_name,
               case when s.owner_type = 'user' then u.rp_name else c.name end as owner_name,
               (select cp.name from construction_projects cp where cp.status = 'complete'
                  and cp.result_ref->>'stockpileId' = s.id::text order by cp.id limit 1) as built_by,
               (select cp.completed_day from construction_projects cp where cp.status = 'complete'
                  and cp.result_ref->>'stockpileId' = s.id::text order by cp.id limit 1) as built_day,
               (select w.name from workplaces w where w.stockpile_id = s.id order by w.id limit 1) as store_of
        from stockpiles s
        left join settlements st on st.id = s.settlement_id
        left join users u on s.owner_type = 'user' and u.id = s.owner_id
        left join companies c on s.owner_type = 'company' and c.id = s.owner_id
        where s.kind <> 'personal'
        order by st.name, owner_name, s.name`,
    sql`select stockpile_id, coalesce(sum(qty), 0)::bigint as used from stock group by stockpile_id`,
  ]);
  const [crown] = await sql`select id, name from companies where kind = 'crown' limit 1`;
  return {
    crown: crown ? { id: crown.id, name: crown.name } : null,
    companies: companies.map((c) => ({
      ...publicCompany(c),
      members: members.filter((m) => m.company_id === c.id).map((m) => ({ userId: m.user_id, rpName: m.rp_name, role: m.role })),
      balances: Object.fromEntries(wallets.filter((w) => w.owner_id === c.id).map((w) => [w.currency_id, Number(w.balance_minor)])),
    })),
    stockpiles: piles.map((s) => ({
      id: s.id, name: s.name, kind: s.kind, ownerType: s.owner_type, ownerId: s.owner_id, ownerName: s.owner_name, haulToId: s.haul_to_id,
      settlementId: s.settlement_id, settlementName: s.settlement_name,
      capacity: s.capacity == null ? null : Number(s.capacity),
      used: Number(stockTotals.find((t) => t.stockpile_id === s.id)?.used ?? 0), active: s.active,
      builtBy: s.built_by ?? null, builtDay: s.built_day ?? null, storeOf: s.store_of ?? null,
    })),
  };
}

const unique = (err, what) => {
  if (err.code === '23505') throw new HttpError(409, `That ${what} is already taken.`);
  throw err;
};

export default route({
  GET: async (req) => {
    await requireGM(req);
    return json(await snapshot());
  },

  POST: async (req) => {
    const me = await requireGM(req);
    const b = await readJson(req);

    await withTransaction(async (q) => {
      switch (b.action) {
        case 'saveCompany': {
          if (b.id) {
            const [k] = await q`select kind from companies where id = ${Number(b.id)}`;
            if (k?.kind === 'crown') throw new HttpError(400, 'Crown Estates is managed from the Buildings and Real Estate tabs.');
          }
          const ticker = String(b.ticker ?? '').trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9]{1,5}$/.test(ticker)) throw new HttpError(400, 'Ticker must be 2–6 letters or digits, starting with a letter (e.g. VOC).');
          const f = {
            name: cleanText(b.name, 'Company name', 2, 60),
            ticker,
            description: String(b.description ?? '').trim().slice(0, 500) || null,
            charter: String(b.charter ?? '').trim().slice(0, 2000) || null,
            home: Number(b.homeSettlementId) || null,
            active: b.active !== false,
            kind: ['player', 'npc', 'house'].includes(b.kind) ? b.kind : null,
          };
          try {
            if (b.id) {
              const r = await q`update companies set name = ${f.name}, ticker = ${f.ticker}, description = ${f.description},
                                  charter = ${f.charter}, home_settlement_id = ${f.home}, active = ${f.active},
                                  kind = coalesce(${f.kind}::text, kind)
                                where id = ${Number(b.id)} returning id`;
              if (!r.length) throw new HttpError(404, 'Company not found.');
            } else {
              // A new charter comes with its shares, all held in the company's own treasury until sold.
              const shares = (await loadRules(q)).newCompanyShares;
              const [c] = await q`insert into companies (name, ticker, description, charter, home_settlement_id, founded_day, active, shares_total, kind)
                      values (${f.name}, ${f.ticker}, ${f.description}, ${f.charter}, ${f.home}, ${await currentDay(q)}, ${f.active}, ${shares}, ${f.kind ?? 'player'})
                      returning id`;
              await q`insert into shareholdings (company_id, owner_type, owner_id, qty) values (${c.id}, 'company', ${c.id}, ${shares})`;
            }
          } catch (err) { unique(err, 'company name or ticker'); }
          await audit(me.id, 'company.save', { id: b.id ?? null, ...f }, q);
          break;
        }

        case 'setMember': {
          const companyId = Number(b.companyId) || 0;
          const [k] = await q`select kind from companies where id = ${companyId}`;
          if (k?.kind === 'crown') throw new HttpError(400, 'The Crown has no officers.');
          const userId = Number(b.userId) || 0;
          if (b.role == null) {
            await q`delete from company_members where company_id = ${companyId} and user_id = ${userId}`;
          } else {
            if (!['director', 'officer'].includes(b.role)) throw new HttpError(400, 'Role must be director or officer.');
            try {
              await q`insert into company_members (company_id, user_id, role, since_day)
                      values (${companyId}, ${userId}, ${b.role}, ${await currentDay(q)})
                      on conflict (company_id, user_id) do update set role = excluded.role`;
            } catch (err) {
              if (err.code === '23503') throw new HttpError(404, 'Company or account not found.');
              throw err;
            }
          }
          await audit(me.id, 'company.member', { companyId, userId, role: b.role ?? null }, q);
          break;
        }

        case 'saveStockpile': {
          // Stockpiles come into being only by construction (or as a workplace's store). Here the GM
          // assigns one to an owner and sets its name, kind, capacity and whether it's open.
          if (!b.id) throw new HttpError(400, 'New stockpiles are built through Construction: start a project from a warehouse/depot blueprint. When it finishes, assign it here.');
          const [old] = await q`select * from stockpiles where id = ${Number(b.id) || 0} for update`;
          if (!old || old.kind === 'personal') throw new HttpError(404, 'Stockpile not found.');
          const kind = KINDS.includes(b.kind) ? b.kind : old.kind;
          const ownerType = b.ownerType === 'user' ? 'user' : 'company';
          const f = {
            name: cleanText(b.name, 'Stockpile name', 1, 40),
            kind, ownerType,
            ownerId: Number(b.ownerId) || 0,
            settlementId: old.settlement_id, // a building stays where it was built
            capacity: b.capacity === '' || b.capacity == null ? null : Number(b.capacity),
            active: b.active !== false,
          };
          if (f.capacity != null && !(Number.isSafeInteger(f.capacity) && f.capacity >= 0)) {
            throw new HttpError(400, 'Capacity must be a whole number (or blank for unlimited).');
          }
          const [owner] = ownerType === 'user'
            ? await q`select id from users where id = ${f.ownerId}`
            : await q`select id from companies where id = ${f.ownerId}`;
          if (!owner) throw new HttpError(404, 'Owner not found.');
          const [{ used }] = await q`select coalesce(sum(qty), 0)::bigint as used from stock where stockpile_id = ${old.id}`;
          const newOwner = old.owner_type !== f.ownerType || old.owner_id !== f.ownerId;
          if (newOwner) {
            if (Number(used) > 0) throw new HttpError(400, 'Empty the stockpile before assigning it to a new owner (the goods belong to the current owner).');
            const [order] = await q`select 1 from market_orders where stockpile_id = ${old.id} and status = 'active' limit 1`;
            if (order) throw new HttpError(400, 'It has open market listings or buy orders. Withdraw them before assigning it to a new owner.');
            const [site] = await q`select name, owner_type, owner_id from workplaces where stockpile_id = ${old.id} and active limit 1`;
            if (site && (site.owner_type !== f.ownerType || site.owner_id !== f.ownerId)) {
              throw new HttpError(400, `It is the store of ${site.name}. Assign the workplace (Labor tab) and its store goes with it.`);
            }
            await syncTitle(q, { stockpileId: old.id }, { type: f.ownerType, id: f.ownerId });
            // Auto-haul only runs between one owner's stockpiles: drop links that would cross owners.
            await q`update stockpiles set haul_to_id = null where id = ${old.id} or haul_to_id = ${old.id}`;
          }
          if (f.capacity != null && Number(used) > f.capacity) {
            throw new HttpError(400, `It already holds ${Number(used).toLocaleString()} units — capacity can't be lower.`);
          }
          await q`update stockpiles set name = ${f.name}, kind = ${f.kind}, owner_type = ${f.ownerType}, owner_id = ${f.ownerId},
                    capacity = ${f.capacity}, active = ${f.active}
                  where id = ${old.id}`;
          if (b.haulToId !== undefined) {
            const [saved] = await q`select * from stockpiles where id = ${old.id}`;
            await setHaul(q, saved, Number(b.haulToId) || null);
          }
          await audit(me.id, 'stockpile.save', { id: old.id, ...f, haulToId: b.haulToId ?? undefined }, q);
          break;
        }

        default:
          throw new HttpError(400, 'Unknown action.');
      }
    });
    return json(await snapshot());
  },
});

export const config = { path: '/api/gm/companies' };
