// GET /api/companies — the register of chartered companies (public info), and which ones you serve.
import { sql } from '../lib/db.js';
import { route, json } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { publicCompany } from '../lib/company.js';

export default route({
  GET: async (req) => {
    const me = await requireUser(req);
    const [companies, members] = await Promise.all([
      sql`select c.*, s.name as home_name from companies c left join settlements s on s.id = c.home_settlement_id
          where c.active and c.kind <> 'crown' order by lower(c.name)`,
      sql`select m.company_id, m.user_id, m.role, u.rp_name from company_members m join users u on u.id = m.user_id`,
    ]);
    return json({
      companies: companies.map((c) => {
        const mine = members.filter((m) => m.company_id === c.id);
        return {
          ...publicCompany(c),
          members: mine.map((m) => ({ userId: m.user_id, rpName: m.rp_name, role: m.role })),
          myRole: mine.find((m) => m.user_id === me.id)?.role ?? null,
        };
      }),
    });
  },
});

export const config = { path: '/api/companies' };
