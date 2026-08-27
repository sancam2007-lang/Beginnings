-- =============================================================================
-- Beginnings — 0006_aurors.sql
-- Phase 6: the Auror agency — agent profiles with clearance, a classification-
-- gated mission board, briefing/debrief packets, and contracts.
--
-- Clearance is the whole point here: a mission carries a classification_level
-- (from 0002), an auror carries a clearance, and can_read_mission() compares
-- them so a low-clearance agent never learns a secret mission exists. Officers
-- (missions.create / missions.assign) and assigned members see past that gate.
--
-- Contracts are NOT a bespoke table — they are document_submissions of kind
-- 'contract' on the Phase-2 engine (a template is seeded below).
-- =============================================================================

-- Permission for managing the auror roster / clearance / discipline (distinct
-- from mission operations).
insert into permissions (key, category, label) values
  ('aurors.manage', 'Aurors', 'Manage auror roster, clearance & discipline')
on conflict do nothing;

-- Give the Ministry of Defense the roster-management power too.
insert into office_permissions (office_id, permission_key)
select o.id, 'aurors.manage' from offices o where o.code = 'DEFENSE'
on conflict do nothing;

-- =============================================================================
-- Enums
-- =============================================================================
create type mission_status as enum (
  'draft','available','assigned','active','awaiting_debrief',
  'completed','failed','cancelled','classified','archived'
);
create type mission_enrollment as enum ('open','application','assigned','invitation');
create type mission_member_state as enum ('applied','assigned','active','withdrawn','completed');

-- Agent numbering (AGT-000012); missions numbered AUR-YEAR-NNN.
create sequence auror_id_seq;
create sequence mission_no_seq;
create or replace function next_mission_no()
returns text language sql security definer set search_path = public as $$
  select 'AUR-' || gov_year() || '-' || lpad(nextval('mission_no_seq')::text, 3, '0');
$$;

-- =============================================================================
-- Auror profiles + record
-- =============================================================================
create table auror_profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid unique not null references profiles(id) on delete cascade,
  public_no      text unique not null default format_public_id('AGT', nextval('auror_id_seq')),
  rank           text,
  specialization text,
  clearance      classification_level not null default 'official',
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger auror_profiles_touch before update on auror_profiles
  for each row execute function touch_updated_at();

create table auror_commendations (
  id            uuid primary key default gen_random_uuid(),
  auror_user_id uuid not null references profiles(id) on delete cascade,
  issued_by     uuid references profiles(id),
  title         text not null,
  note          text,
  created_at    timestamptz not null default now()
);

create table auror_disciplinary (
  id            uuid primary key default gen_random_uuid(),
  auror_user_id uuid not null references profiles(id) on delete cascade,
  issued_by     uuid references profiles(id),
  note          text not null,
  created_at    timestamptz not null default now()
);

-- =============================================================================
-- Missions
-- =============================================================================
create table missions (
  id                uuid primary key default gen_random_uuid(),
  public_no         text unique,                -- assigned when made available
  title             text not null,
  description       text,
  location          text,
  region_id         uuid references regions(id),
  issuing_office_id uuid references offices(id),
  classification    classification_level not null default 'official',
  difficulty        text,
  recommended_party_size int,
  reward            text,
  deadline          timestamptz,
  prerequisites     text,
  enrollment_mode   mission_enrollment not null default 'open',
  available_slots   int,
  status            mission_status not null default 'draft',
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index missions_status_idx on missions(status);
create index missions_classification_idx on missions(classification);
create trigger missions_touch before update on missions
  for each row execute function touch_updated_at();

create table mission_members (
  id         uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('member','lead')),
  state      mission_member_state not null default 'assigned',
  joined_at  timestamptz not null default now(),
  unique (mission_id, user_id)
);
create index mission_members_mission_idx on mission_members(mission_id);
create index mission_members_user_idx on mission_members(user_id);

create table mission_briefings (
  mission_id      uuid primary key references missions(id) on delete cascade,
  summary         text,
  intelligence    text,
  objectives      text,
  classified_notes text,
  updated_by      uuid references profiles(id),
  updated_at      timestamptz not null default now()
);
create trigger mission_briefings_touch before update on mission_briefings
  for each row execute function touch_updated_at();

create table mission_debriefs (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references missions(id) on delete cascade,
  author_id      uuid not null references profiles(id) on delete cascade,
  report         text,
  outcome        text,
  objective_status text,
  casualties     text,
  injuries       text,
  discovered_info text,
  observations   text,
  success        boolean,
  grade          text,
  remarks        text,
  graded_by      uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (mission_id, author_id)
);
create trigger mission_debriefs_touch before update on mission_debriefs
  for each row execute function touch_updated_at();

create table mission_attachments (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references missions(id) on delete cascade,
  storage_path   text not null,
  file_name      text not null,
  mime_type      text,
  size_bytes     bigint,
  classification classification_level not null default 'official',
  uploaded_by    uuid references profiles(id),
  created_at     timestamptz not null default now()
);
create index mission_attachments_mission_idx on mission_attachments(mission_id);

-- =============================================================================
-- Lifecycle graph
-- =============================================================================
create table mission_status_transitions (
  from_status mission_status not null,
  to_status   mission_status not null,
  primary key (from_status, to_status)
);
insert into mission_status_transitions (from_status, to_status) values
  ('draft','available'), ('draft','classified'), ('draft','cancelled'),
  ('available','assigned'), ('available','active'), ('available','cancelled'), ('available','classified'),
  ('assigned','active'), ('assigned','available'), ('assigned','cancelled'),
  ('active','awaiting_debrief'), ('active','failed'), ('active','cancelled'),
  ('awaiting_debrief','completed'), ('awaiting_debrief','failed'),
  ('completed','archived'), ('failed','archived'), ('cancelled','archived'),
  ('classified','available'), ('classified','archived')
on conflict do nothing;

create or replace function is_valid_mission_transition(p_from mission_status, p_to mission_status)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from mission_status_transitions
                 where from_status = p_from and to_status = p_to);
$$;

-- =============================================================================
-- Clearance + visibility helpers
-- =============================================================================
create or replace function current_clearance()
returns classification_level language sql stable security definer set search_path = public as $$
  select coalesce((select clearance from auror_profiles
                   where user_id = auth.uid() and is_active), 'public'::classification_level);
$$;

create or replace function is_mission_officer()
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('missions.create') or has_permission('missions.assign');
$$;

-- Visible if: you're an officer; you're on the mission; or it's available and
-- your clearance meets its classification. Draft/classified/archived stay hidden.
create or replace function can_read_mission(p_mission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from missions m
    where m.id = p_mission
      and (is_mission_officer()
           or exists (select 1 from mission_members mm
                      where mm.mission_id = m.id and mm.user_id = auth.uid())
           or (m.status = 'available' and current_clearance() >= m.classification))
  );
$$;

-- Derived service record for an auror.
create or replace function auror_record(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'completed', count(*) filter (where m.status = 'completed'),
    'failed',    count(*) filter (where m.status = 'failed'),
    'active',    count(*) filter (where m.status in ('assigned','active','awaiting_debrief','available')),
    'total',     count(*))
  from mission_members mm join missions m on m.id = mm.mission_id
  where mm.user_id = p_user and mm.state <> 'withdrawn';
$$;

-- =============================================================================
-- Operations
-- =============================================================================
create or replace function join_mission(p_mission uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_m missions; v_taken int;
begin
  select * into v_m from missions where id = p_mission;
  if not found then raise exception 'Mission not found'; end if;
  if not exists (select 1 from auror_profiles a where a.user_id = auth.uid() and a.is_active) then
    raise exception 'Only active aurors may take missions';
  end if;
  if v_m.status <> 'available' then raise exception 'This mission is not open for enrollment'; end if;
  if v_m.enrollment_mode <> 'open' then raise exception 'This mission is not open enrollment'; end if;
  if current_clearance() < v_m.classification then raise exception 'Insufficient clearance for this mission'; end if;
  if v_m.available_slots is not null then
    select count(*) into v_taken from mission_members
      where mission_id = p_mission and state in ('assigned','active');
    if v_taken >= v_m.available_slots then raise exception 'This mission is full'; end if;
  end if;

  insert into mission_members (mission_id, user_id, state)
  values (p_mission, auth.uid(), 'assigned')
  on conflict (mission_id, user_id) do nothing;
  perform log_action('mission.join', 'mission', v_m.public_no, '{}'::jsonb);
end $$;

create or replace function apply_mission(p_mission uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_m missions;
begin
  select * into v_m from missions where id = p_mission;
  if not found then raise exception 'Mission not found'; end if;
  if not exists (select 1 from auror_profiles a where a.user_id = auth.uid() and a.is_active) then
    raise exception 'Only active aurors may apply';
  end if;
  if v_m.status <> 'available' then raise exception 'This mission is not accepting applications'; end if;
  if v_m.enrollment_mode <> 'application' then raise exception 'This mission is not application-based'; end if;
  if current_clearance() < v_m.classification then raise exception 'Insufficient clearance for this mission'; end if;

  insert into mission_members (mission_id, user_id, state)
  values (p_mission, auth.uid(), 'applied')
  on conflict (mission_id, user_id) do nothing;
  perform log_action('mission.apply', 'mission', v_m.public_no, '{}'::jsonb);
end $$;

create or replace function withdraw_mission(p_mission uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_m missions;
begin
  select * into v_m from missions where id = p_mission;
  if not found then raise exception 'Mission not found'; end if;
  if v_m.status not in ('available','assigned') then
    raise exception 'You can no longer withdraw from this mission';
  end if;
  update mission_members set state = 'withdrawn'
    where mission_id = p_mission and user_id = auth.uid();
  perform log_action('mission.withdraw', 'mission', v_m.public_no, '{}'::jsonb);
end $$;

-- Officer manually assigns/invites an auror (checks the assignee's clearance).
create or replace function assign_auror(p_mission uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_m missions; v_cl classification_level;
begin
  if not has_permission('missions.assign') then raise exception 'Not authorized to assign missions'; end if;
  select * into v_m from missions where id = p_mission;
  if not found then raise exception 'Mission not found'; end if;
  select coalesce((select clearance from auror_profiles where user_id = p_user and is_active),
                  'public'::classification_level) into v_cl;
  if v_cl < v_m.classification then raise exception 'Assignee lacks the required clearance'; end if;

  insert into mission_members (mission_id, user_id, state)
  values (p_mission, p_user, 'assigned')
  on conflict (mission_id, user_id) do update set state = 'assigned';
  perform log_action('mission.assign', 'mission', v_m.public_no,
                     jsonb_build_object('assignee', p_user));
end $$;

create or replace function mission_transition(p_mission uuid, p_to mission_status, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_m missions;
begin
  if not is_mission_officer() then raise exception 'Not authorized to change mission status'; end if;
  select * into v_m from missions where id = p_mission for update;
  if not found then raise exception 'Mission not found'; end if;
  if not is_valid_mission_transition(v_m.status, p_to) then
    raise exception 'Invalid transition: % -> %', v_m.status, p_to;
  end if;

  update missions
     set status    = p_to,
         public_no = case when p_to = 'available' and public_no is null then next_mission_no() else public_no end
   where id = p_mission;

  perform log_action('mission.' || p_to, 'mission', coalesce(v_m.public_no, v_m.id::text),
                     jsonb_build_object('from', v_m.status, 'to', p_to, 'comment', p_comment));
end $$;

-- Classifying at confidential/secret requires the missions.classify permission.
create or replace function guard_mission_classification()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.classification is distinct from old.classification)
     and new.classification in ('confidential','secret')
     and not has_permission('missions.classify') then
    raise exception 'Classifying a mission requires the missions.classify permission';
  end if;
  return new;
end $$;
create trigger missions_classify_guard before insert or update on missions
  for each row execute function guard_mission_classification();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table auror_profiles             enable row level security;
alter table auror_commendations        enable row level security;
alter table auror_disciplinary         enable row level security;
alter table missions                   enable row level security;
alter table mission_members            enable row level security;
alter table mission_briefings          enable row level security;
alter table mission_debriefs           enable row level security;
alter table mission_attachments        enable row level security;
alter table mission_status_transitions enable row level security;

-- Auror profiles: self + roster managers/officers read; only aurors.manage writes
-- (clearance and rank are assigned, never self-set).
create policy auror_read on auror_profiles for select to authenticated
  using (user_id = auth.uid() or is_mission_officer() or has_permission('aurors.manage'));
create policy auror_write on auror_profiles for all to authenticated
  using (has_permission('aurors.manage')) with check (has_permission('aurors.manage'));

create policy commend_read on auror_commendations for select to authenticated
  using (auror_user_id = auth.uid() or is_mission_officer() or has_permission('aurors.manage'));
create policy commend_write on auror_commendations for all to authenticated
  using (has_permission('aurors.manage')) with check (has_permission('aurors.manage'));

create policy discipline_read on auror_disciplinary for select to authenticated
  using (auror_user_id = auth.uid() or has_permission('aurors.manage'));
create policy discipline_write on auror_disciplinary for all to authenticated
  using (has_permission('aurors.manage')) with check (has_permission('aurors.manage'));

-- Missions: clearance-gated read; officers create/edit. Classification guarded
-- by trigger; status normally moved via mission_transition().
create policy missions_read on missions for select to authenticated
  using (can_read_mission(id));
create policy missions_insert on missions for insert to authenticated
  with check (has_permission('missions.create'));
create policy missions_update on missions for update to authenticated
  using (is_mission_officer()) with check (is_mission_officer());
create policy missions_delete on missions for delete to authenticated
  using (has_permission('missions.create'));

-- Mission members: officers, yourself, and co-members (to see the party).
create policy members_read on mission_members for select to authenticated
  using (has_permission('missions.assign') or user_id = auth.uid()
         or exists (select 1 from mission_members me
                    where me.mission_id = mission_members.mission_id and me.user_id = auth.uid()));
create policy members_officer_write on mission_members for all to authenticated
  using (has_permission('missions.assign')) with check (has_permission('missions.assign'));

-- Briefings + intelligence: readable to anyone who can read the mission; officers write.
create policy briefing_read on mission_briefings for select to authenticated
  using (can_read_mission(mission_id));
create policy briefing_write on mission_briefings for all to authenticated
  using (is_mission_officer()) with check (is_mission_officer());

-- Intelligence attachments additionally gate on the file's own classification.
create policy mission_att_read on mission_attachments for select to authenticated
  using (can_read_mission(mission_id)
         and (is_mission_officer() or current_clearance() >= classification));
create policy mission_att_write on mission_attachments for all to authenticated
  using (is_mission_officer()) with check (is_mission_officer());

-- Debriefs: author writes their own while un-graded; officers read all and grade.
create policy debrief_read on mission_debriefs for select to authenticated
  using (author_id = auth.uid() or has_permission('missions.assign'));
create policy debrief_author_insert on mission_debriefs for insert to authenticated
  with check (author_id = auth.uid()
              and exists (select 1 from mission_members mm
                          where mm.mission_id = mission_debriefs.mission_id
                            and mm.user_id = auth.uid())
              and exists (select 1 from missions m
                          where m.id = mission_debriefs.mission_id
                            and m.status in ('active','awaiting_debrief')));
create policy debrief_author_update on mission_debriefs for update to authenticated
  using (author_id = auth.uid() and graded_by is null)
  with check (author_id = auth.uid() and graded_by is null);
create policy debrief_officer_update on mission_debriefs for update to authenticated
  using (has_permission('missions.assign')) with check (has_permission('missions.assign'));

create policy mission_transitions_read on mission_status_transitions for select to authenticated using (true);
create policy mission_transitions_write on mission_status_transitions for all to authenticated
  using (is_admin()) with check (is_admin());

-- =============================================================================
-- Seed: an Auror Service Contract template (reuses the document engine) and a
-- draft mission.
-- =============================================================================
insert into document_templates (code, kind, name, description, department, numbering_prefix,
                                approval_permission, applicant_account_types)
values ('AUROR_CONTRACT', 'contract', 'Auror Service Contract',
        'A government service contract engaged by an auror.',
        'Ministry of Defense', 'CTR', 'documents.approve', '{auror}')
on conflict do nothing;

insert into document_template_fields (template_id, key, label, field_type, required, sort_order)
select t.id, v.key, v.label, v.ftype::field_type, v.req, v.ord
from document_templates t
join (values
  ('service','Service Engaged','long_text', true, 1),
  ('payment','Payment / Reward','currency', true, 2),
  ('terms','Terms','long_text', true, 3),
  ('duration','Duration','text', false, 4),
  ('signature','Signature','signature', true, 5)
) as v(key,label,ftype,req,ord) on true
where t.code = 'AUROR_CONTRACT'
on conflict do nothing;

insert into missions (title, description, location, classification, difficulty,
                      recommended_party_size, reward, enrollment_mode, available_slots,
                      issuing_office_id, created_by, status)
select 'Investigate the Harbor Disturbances',
       'Reports of smuggling activity along the eastern docks require discreet inquiry.',
       'Eastern Docks', 'official', 'Moderate', 3, '500 ¤', 'open', 4,
       (select id from offices where code = 'DEFENSE'),
       (select id from profiles where account_type = 'admin' order by registered_at limit 1),
       'draft'
on conflict do nothing;
