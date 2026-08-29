-- =============================================================================
-- Beginnings — 0004_elections.sql
-- Phase 4: citizen elections — the admin election builder, candidate rosters,
-- eligibility rules, and SECRET server-validated ballots.
--
-- Secret-ballot design (the crux of this file):
--   * Duplicate voting is blocked by unique(election_id, voter_id) on the ballot.
--   * Individual ballots are readable ONLY by the voter themselves and by holders
--     of the special `elections.audit` permission — and that permission is checked
--     with has_explicit_permission(), which does NOT honor the admin-superuser
--     shortcut. So an ordinary admin can see tallies but NOT who voted for whom,
--     exactly as the brief requires.
--   * Everyone else reads results only through election_results(), a definer
--     function that returns aggregate counts honoring each election's visibility
--     setting (hidden-until-close / live / percentage-only / full numbers).
--   * The audit log entry for a vote deliberately omits the choice.
-- =============================================================================

-- Permission introduced here: the high-level ballot auditor.
insert into permissions (key, category, label) values
  ('elections.audit', 'Elections', 'Inspect individual ballots (sealed audit)')
on conflict do nothing;

-- Explicit-permission check WITHOUT the admin-superuser bypass. Used only where
-- being a generic admin must NOT be enough (ballot secrecy).
create or replace function has_explicit_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from user_permission_overrides o
                 where o.user_id = auth.uid() and o.permission_key = perm and o.effect = 'revoke') then false
    when exists (select 1 from user_permission_overrides o
                 where o.user_id = auth.uid() and o.permission_key = perm and o.effect = 'grant') then true
    when exists (select 1 from office_members m
                 join office_permissions op on op.office_id = m.office_id
                 where m.user_id = auth.uid() and m.is_active and op.permission_key = perm) then true
    else false
  end;
$$;

-- =============================================================================
-- Enums
-- =============================================================================
create type election_type as enum ('representative','governor','mayor','referendum','proposition');
create type election_status as enum ('draft','scheduled','open','closed','certified','cancelled','archived');
create type ballot_type as enum ('single_choice','yes_no');
create type results_visibility as enum ('hidden_until_close','live_totals','percentage_only','full_numbers');

-- Election numbering (ELEC-YEAR-NNN)
create sequence election_no_seq;
create or replace function next_election_no()
returns text language sql security definer set search_path = public as $$
  select 'ELEC-' || gov_year() || '-' || lpad(nextval('election_no_seq')::text, 3, '0');
$$;

-- =============================================================================
-- Tables
-- =============================================================================
create table elections (
  id                    uuid primary key default gen_random_uuid(),
  public_no             text unique,               -- assigned when scheduled
  title                 text not null,
  description           text,
  type                  election_type not null default 'representative',
  office_id             uuid references offices(id),    -- null for referenda
  ballot_type           ballot_type not null default 'single_choice',
  results_visibility    results_visibility not null default 'hidden_until_close',
  eligible_account_types account_type[] not null default '{civilian}',
  require_status_active boolean not null default true,
  opens_at              timestamptz,
  closes_at             timestamptz,
  status                election_status not null default 'draft',
  created_by            uuid references profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index elections_status_idx on elections(status);
create trigger elections_touch before update on elections
  for each row execute function touch_updated_at();

-- Eligible regions: NO rows = the whole nation is eligible.
create table election_regions (
  election_id uuid references elections(id) on delete cascade,
  region_id   uuid references regions(id) on delete cascade,
  primary key (election_id, region_id)
);

-- Every selectable option is a candidate row (a referendum seeds Yes/No rows),
-- so the ballot is uniform regardless of ballot_type.
create table election_candidates (
  id          uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id) on delete cascade,
  user_id     uuid references profiles(id),   -- null for referendum options
  name        text not null,
  description text,
  sort_order  int not null default 0
);
create index election_candidates_election_idx on election_candidates(election_id, sort_order);

-- Sealed ballot: one per voter per election. Secrecy is enforced by RLS below.
create table election_ballots (
  id           uuid primary key default gen_random_uuid(),
  election_id  uuid not null references elections(id) on delete cascade,
  voter_id     uuid not null references profiles(id) on delete cascade,
  candidate_id uuid not null references election_candidates(id),
  cast_at      timestamptz not null default now(),
  unique (election_id, voter_id)
);
create index election_ballots_tally_idx on election_ballots(election_id, candidate_id);

-- =============================================================================
-- Lifecycle graph
-- =============================================================================
create table election_status_transitions (
  from_status election_status not null,
  to_status   election_status not null,
  primary key (from_status, to_status)
);
insert into election_status_transitions (from_status, to_status) values
  ('draft','scheduled'), ('draft','cancelled'),
  ('scheduled','open'), ('scheduled','draft'), ('scheduled','cancelled'),
  ('open','closed'),
  ('closed','certified'), ('closed','cancelled'),
  ('certified','archived')
on conflict do nothing;

create or replace function is_valid_election_transition(p_from election_status, p_to election_status)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from election_status_transitions
                 where from_status = p_from and to_status = p_to);
$$;

-- Status may change only through election_transition() (fairness: no jumping
-- straight from open to certified without closing).
create or replace function guard_election_status()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('app.in_election_transition', true), 'off') <> 'on' then
    raise exception 'Election status must be changed via election_transition()';
  end if;
  return new;
end $$;
create trigger elections_status_guard before update on elections
  for each row execute function guard_election_status();

-- =============================================================================
-- Helpers
-- =============================================================================
create or replace function can_read_election(p_election uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from elections e
    where e.id = p_election
      and (e.status <> 'draft' or e.created_by = auth.uid() or has_permission('elections.manage'))
  );
$$;

-- Eligibility: account type + standing + region. (Note: voting is gated by
-- eligibility, NOT by an office permission — every eligible citizen may vote.)
create or replace function is_eligible_voter(p_election uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from elections e
    join profiles pr on pr.id = auth.uid()
    where e.id = p_election
      and pr.account_type = any (e.eligible_account_types)
      and (not e.require_status_active or pr.status = 'active')
      and (not exists (select 1 from election_regions r where r.election_id = e.id)
           or exists (select 1 from election_regions r
                      where r.election_id = e.id and r.region_id = pr.home_region_id))
  );
$$;

-- =============================================================================
-- Operations
-- =============================================================================
create or replace function cast_election_vote(p_election uuid, p_candidate uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_e elections;
begin
  select * into v_e from elections where id = p_election;
  if not found then raise exception 'Election not found'; end if;
  if v_e.status <> 'open' then raise exception 'This election is not open for voting'; end if;
  if v_e.opens_at is not null and now() < v_e.opens_at then raise exception 'Polls have not opened yet'; end if;
  if v_e.closes_at is not null and now() > v_e.closes_at then raise exception 'Polls have closed'; end if;
  if not is_eligible_voter(p_election) then raise exception 'You are not eligible to vote in this election'; end if;
  if not exists (select 1 from election_candidates c where c.id = p_candidate and c.election_id = p_election) then
    raise exception 'That candidate is not on this ballot';
  end if;

  insert into election_ballots (election_id, voter_id, candidate_id)
  values (p_election, auth.uid(), p_candidate);

  -- audit entry deliberately records THAT the user voted, never the choice
  perform log_action('election.vote', 'election', v_e.public_no, '{}'::jsonb);
exception when unique_violation then
  raise exception 'You have already voted in this election';
end $$;

-- Aggregate results honoring the election's visibility setting. Individual
-- ballots are never returned here.
create or replace function election_results(p_election uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_e elections;
  v_privileged boolean;
  v_total int;
  v_rows jsonb;
begin
  select * into v_e from elections where id = p_election;
  if not found then raise exception 'Election not found'; end if;

  -- managers/admins may always see aggregate tallies (not individual ballots)
  v_privileged := has_permission('elections.manage');

  if not v_privileged and v_e.results_visibility <> 'live_totals'
     and v_e.status not in ('closed','certified','archived') then
    return jsonb_build_object('sealed', true, 'status', v_e.status);
  end if;

  select count(*) into v_total from election_ballots where election_id = p_election;

  select jsonb_agg(jsonb_build_object(
           'candidate_id', c.id, 'name', c.name, 'votes', cnt.n,
           'percent', case when v_total > 0 then round(100.0 * cnt.n / v_total, 1) else 0 end)
           order by c.sort_order)
    into v_rows
  from election_candidates c
  left join lateral (select count(*) n from election_ballots b
                     where b.election_id = p_election and b.candidate_id = c.id) cnt on true
  where c.election_id = p_election;

  -- percentage_only: strip raw counts for non-privileged viewers
  if not v_privileged and v_e.results_visibility = 'percentage_only' then
    select jsonb_agg(elem - 'votes') into v_rows from jsonb_array_elements(coalesce(v_rows,'[]')) elem;
    return jsonb_build_object('results', coalesce(v_rows,'[]'::jsonb), 'status', v_e.status);
  end if;

  return jsonb_build_object('total', v_total, 'results', coalesce(v_rows,'[]'::jsonb), 'status', v_e.status);
end $$;

create or replace function election_transition(p_election uuid, p_to election_status, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_e elections;
begin
  if not has_permission('elections.manage') then raise exception 'Not authorized to manage elections'; end if;
  select * into v_e from elections where id = p_election for update;
  if not found then raise exception 'Election not found'; end if;
  if not is_valid_election_transition(v_e.status, p_to) then
    raise exception 'Invalid transition: % -> %', v_e.status, p_to;
  end if;

  perform set_config('app.in_election_transition', 'on', true);
  update elections
     set status    = p_to,
         public_no = case when p_to = 'scheduled' and public_no is null then next_election_no() else public_no end
   where id = p_election;

  perform log_action('election.' || p_to, 'election', coalesce(v_e.public_no, v_e.id::text),
                     jsonb_build_object('from', v_e.status, 'to', p_to));
end $$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table elections                    enable row level security;
alter table election_regions             enable row level security;
alter table election_candidates          enable row level security;
alter table election_ballots             enable row level security;
alter table election_status_transitions  enable row level security;

create policy elections_read on elections for select to authenticated
  using (status <> 'draft' or created_by = auth.uid() or has_permission('elections.manage'));
create policy elections_write on elections for all to authenticated
  using (has_permission('elections.manage')) with check (has_permission('elections.manage'));

create policy election_regions_read on election_regions for select to authenticated
  using (can_read_election(election_id));
create policy election_regions_write on election_regions for all to authenticated
  using (has_permission('elections.manage')) with check (has_permission('elections.manage'));

create policy candidates_read on election_candidates for select to authenticated
  using (can_read_election(election_id));
create policy candidates_write on election_candidates for all to authenticated
  using (has_permission('elections.manage')) with check (has_permission('elections.manage'));

-- Ballot secrecy: only the voter or an EXPLICIT elections.audit holder may read a
-- ballot row (generic admin is NOT enough). Writes happen only via cast_election_vote().
create policy ballots_read on election_ballots for select to authenticated
  using (voter_id = auth.uid() or has_explicit_permission('elections.audit'));

create policy election_transitions_read on election_status_transitions for select to authenticated using (true);
create policy election_transitions_write on election_status_transitions for all to authenticated
  using (is_admin()) with check (is_admin());

-- =============================================================================
-- Seed: one referendum in draft, with Yes/No options.
-- =============================================================================
insert into elections (title, description, type, ballot_type, results_visibility)
values ('Referendum on the National Motto',
        'Shall the proposed national motto be adopted?',
        'referendum', 'yes_no', 'hidden_until_close')
on conflict do nothing;

insert into election_candidates (election_id, name, sort_order)
select e.id, v.name, v.ord
from elections e
join (values ('Yes', 1), ('No', 2)) as v(name, ord) on true
where e.title = 'Referendum on the National Motto'
on conflict do nothing;
