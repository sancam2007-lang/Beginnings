-- =============================================================================
-- Beginnings — 0001_core_identity_permissions.sql
-- Phase 1 foundation: identity, the permission engine, offices, regions, audit.
--
-- Everything downstream (documents, bills, elections, missions, companies,
-- taxes, permits) authorizes through has_permission(...) defined here, so this
-- file is the single source of truth for "who is allowed to do what."
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive usernames

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type account_type as enum ('admin','politician','company','auror','civilian');

-- -----------------------------------------------------------------------------
-- Public, human-facing ID formatting  (e.g. CIT-000143). These are display IDs
-- ONLY — every table still uses UUID primary keys internally.
-- -----------------------------------------------------------------------------
create or replace function format_public_id(prefix text, n bigint, width int default 6)
returns text language sql immutable as $$
  select prefix || '-' || lpad(n::text, width, '0');
$$;

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Regions
-- -----------------------------------------------------------------------------
create table regions (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  name         text not null,
  description  text,
  seal_path    text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger regions_touch before update on regions
  for each row execute function touch_updated_at();

-- -----------------------------------------------------------------------------
-- Profiles (1:1 with auth.users). account_type lives HERE, never in auth creds.
-- -----------------------------------------------------------------------------
create sequence citizen_id_seq;

create table profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  citizen_id     text unique not null default format_public_id('CIT', nextval('citizen_id_seq')),
  account_type   account_type not null default 'civilian',
  full_name      text,
  username       citext unique,
  home_region_id uuid references regions(id),
  occupation     text,
  avatar_path    text,
  status         text not null default 'active'
                   check (status in ('active','suspended','pending','closed')),
  registered_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index profiles_account_type_idx on profiles(account_type);
create index profiles_home_region_idx on profiles(home_region_id);
create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();

-- -----------------------------------------------------------------------------
-- Permission catalog  (data, not code — admins never edit frontend to add one)
-- -----------------------------------------------------------------------------
create table permissions (
  key         text primary key,          -- e.g. 'bills.vote'
  category    text not null,             -- grouping for the admin matrix UI
  label       text not null,
  description text
);

-- -----------------------------------------------------------------------------
-- Offices  (Minister of Finance, Mayor, Election Commissioner, ...). An office
-- is optionally scoped to a region (null region_id = national office).
-- -----------------------------------------------------------------------------
create table offices (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name       text not null,
  ministry   text,
  region_id  uuid references regions(id),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table office_permissions (
  office_id      uuid references offices(id) on delete cascade,
  permission_key text references permissions(key) on delete cascade,
  primary key (office_id, permission_key)
);

create table office_members (
  id         uuid primary key default gen_random_uuid(),
  office_id  uuid not null references offices(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  title      text,
  region_id  uuid references regions(id),   -- jurisdiction for a regional seat
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  is_active  boolean not null default true,
  unique (office_id, user_id)
);
create index office_members_user_idx on office_members(user_id) where is_active;

-- Per-user grants/revokes that sit on top of office-derived permissions.
create table user_permission_overrides (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  effect         text not null check (effect in ('grant','revoke')),
  granted_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  unique (user_id, permission_key)
);

-- -----------------------------------------------------------------------------
-- Audit log  (append-only: no UPDATE/DELETE policy exists, so rows are immutable
-- to every client; writes happen only through log_action()).
-- -----------------------------------------------------------------------------
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references profiles(id),
  action      text not null,
  target_type text,
  target_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_target_idx on audit_logs(target_type, target_id);
create index audit_logs_actor_idx  on audit_logs(actor_id);

-- =============================================================================
-- Authorization engine  (SECURITY DEFINER so RLS policies can call it freely).
-- =============================================================================
create or replace function current_account_type()
returns account_type language sql stable security definer set search_path = public as $$
  select account_type from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and account_type = 'admin');
$$;

-- The one place admin-as-superuser is decided. Everything else — including every
-- delegated minister/governor — flows through offices + overrides, never a
-- scattered `role === 'admin'` check.
create or replace function has_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    -- 1. admin is superuser
    when exists (select 1 from profiles
                 where id = auth.uid() and account_type = 'admin') then true
    -- 2. explicit revoke beats any grant
    when exists (select 1 from user_permission_overrides o
                 where o.user_id = auth.uid()
                   and o.permission_key = perm and o.effect = 'revoke') then false
    -- 3. explicit personal grant
    when exists (select 1 from user_permission_overrides o
                 where o.user_id = auth.uid()
                   and o.permission_key = perm and o.effect = 'grant') then true
    -- 4. granted by an active office the user holds
    when exists (select 1 from office_members m
                 join office_permissions op on op.office_id = m.office_id
                 where m.user_id = auth.uid() and m.is_active
                   and op.permission_key = perm) then true
    else false
  end;
$$;

-- Structured audit writer. SECURITY DEFINER so it can insert past RLS while
-- still stamping actor = auth.uid().
create or replace function log_action(
  p_action text, p_target_type text default null,
  p_target_id text default null, p_metadata jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs(actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- =============================================================================
-- Bootstrap a profile the moment an auth user is created.
-- =============================================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, username)
  values (new.id,
          nullif(new.raw_user_meta_data->>'full_name', ''),
          nullif(new.raw_user_meta_data->>'username', ''));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Stop civilians from self-promoting: privileged columns can only change if the
-- editor actually holds users.manage (admins pass via has_permission superuser).
create or replace function guard_profile_privileged_fields()
returns trigger language plpgsql as $$
begin
  if (new.account_type   is distinct from old.account_type
   or new.status         is distinct from old.status
   or new.citizen_id     is distinct from old.citizen_id
   or new.home_region_id is distinct from old.home_region_id)
     and not has_permission('users.manage') then
    raise exception 'Not authorized to modify privileged profile fields';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on profiles
  for each row execute function guard_profile_privileged_fields();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table regions                   enable row level security;
alter table profiles                  enable row level security;
alter table permissions               enable row level security;
alter table offices                   enable row level security;
alter table office_permissions        enable row level security;
alter table office_members            enable row level security;
alter table user_permission_overrides enable row level security;
alter table audit_logs                enable row level security;

-- profiles: read self; managers read all. No self-edit of privileged cols
-- (trigger enforces). Insert is trigger-only; deletes cascade from auth.users.
create policy profiles_select_self on profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_select_manage on profiles for select to authenticated
  using (has_permission('users.manage'));
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_manage on profiles for update to authenticated
  using (has_permission('users.manage')) with check (true);

-- regions: public read; write needs regions.manage.
create policy regions_read on regions for select to authenticated using (true);
create policy regions_write on regions for all to authenticated
  using (has_permission('regions.manage')) with check (has_permission('regions.manage'));

-- permissions catalog: readable so the admin matrix can render; admin writes.
create policy permissions_read on permissions for select to authenticated using (true);
create policy permissions_write on permissions for all to authenticated
  using (is_admin()) with check (is_admin());

-- government structure is public to read; offices.manage to modify.
create policy offices_read on offices for select to authenticated using (true);
create policy offices_write on offices for all to authenticated
  using (has_permission('offices.manage')) with check (has_permission('offices.manage'));

create policy office_perms_read on office_permissions for select to authenticated using (true);
create policy office_perms_write on office_permissions for all to authenticated
  using (has_permission('offices.manage')) with check (has_permission('offices.manage'));

create policy office_members_read on office_members for select to authenticated using (true);
create policy office_members_write on office_members for all to authenticated
  using (has_permission('offices.manage')) with check (has_permission('offices.manage'));

-- overrides: see your own or manage others.
create policy overrides_read on user_permission_overrides for select to authenticated
  using (user_id = auth.uid() or has_permission('users.manage'));
create policy overrides_write on user_permission_overrides for all to authenticated
  using (has_permission('users.manage')) with check (has_permission('users.manage'));

-- audit: read needs audit.read; no insert/update/delete policy → clients cannot
-- forge or alter records; only log_action() (security definer) writes.
create policy audit_read on audit_logs for select to authenticated
  using (has_permission('audit.read'));

-- =============================================================================
-- Seed: permission catalog
-- =============================================================================
insert into permissions (key, category, label) values
  ('users.manage',                 'Administration', 'Manage users & accounts'),
  ('offices.manage',               'Administration', 'Manage offices & memberships'),
  ('regions.manage',               'Administration', 'Manage regions'),
  ('audit.read',                   'Administration', 'Read audit logs'),
  ('events.manage',                'Administration', 'Manage national events'),
  ('bills.create',                 'Legislation',    'Draft bills'),
  ('bills.edit_own',               'Legislation',    'Edit own bills'),
  ('bills.manage',                 'Legislation',    'Manage all bills'),
  ('bills.vote',                   'Legislation',    'Vote on bills'),
  ('elections.manage',             'Elections',      'Create & certify elections'),
  ('elections.vote',               'Elections',      'Cast ballots'),
  ('documents.read_confidential',  'Documents',      'Read confidential documents'),
  ('documents.approve',            'Documents',      'Approve / reject submissions'),
  ('documents.issue',              'Documents',      'Issue documents'),
  ('business.tax_review',          'Companies',      'Review tax filings'),
  ('business.permit_review',       'Companies',      'Review permit requests'),
  ('business.manage',              'Companies',      'Modify company standing'),
  ('missions.create',              'Aurors',         'Create missions'),
  ('missions.classify',            'Aurors',         'Set mission classification'),
  ('missions.assign',              'Aurors',         'Assign / grade missions')
on conflict do nothing;

-- =============================================================================
-- Seed: six starting regions (renameable/removable later by admins)
-- =============================================================================
insert into regions (code, name, description) values
  ('R1', 'First Region',   'Seed region — rename in the admin bureau.'),
  ('R2', 'Second Region',  'Seed region — rename in the admin bureau.'),
  ('R3', 'Third Region',   'Seed region — rename in the admin bureau.'),
  ('R4', 'Fourth Region',  'Seed region — rename in the admin bureau.'),
  ('R5', 'Fifth Region',   'Seed region — rename in the admin bureau.'),
  ('R6', 'Sixth Region',   'Seed region — rename in the admin bureau.')
on conflict do nothing;

-- =============================================================================
-- Seed: starter national offices + their permission grants
-- =============================================================================
insert into offices (code, name, ministry) values
  ('ADMIN',    'Office of Administration', null),
  ('FINANCE',  'Ministry of Finance',      'Finance'),
  ('INTERIOR', 'Ministry of Interior',     'Interior'),
  ('DEFENSE',  'Ministry of Defense',      'Defense'),
  ('PARLIAMENT','Parliament',              null),
  ('ELECTION', 'Election Commission',      null)
on conflict do nothing;

insert into office_permissions (office_id, permission_key)
select o.id, p.key from offices o join permissions p on true
where (o.code = 'ADMIN')
   or (o.code = 'FINANCE'   and p.key in ('business.tax_review','business.permit_review','business.manage','documents.approve'))
   or (o.code = 'INTERIOR'  and p.key in ('regions.manage','business.permit_review','documents.approve','documents.issue'))
   or (o.code = 'DEFENSE'   and p.key in ('missions.create','missions.classify','missions.assign','documents.read_confidential'))
   or (o.code = 'PARLIAMENT'and p.key in ('bills.create','bills.edit_own','bills.vote','bills.manage'))
   or (o.code = 'ELECTION'  and p.key in ('elections.manage'))
on conflict do nothing;

-- NOTE: no admin account is seeded. Creating the first admin is a deliberate,
-- documented manual step (see README) so no credentials live in source.
