-- =============================================================================
-- Beginnings — 0003_legislation.sql
-- Phase 3: the parliamentary system — bills, co-sponsors, amendments, and
-- server-validated voting with an immutable, public roll-call ledger.
--
-- Reuses the Phase-1 permission engine (bills.create / bills.edit_own /
-- bills.vote / bills.manage) and mirrors the document engine's shape: a
-- data-driven status graph + one guarded transition function.
--
-- Parliamentary votes are PUBLIC roll call by design (transparency), which is
-- the deliberate opposite of the secret citizen ballots coming in 0004.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type bill_status as enum (
  'draft','introduced','committee_review','debate','voting',
  'passed','rejected','executive_review','enacted','vetoed','withdrawn','archived'
);

create type vote_choice as enum ('yea','nay','abstain');

-- -----------------------------------------------------------------------------
-- Bill numbering  (BILL-YEAR-NNN, e.g. BILL-1892-014)
-- -----------------------------------------------------------------------------
create sequence bill_no_seq;

create or replace function next_bill_no()
returns text language sql security definer set search_path = public as $$
  select 'BILL-' || gov_year() || '-' || lpad(nextval('bill_no_seq')::text, 3, '0');
$$;

-- =============================================================================
-- Tables
-- =============================================================================
create table bills (
  id              uuid primary key default gen_random_uuid(),
  public_no       text unique,               -- assigned on introduction
  title           text not null,
  summary         text,
  body            text,
  author_id       uuid not null references profiles(id) on delete cascade,
  committee       text,
  session         text,
  status          bill_status not null default 'draft',
  introduced_at   timestamptz,
  voting_opens_at timestamptz,
  voting_deadline timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index bills_status_idx on bills(status);
create index bills_author_idx on bills(author_id);
create trigger bills_touch before update on bills
  for each row execute function touch_updated_at();

create table bill_sponsors (
  bill_id  uuid not null references bills(id) on delete cascade,
  user_id  uuid not null references profiles(id) on delete cascade,
  role     text not null default 'cosponsor' check (role in ('author','cosponsor')),
  added_at timestamptz not null default now(),
  primary key (bill_id, user_id)
);

create table bill_amendments (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references bills(id) on delete cascade,
  seq         int not null default 1,
  proposed_by uuid references profiles(id),
  text        text not null,
  status      text not null default 'proposed'
                check (status in ('proposed','adopted','rejected','withdrawn')),
  created_at  timestamptz not null default now()
);
create index bill_amendments_bill_idx on bill_amendments(bill_id);

-- One ballot per legislator per bill (data-level duplicate prevention).
create table bill_votes (
  id       uuid primary key default gen_random_uuid(),
  bill_id  uuid not null references bills(id) on delete cascade,
  voter_id uuid not null references profiles(id) on delete cascade,
  choice   vote_choice not null,
  cast_at  timestamptz not null default now(),
  unique (bill_id, voter_id)
);
create index bill_votes_bill_idx on bill_votes(bill_id);

-- Immutable legislative history (append-only: no update/delete policy).
create table bill_status_events (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references bills(id) on delete cascade,
  actor_id    uuid references profiles(id),
  from_status bill_status,
  to_status   bill_status not null,
  comment     text,
  created_at  timestamptz not null default now()
);
create index bill_status_events_bill_idx on bill_status_events(bill_id, created_at);

create table bill_attachments (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references bills(id) on delete cascade,
  storage_path text not null,
  file_name   text not null,
  mime_type   text,
  size_bytes  bigint,
  uploaded_by uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);

-- =============================================================================
-- Status graph (data-driven, admin-inspectable)
-- =============================================================================
create table bill_status_transitions (
  from_status bill_status not null,
  to_status   bill_status not null,
  primary key (from_status, to_status)
);

insert into bill_status_transitions (from_status, to_status) values
  ('draft','introduced'), ('draft','withdrawn'),
  ('introduced','committee_review'), ('introduced','debate'), ('introduced','withdrawn'),
  ('committee_review','debate'), ('committee_review','rejected'), ('committee_review','withdrawn'),
  ('debate','voting'), ('debate','committee_review'), ('debate','withdrawn'),
  ('voting','passed'), ('voting','rejected'),
  ('passed','executive_review'), ('passed','enacted'), ('passed','archived'),
  ('executive_review','enacted'), ('executive_review','vetoed'),
  ('rejected','archived'), ('rejected','draft'),
  ('vetoed','archived'), ('vetoed','debate'),
  ('enacted','archived'), ('withdrawn','archived')
on conflict do nothing;

create or replace function is_valid_bill_transition(p_from bill_status, p_to bill_status)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from bill_status_transitions
                 where from_status = p_from and to_status = p_to);
$$;

-- =============================================================================
-- Helpers + operations
-- =============================================================================
-- A bill is visible if it has left draft, or you authored it, or you manage bills.
create or replace function can_read_bill(p_bill uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from bills b
    where b.id = p_bill
      and (b.status <> 'draft' or b.author_id = auth.uid() or has_permission('bills.manage'))
  );
$$;

-- Live tally (yea / nay / abstain / total) for the roll-call ledger.
create or replace function bill_tally(p_bill uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'yea',     count(*) filter (where choice = 'yea'),
    'nay',     count(*) filter (where choice = 'nay'),
    'abstain', count(*) filter (where choice = 'abstain'),
    'total',   count(*))
  from bill_votes where bill_id = p_bill;
$$;

-- The single entry point for casting a ballot. Enforces permission, open window,
-- and one-ballot-per-voter; a voter may change their choice while voting is open.
create or replace function cast_bill_vote(p_bill uuid, p_choice vote_choice)
returns void language plpgsql security definer set search_path = public as $$
declare v_bill bills;
begin
  if not has_permission('bills.vote') then
    raise exception 'Not authorized to vote';
  end if;
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'voting' then raise exception 'This bill is not open for voting'; end if;
  if v_bill.voting_opens_at is not null and now() < v_bill.voting_opens_at then
    raise exception 'Voting has not opened yet';
  end if;
  if v_bill.voting_deadline is not null and now() > v_bill.voting_deadline then
    raise exception 'Voting has closed';
  end if;

  insert into bill_votes (bill_id, voter_id, choice)
  values (p_bill, auth.uid(), p_choice)
  on conflict (bill_id, voter_id) do update set choice = excluded.choice, cast_at = now();

  perform log_action('bill.vote', 'bill', v_bill.public_no,
                     jsonb_build_object('choice', p_choice));
end $$;

-- The single entry point for moving a bill through its lifecycle.
create or replace function bill_transition(p_bill uuid, p_to bill_status, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_bill bills;
begin
  select * into v_bill from bills where id = p_bill for update;
  if not found then raise exception 'Bill not found'; end if;

  -- authorization: authors may introduce/withdraw their own; all else needs bills.manage.
  if p_to in ('introduced','withdrawn') and v_bill.author_id = auth.uid()
     and has_permission('bills.create') then
    null;  -- author acting on own bill
  elsif not has_permission('bills.manage') then
    raise exception 'Not authorized to change this bill''s status';
  end if;

  if not is_valid_bill_transition(v_bill.status, p_to) then
    raise exception 'Invalid transition: % -> %', v_bill.status, p_to;
  end if;

  update bills
     set status        = p_to,
         public_no     = case when p_to = 'introduced' and public_no is null
                              then next_bill_no() else public_no end,
         introduced_at = case when p_to = 'introduced' and introduced_at is null
                              then now() else introduced_at end
   where id = p_bill;

  -- record the author as a sponsor once the bill is introduced
  if p_to = 'introduced' then
    insert into bill_sponsors (bill_id, user_id, role)
    values (p_bill, v_bill.author_id, 'author')
    on conflict do nothing;
  end if;

  insert into bill_status_events (bill_id, actor_id, from_status, to_status, comment)
  values (p_bill, auth.uid(), v_bill.status, p_to, p_comment);

  perform log_action('bill.' || p_to, 'bill', coalesce(v_bill.public_no, v_bill.id::text),
                     jsonb_build_object('from', v_bill.status, 'to', p_to,
                                        'tally', bill_tally(p_bill)));
end $$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table bills                   enable row level security;
alter table bill_sponsors           enable row level security;
alter table bill_amendments         enable row level security;
alter table bill_votes              enable row level security;
alter table bill_status_events      enable row level security;
alter table bill_attachments        enable row level security;
alter table bill_status_transitions enable row level security;

-- Bills: public once past draft; drafts to author + managers. Authors edit own
-- drafts; managers may correct. Status only moves through bill_transition().
create policy bills_read on bills for select to authenticated
  using (status <> 'draft' or author_id = auth.uid() or has_permission('bills.manage'));
create policy bills_insert on bills for insert to authenticated
  with check (author_id = auth.uid() and status = 'draft' and has_permission('bills.create'));
create policy bills_update_author on bills for update to authenticated
  using (author_id = auth.uid() and status = 'draft' and has_permission('bills.edit_own'))
  with check (author_id = auth.uid() and status = 'draft');
create policy bills_update_manage on bills for update to authenticated
  using (has_permission('bills.manage')) with check (has_permission('bills.manage'));
create policy bills_delete_author on bills for delete to authenticated
  using (author_id = auth.uid() and status = 'draft');

-- Sponsors: visible with the bill; a legislator may co-sponsor themselves, and
-- authors/managers may manage the list.
create policy sponsors_read on bill_sponsors for select to authenticated
  using (can_read_bill(bill_id));
create policy sponsors_self on bill_sponsors for insert to authenticated
  with check (user_id = auth.uid() and has_permission('bills.create') and can_read_bill(bill_id));
create policy sponsors_manage on bill_sponsors for all to authenticated
  using (has_permission('bills.manage')) with check (has_permission('bills.manage'));

-- Amendments: visible with the bill; proposable by legislators; managed by managers.
create policy amend_read on bill_amendments for select to authenticated
  using (can_read_bill(bill_id));
create policy amend_propose on bill_amendments for insert to authenticated
  with check (proposed_by = auth.uid() and has_permission('bills.create') and can_read_bill(bill_id));
create policy amend_manage on bill_amendments for all to authenticated
  using (has_permission('bills.manage')) with check (has_permission('bills.manage'));

-- Votes: PUBLIC roll call (read to all). Writes only via cast_bill_vote().
create policy votes_read on bill_votes for select to authenticated
  using (can_read_bill(bill_id));

-- Legislative history: readable with the bill; writes only via bill_transition().
create policy bill_events_read on bill_status_events for select to authenticated
  using (can_read_bill(bill_id));

-- Attachments: visible with the bill; authors attach to their own drafts.
create policy bill_att_read on bill_attachments for select to authenticated
  using (can_read_bill(bill_id));
create policy bill_att_write on bill_attachments for all to authenticated
  using (uploaded_by = auth.uid()
         and exists (select 1 from bills b where b.id = bill_id
                     and b.author_id = auth.uid() and b.status = 'draft'))
  with check (uploaded_by = auth.uid()
         and exists (select 1 from bills b where b.id = bill_id
                     and b.author_id = auth.uid() and b.status = 'draft'));

create policy bill_transitions_read on bill_status_transitions for select to authenticated using (true);
create policy bill_transitions_write on bill_status_transitions for all to authenticated
  using (is_admin()) with check (is_admin());

-- =============================================================================
-- Seed: one example bill so the ledger is exercisable.
-- =============================================================================
insert into bills (title, summary, body, author_id, committee, status)
select 'National Records Modernization Act',
       'Establishes a unified registry for government documents.',
       'BE IT ENACTED — Section 1. A unified national records office is established…',
       p.id, 'Committee on Administration', 'draft'
from profiles p
where p.account_type in ('admin','politician')
order by p.registered_at
limit 1
on conflict do nothing;
