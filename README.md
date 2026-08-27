# Beginnings

An interactive digital-bureaucracy web platform for a fictional nation.
React + TypeScript + Vite frontend, Supabase (Postgres / Auth / RLS / Storage /
Realtime) backend, deployed on Netlify.

> **Build status:** in progress, one system at a time. This README documents
> only what actually exists and works. It will grow as each phase lands — no
> section here describes a feature that is still mocked.

## What exists now — Phase 1: identity & the permission engine

`supabase/migrations/0001_core_identity_permissions.sql` sets up the foundation
everything else authorizes against:

- **`profiles`** — one row per auth user. `account_type` (admin / politician /
  company / auror / civilian) lives here, never in auth credentials. A trigger
  auto-creates the profile on signup and issues a `CIT-000000` citizen ID.
- **`permissions`** — a data-driven catalog of permission keys. New capabilities
  are seeded as rows, never hard-coded into the frontend.
- **`offices` / `office_permissions` / `office_members`** — offices (Minister of
  Finance, Mayor, Election Commissioner…) grant permission sets to their members.
- **`user_permission_overrides`** — per-user `grant` / `revoke` on top of offices.
- **`audit_logs`** — append-only; no update/delete policy exists, so records are
  immutable to every client. Only `log_action()` writes to it.

### How authorization resolves

Everything downstream calls one function, `has_permission('some.key')`, which
resolves in this order:

1. account is `admin` → allowed (the **single** place admin-as-superuser lives);
2. an explicit `revoke` override → denied;
3. an explicit `grant` override → allowed;
4. any active office the user holds grants the key → allowed;
5. otherwise denied.

RLS policies and (later) Edge Functions call this instead of checking roles
inline, so there is no scattered `role === 'admin'` logic to drift out of sync.

## Applying the migration

1. Create a Supabase project.
2. In the SQL Editor, paste and run `0001_core_identity_permissions.sql`
   (or `supabase db push` if you use the CLI).
3. Confirm RLS is on for all created tables (Authentication → Policies).

## Creating the first administrator (deliberately manual — no seeded passwords)

1. Sign up a normal account through Supabase Auth (email/password).
2. In the SQL Editor, promote it, then log the action:

   ```sql
   update profiles set account_type = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```

That account now passes `has_permission(...)` for everything and can, from the
admin bureau (built in a later phase), assign offices and delegate finer-grained
permissions to other users.

## What exists now — Phase 2: document / workflow engine

`supabase/migrations/0002_document_workflow_engine.sql` adds the shared machine
that permits, tax filings, contracts, and plain document requests all run on —
so no feature re-implements approvals:

- **`app_settings`** — singleton config (country name, fictional `displayed_year`,
  currency, seal). Public ID numbers are stamped with the fictional year via
  `gov_year()`.
- **`document_templates` + `document_template_fields`** — the admin form builder.
  A template declares its kind (`document` / `permit` / `tax` / `contract`), fee,
  which account types may apply, approval permission, expiry, and a set of typed
  fields (text, currency, date, dropdown, signature, declaration, …).
- **`document_submissions` + `document_field_values` + `document_attachments`** —
  a filled-out instance, values stored normalized (not one JSON blob).
- **`document_workflow_events`** — append-only per-document history.
- **`issued_documents`** — the certificate/permit produced on issuance.
- **`document_status_transitions`** — data-driven, admin-inspectable state graph.

All status changes go through one function, **`document_transition(submission, →status, comment)`**,
which checks authorization + the transition graph, writes history + audit, and
issues the certificate when appropriate. RLS keeps applicants on their own docs
and reviewers on the templates whose `approval_permission` they hold. Two example
templates (a residency certificate and a trade permit) are seeded so it's
exercisable right away.

> Apply `0002` **after** `0001`.

## What exists now — Phase 3: legislation

`supabase/migrations/0003_legislation.sql` adds the parliamentary system:

- **`bills` + `bill_sponsors` + `bill_amendments`** — drafts, co-sponsorship,
  and amendment tracking, numbered `BILL-1892-014` on introduction.
- **`bill_votes`** — one ballot per legislator (unique constraint), cast only
  through **`cast_bill_vote()`**, which checks the `bills.vote` permission and
  the open voting window and lets a member change their choice while polls are
  open. These are **public roll-call** votes — readable by all — deliberately
  opposite to the secret citizen ballots in `0004`.
- **`bill_status_events`** — append-only legislative history.
- **`bill_transition()`** — the one guarded lifecycle function (authors introduce
  or withdraw their own; managers do the rest), logging the running tally.

`bill_tally(bill)` returns live yea/nay/abstain counts for the ledger.

> Apply `0003` **after** `0002`.

## What exists now — Phase 4: elections

`supabase/migrations/0004_elections.sql` adds citizen elections with genuine
ballot secrecy:

- **`elections` + `election_candidates` + `election_regions`** — the admin
  builder: type, office, ballot type, visibility mode, eligible account types,
  active-standing requirement, and eligible regions (no rows = nation-wide).
  Referenda seed `Yes`/`No` as candidate rows so every ballot is uniform.
- **`election_ballots`** — one sealed ballot per voter (unique constraint blocks
  duplicates), written only through **`cast_election_vote()`**, which validates
  the open window, eligibility, and candidate server-side.
- **`election_results()`** — aggregate tallies honoring each election's
  visibility mode (hidden-until-close / live / percentage-only / full numbers).

**Ballot secrecy detail worth knowing:** individual ballot rows are readable only
by the voter and by holders of the special `elections.audit` permission, checked
with `has_explicit_permission()` — which ignores the admin-superuser shortcut. So
an ordinary admin can read tallies but *not* reconstruct who voted for whom. To
appoint an auditor, grant `elections.audit` to a specific office or user.

> Apply `0004` **after** `0003`.

## What exists now — Phase 5: companies

`supabase/migrations/0005_companies.sql` adds businesses as real organizations:

- **`companies` + `company_members`** — one owner plus staff with roles
  (`manager` / `accountant` / `employee`); no shared password. Role decides who
  can file paperwork, touch finances, or manage the roster. Company standing can
  only be changed by government (`business.manage`), enforced by a guard trigger.
- **`company_transactions` + `company_assets` + `asset_categories`** — a private
  ledger and asset registry (finance staff + government oversight only).
- **`company_financials(company, year)`** — revenue, expenses, net, asset value,
  and a configurable tax estimate, with a monthly breakdown for the ledger.
- **Document-engine wiring** — the `on_behalf_of_company_id` foreign key stubbed
  in `0002` is now real, and new company-scoped RLS lets authorized staff file
  and read their company's paperwork. **Tax returns and permits are just
  `document_submissions`** of kind `tax` / `permit` — a seeded Corporate Tax
  Return template proves the whole chain end to end.

> Apply `0005` **after** `0004`.

## What exists now — Phase 6: aurors

`supabase/migrations/0006_aurors.sql` adds the agent/mission system:

- **`auror_profiles`** — rank, specialization, active status, and a **clearance
  level**. Commendations and disciplinary notes live in their own tables;
  `auror_record()` derives the completed/failed/active tally.
- **`missions` + `mission_members`** — the board, with classification, difficulty,
  reward, deadline, capacity, and an enrollment mode (open / application /
  assigned / invitation). Aurors join, apply, or withdraw through guarded
  functions that enforce clearance and slot limits; officers assign manually.
- **Clearance gating** — `can_read_mission()` compares the auror's clearance to
  the mission's classification, so a low-clearance agent can't see a secret
  mission at all. Setting a confidential/secret classification requires the
  `missions.classify` permission (guard trigger). Intelligence attachments gate
  again on their own classification.
- **`mission_briefings` + `mission_debriefs`** — briefing packets, and per-auror
  debriefs the author edits until an officer grades them.
- **Contracts** — reuse the document engine: a seeded `Auror Service Contract`
  template (kind `contract`), not a bespoke table.

> Apply `0006` **after** `0005`.

## What exists now — Phase 7: correspondence, events, announcements, notifications

`supabase/migrations/0007_correspondence_events_notifications.sql` adds the
connective layer:

- **Correspondence** — `correspondence_threads` / `_messages` / `_attachments` /
  `_reads`: formal letters to a representative or an office, reply threads,
  per-user read + archive state. Only the recipient side can post an "official"
  reply (trigger-enforced), and each message notifies the other party.
- **Events** — `events` with severity, affected regions/account types, and
  linked missions; private `event_notes` kept in a separate, `events.manage`-only
  table so notes never leak on a public event row.
- **Announcements** — audience-scoped by level (national / regional / ministry /
  company / auror / political / internal), resolved in `can_see_announcement()`.
- **Notifications** — an internal inbox written only through `notify()`. Triggers
  fire it from the document workflow (applicant gets told on approve/reject/issue)
  and mission assignment, alongside the correspondence trigger above.
- **Realtime** — `notifications`, `correspondence_messages`, and `announcements`
  are added to the `supabase_realtime` publication (idempotently).

> Apply `0007` **after** `0006`. **The backend schema is now feature-complete** —
> all five account types and every system in the definition of done are present,
> enforced by RLS, and authorized through the `0001` permission engine.

## Frontend (React + TypeScript + Vite)

The client lives at the repo root (`src/`, `index.html`, `vite.config.ts`). What's
built and wired to the live backend so far:

- **Immersive login** — a government service counter (email/password sign-in and
  registration) against Supabase Auth.
- **The desk shell** — a dark desk with a green blotter; navigation happens by
  clicking objects (ID booklet, incoming tray, bulletin board, forms folder,
  letter writer), not a sidebar.
- **`DeskDocument` engine** — the reusable paper-window system: papers open onto
  the desk, drag by their header, stack with z-order, and "file away" to close.
  On phones it degrades to a stacked document viewer (no tiny dragging).
- **Working civilian services** — ID booklet (own profile), bulletin board
  (announcements, RLS-filtered), incoming tray (notifications + unread badge over
  **Realtime**, mark-read), **request papers** (lists templates for your account
  type, renders the form fields as a paper document, and submits through the real
  `document_transition` engine — returning a stamped tracking number), and
  **write a letter** (creates a correspondence thread to a ministry).

The rubber **stamp** is the signature element; period typefaces are IM Fell
English + Special Elite.

### Run locally

```bash
npm install
cp .env.example .env.local     # fill in your Supabase URL + anon key
npm run dev
```

### Deploy to Netlify

`netlify.toml` sets the build command (`npm run build`), publish dir (`dist`),
and SPA redirects. Connect the repo in Netlify and add two environment variables
in **Site settings → Environment variables**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Netlify builds on push. (These are baked at build time, so if you drag-and-drop a
pre-built `dist` instead, build it locally with your `.env.local` first.)

## Remaining work (next scripts)

- Politician / company / auror / admin desks (the backend for all of them is
  already in place — this is UI wiring against existing tables and RPCs).
- The admin template builder and permission-matrix screens.
- Envelope/stamp submission animations and sound hooks.
- Generated DB types via `supabase gen types typescript` (hand-written row types
  are in `src/lib/types.ts` for now).
- `0004` — elections (candidates, eligibility, server-validated ballots).
- `0005` — companies, ledgers, assets, tax filings.
- `0006` — aurors, missions, briefings, debriefs.
- `0007` — events, announcements, notifications.
- Then the Vite frontend: auth flow, the reusable **DeskDocument** engine, and
  the immersive desk UIs per account type.
