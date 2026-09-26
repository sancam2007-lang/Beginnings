// /api/gm/users — GM only
//   GET  — every account
//   POST — { action, userId, ... }
//     resetPassword { newPassword } | { generate: true } (returns tempPassword) · rename { rpName } · setUsername { username }
//     · setRole { role } · setDisabled { disabled } · unlock
import { sql, audit } from '../lib/db.js';
import { route, json, readJson, HttpError } from '../lib/http.js';
import { requireGM, hashPassword } from '../lib/auth.js';
import { cleanPassword, cleanRpName, cleanUsername, cleanInt } from '../lib/validate.js';
import crypto from 'node:crypto';

// Easy to read aloud at the table: no 0/O or 1/l/I.
const WORDS = 'abcdefghjkmnpqrstuvwxyz23456789';
const tempPassword = () => Array.from(crypto.randomBytes(10), (b) => WORDS[b % WORDS.length]).join('').replace(/(.{5})(.{5})/, '$1-$2');

async function listUsers() {
  const [rows, members, wallets] = await Promise.all([
    sql`select id, username, rp_name, role, disabled, created_at, last_login_at,
               (locked_until is not null and locked_until > now()) as locked
        from users order by role, lower(rp_name)`,
    sql`select m.user_id, m.role, c.id, c.name, c.ticker from company_members m join companies c on c.id = m.company_id
        where c.active order by (m.role = 'director') desc, c.name`,
    sql`select owner_id, currency_id, balance_minor from wallets where owner_type = 'user' and balance_minor <> 0`,
  ]);
  return rows.map((u) => ({
    id: u.id, username: u.username, rpName: u.rp_name, role: u.role,
    disabled: u.disabled, locked: u.locked, createdAt: u.created_at, lastLoginAt: u.last_login_at,
    companies: members.filter((m) => m.user_id === u.id).map((m) => ({ id: m.id, name: m.name, ticker: m.ticker, role: m.role })),
    balances: Object.fromEntries(wallets.filter((w) => w.owner_id === u.id).map((w) => [w.currency_id, Number(w.balance_minor)])),
  }));
}

async function gmCount() {
  const [{ n }] = await sql`select count(*)::int as n from users where role = 'gm' and not disabled`;
  return n;
}

export default route({
  GET: async (req) => {
    await requireGM(req);
    return json({ users: await listUsers() });
  },

  POST: async (req) => {
    const me = await requireGM(req);
    const body = await readJson(req);
    const userId = cleanInt(body.userId, 'User id', 1, 2 ** 31 - 1);
    const [target] = await sql`select id, username, rp_name, role, disabled from users where id = ${userId}`;
    if (!target) throw new HttpError(404, 'Account not found.');

    let extra = {};
    switch (body.action) {
      case 'resetPassword': {
        const pw = body.generate ? tempPassword() : cleanPassword(body.newPassword);
        if (body.generate) extra = { tempPassword: pw };
        const hash = await hashPassword(pw);
        await sql`update users set password_hash = ${hash}, failed_logins = 0, locked_until = null where id = ${userId}`;
        await sql`delete from sessions where user_id = ${userId}`;
        await audit(me.id, 'user.reset_password', { userId, username: target.username });
        break;
      }
      case 'rename': {
        const rpName = cleanRpName(body.rpName);
        try {
          await sql`update users set rp_name = ${rpName} where id = ${userId}`;
        } catch (err) {
          if (err.code === '23505') throw new HttpError(409, 'That roleplay name is already taken.');
          throw err;
        }
        await audit(me.id, 'user.rename', { userId, from: target.rp_name, to: rpName });
        break;
      }
      case 'setUsername': {
        const username = cleanUsername(body.username);
        try {
          await sql`update users set username = ${username} where id = ${userId}`;
        } catch (err) {
          if (err.code === '23505') throw new HttpError(409, 'That username is already taken.');
          throw err;
        }
        await audit(me.id, 'user.set_username', { userId, from: target.username, to: username });
        break;
      }
      case 'setRole': {
        const role = body.role === 'gm' ? 'gm' : 'player';
        if (target.role === 'gm' && role === 'player' && (await gmCount()) <= 1) {
          throw new HttpError(400, 'There must always be at least one GM.');
        }
        await sql`update users set role = ${role} where id = ${userId}`;
        await audit(me.id, 'user.set_role', { userId, role });
        break;
      }
      case 'setDisabled': {
        const disabled = Boolean(body.disabled);
        if (disabled && userId === me.id) throw new HttpError(400, "You can't disable your own account.");
        if (disabled && target.role === 'gm' && (await gmCount()) <= 1) {
          throw new HttpError(400, 'There must always be at least one active GM.');
        }
        await sql`update users set disabled = ${disabled} where id = ${userId}`;
        if (disabled) await sql`delete from sessions where user_id = ${userId}`;
        await audit(me.id, 'user.set_disabled', { userId, disabled });
        break;
      }
      case 'unlock':
        await sql`update users set failed_logins = 0, locked_until = null where id = ${userId}`;
        await audit(me.id, 'user.unlock', { userId });
        break;
      default:
        throw new HttpError(400, 'Unknown action.');
    }
    return json({ users: await listUsers(), ...extra });
  },
});

export const config = { path: '/api/gm/users' };
