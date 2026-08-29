-- =============================================================================
-- Beginnings — 0007_correspondence_events_notifications.sql
-- Phase 7: the cross-cutting layer that ties the government together.
--
--   * Correspondence — formal letters addressed to a representative or an office,
--     with reply threads, per-user read/archive state, and attachments.
--   * Events — national happenings with severity, affected regions, and private
--     administrative notes.
--   * Announcements — audience-scoped notices (national / regional / ministry /
--     company / auror / political / internal).
--   * Notifications — an internal inbox, populated by triggers that fire from the
--     document, mission, and correspondence systems built earlier.
--   * Selective Realtime for the three things worth pushing live.
-- =============================================================================

insert into permissions (key, category, label) values
  ('announcements.manage', 'Administration', 'Publish & manage announcements')
on conflict do nothing;

-- Give the general Administration office announcement authority.
insert into office_permissions (office_id, permission_key)
select o.id, 'announcements.manage' from offices o where o.code = 'ADMIN'
on conflict do nothing;

-- Shared helper: is the current user an active member of a given office?
create or replace function is_office_member_of(p_office uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_office is not null and exists (
    select 1 from office_members m
    where m.office_id = p_office and m.user_id = auth.uid() and m.is_active);
$$;

-- =============================================================================
-- Notifications  (+ notify() used by triggers throughout this file)
-- =============================================================================
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  link_type  text,
  link_id    text,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications(user_id, is_read, created_at desc);

create or replace function notify(p_user uuid, p_kind text, p_title text,
  p_body text default null, p_link_type text default null, p_link_id text default null)
returns void language sql security definer set search_path = public as $$
  insert into notifications (user_id, kind, title, body, link_type, link_id)
  values (p_user, p_kind, p_title, p_body, p_link_type, p_link_id);
$$;

alter table notifications enable row level security;
create policy notif_read on notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notif_delete on notifications for delete to authenticated using (user_id = auth.uid());
-- inserts happen only through notify() (security definer) — no client insert policy.

-- =============================================================================
-- Correspondence
-- =============================================================================
create sequence correspondence_no_seq;
create or replace function next_correspondence_no()
returns text language sql security definer set search_path = public as $$
  select 'LTR-' || gov_year() || '-' || lpad(nextval('correspondence_no_seq')::text, 4, '0');
$$;

create table correspondence_threads (
  id              uuid primary key default gen_random_uuid(),
  public_no       text unique not null default next_correspondence_no(),
  subject         text not null,
  sender_id       uuid not null references profiles(id) on delete cascade,
  to_user_id      uuid references profiles(id),
  to_office_id    uuid references offices(id),
  region_id       uuid references regions(id),
  category        text,             -- representative / governor / mayor / ministry / department
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  check (to_user_id is not null or to_office_id is not null)
);
create index corr_threads_sender_idx on correspondence_threads(sender_id);
create index corr_threads_touser_idx on correspondence_threads(to_user_id);
create index corr_threads_office_idx on correspondence_threads(to_office_id);

create table correspondence_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references correspondence_threads(id) on delete cascade,
  sender_id   uuid not null references profiles(id) on delete cascade,
  body        text not null,
  is_official boolean not null default false,
  created_at  timestamptz not null default now()
);
create index corr_messages_thread_idx on correspondence_messages(thread_id, created_at);

create table correspondence_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references correspondence_messages(id) on delete cascade,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references profiles(id),
  created_at   timestamptz not null default now()
);

-- Per-user read + archive state.
create table correspondence_reads (
  thread_id    uuid references correspondence_threads(id) on delete cascade,
  user_id      uuid references profiles(id) on delete cascade,
  last_read_at timestamptz,
  archived     boolean not null default false,
  primary key (thread_id, user_id)
);

create or replace function can_access_thread(p_thread uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from correspondence_threads t
    where t.id = p_thread
      and (t.sender_id = auth.uid() or t.to_user_id = auth.uid()
           or is_office_member_of(t.to_office_id)));
$$;

-- On each message: enforce that only the recipient side posts "official" replies,
-- bump the thread, and notify the other party.
create or replace function on_correspondence_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_thread correspondence_threads;
begin
  select * into v_thread from correspondence_threads where id = new.thread_id;

  if new.is_official
     and not (v_thread.to_user_id = new.sender_id or is_office_member_of(v_thread.to_office_id)) then
    raise exception 'Only the recipient office or representative may post an official reply';
  end if;

  update correspondence_threads set last_message_at = now() where id = new.thread_id;

  if new.sender_id = v_thread.sender_id then
    if v_thread.to_user_id is not null and v_thread.to_user_id <> new.sender_id then
      perform notify(v_thread.to_user_id, 'correspondence', 'New correspondence',
                     v_thread.subject, 'thread', v_thread.id::text);
    end if;
  else
    perform notify(v_thread.sender_id, 'correspondence', 'Reply received',
                   v_thread.subject, 'thread', v_thread.id::text);
  end if;
  return new;
end $$;
create trigger correspondence_message_after after insert on correspondence_messages
  for each row execute function on_correspondence_message();

alter table correspondence_threads     enable row level security;
alter table correspondence_messages    enable row level security;
alter table correspondence_attachments enable row level security;
alter table correspondence_reads       enable row level security;

create policy threads_read on correspondence_threads for select to authenticated
  using (can_access_thread(id));
create policy threads_insert on correspondence_threads for insert to authenticated
  with check (sender_id = auth.uid());

create policy messages_read on correspondence_messages for select to authenticated
  using (can_access_thread(thread_id));
create policy messages_insert on correspondence_messages for insert to authenticated
  with check (sender_id = auth.uid() and can_access_thread(thread_id));

create policy corr_att_read on correspondence_attachments for select to authenticated
  using (exists (select 1 from correspondence_messages m
                 where m.id = message_id and can_access_thread(m.thread_id)));
create policy corr_att_write on correspondence_attachments for all to authenticated
  using (uploaded_by = auth.uid()
         and exists (select 1 from correspondence_messages m
                     where m.id = message_id and m.sender_id = auth.uid()))
  with check (uploaded_by = auth.uid()
         and exists (select 1 from correspondence_messages m
                     where m.id = message_id and m.sender_id = auth.uid()));

create policy reads_own on correspondence_reads for all to authenticated
  using (user_id = auth.uid() and can_access_thread(thread_id))
  with check (user_id = auth.uid() and can_access_thread(thread_id));

-- =============================================================================
-- Events
-- =============================================================================
create type event_severity as enum ('minor','moderate','severe','critical');
create type event_status   as enum ('draft','active','concluded','cancelled');

create sequence event_no_seq;
create or replace function next_event_no()
returns text language sql security definer set search_path = public as $$
  select 'EVT-' || gov_year() || '-' || lpad(nextval('event_no_seq')::text, 3, '0');
$$;

create table events (
  id            uuid primary key default gen_random_uuid(),
  public_no     text unique not null default next_event_no(),
  title         text not null,
  category      text,
  description   text,
  severity      event_severity not null default 'moderate',
  is_public     boolean not null default true,
  affected_account_types account_type[],   -- null = everyone
  starts_at     timestamptz,
  ends_at       timestamptz,
  status        event_status not null default 'draft',
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger events_touch before update on events
  for each row execute function touch_updated_at();

create table event_regions (
  event_id  uuid references events(id) on delete cascade,
  region_id uuid references regions(id) on delete cascade,
  primary key (event_id, region_id)
);

create table event_missions (
  event_id   uuid references events(id) on delete cascade,
  mission_id uuid references missions(id) on delete cascade,
  primary key (event_id, mission_id)
);

-- Private administrative notes, kept out of the public event row entirely.
create table event_notes (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events(id) on delete cascade,
  author_id  uuid references profiles(id),
  note       text not null,
  created_at timestamptz not null default now()
);

alter table events         enable row level security;
alter table event_regions  enable row level security;
alter table event_missions enable row level security;
alter table event_notes    enable row level security;

create policy events_read on events for select to authenticated
  using ((status <> 'draft' and is_public) or has_permission('events.manage'));
create policy events_write on events for all to authenticated
  using (has_permission('events.manage')) with check (has_permission('events.manage'));

create policy event_regions_read on event_regions for select to authenticated
  using (exists (select 1 from events e where e.id = event_id
                 and ((e.status <> 'draft' and e.is_public) or has_permission('events.manage'))));
create policy event_regions_write on event_regions for all to authenticated
  using (has_permission('events.manage')) with check (has_permission('events.manage'));

create policy event_missions_read on event_missions for select to authenticated
  using (exists (select 1 from events e where e.id = event_id
                 and ((e.status <> 'draft' and e.is_public) or has_permission('events.manage'))));
create policy event_missions_write on event_missions for all to authenticated
  using (has_permission('events.manage')) with check (has_permission('events.manage'));

create policy event_notes_all on event_notes for all to authenticated
  using (has_permission('events.manage')) with check (has_permission('events.manage'));

-- =============================================================================
-- Announcements
-- =============================================================================
create type announcement_level as enum
  ('national','regional','ministry','company','auror','political','internal');

create table announcements (
  id           uuid primary key default gen_random_uuid(),
  level        announcement_level not null default 'national',
  title        text not null,
  body         text,
  region_id    uuid references regions(id),
  office_id    uuid references offices(id),
  event_id     uuid references events(id) on delete set null,
  is_pinned    boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at   timestamptz,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);
create index announcements_level_idx on announcements(level, published_at desc);

-- Audience resolution for a notice.
create or replace function can_see_announcement(p_level announcement_level, p_region uuid, p_office uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_level
    when 'national'  then true
    when 'regional'  then exists (select 1 from profiles pr
                                  where pr.id = auth.uid() and pr.home_region_id = p_region)
                          or is_office_member_of(p_office) or has_permission('announcements.manage')
    when 'ministry'  then is_office_member_of(p_office) or has_permission('announcements.manage')
    when 'company'   then current_account_type() = 'company'
                          or exists (select 1 from company_members m
                                     where m.user_id = auth.uid() and m.is_active)
    when 'auror'     then current_account_type() = 'auror'
                          or exists (select 1 from auror_profiles a where a.user_id = auth.uid())
    when 'political' then current_account_type() = 'politician'
                          or exists (select 1 from office_members m
                                     where m.user_id = auth.uid() and m.is_active)
    when 'internal'  then is_office_member_of(p_office) or has_permission('announcements.manage')
    else false
  end;
$$;

alter table announcements enable row level security;
create policy announcements_read on announcements for select to authenticated
  using (has_permission('announcements.manage')
         or (can_see_announcement(level, region_id, office_id)
             and (expires_at is null or expires_at > now())));
create policy announcements_write on announcements for all to authenticated
  using (has_permission('announcements.manage')) with check (has_permission('announcements.manage'));

-- =============================================================================
-- Notification triggers wiring the earlier systems into the inbox
-- =============================================================================
-- Document status changes → notify the applicant.
create or replace function on_document_workflow_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_no text;
begin
  select submitted_by, public_no into v_owner, v_no
  from document_submissions where id = new.submission_id;
  if new.to_status in ('approved','rejected','info_requested','issued')
     and v_owner is not null and v_owner is distinct from new.actor_id then
    perform notify(v_owner, 'document_' || new.to_status,
                   'Document ' || new.to_status, coalesce(v_no, ''),
                   'document', new.submission_id::text);
  end if;
  return new;
end $$;
create trigger document_workflow_notify after insert on document_workflow_events
  for each row execute function on_document_workflow_event();

-- Mission assignment → notify the auror.
create or replace function on_mission_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_no text;
begin
  if new.state = 'assigned' and new.user_id is distinct from auth.uid() then
    select public_no into v_no from missions where id = new.mission_id;
    perform notify(new.user_id, 'mission_assigned', 'Mission assigned',
                   coalesce(v_no, ''), 'mission', new.mission_id::text);
  end if;
  return new;
end $$;
create trigger mission_member_notify after insert on mission_members
  for each row execute function on_mission_member();

-- =============================================================================
-- Selective Realtime  (only what benefits from live push)
-- =============================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['notifications','correspondence_messages','announcements'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- =============================================================================
-- Seed: a welcome announcement.
-- =============================================================================
insert into announcements (level, title, body, is_pinned)
values ('national', 'Welcome to Beginnings',
        'The national bureaucracy is now open. Present your papers at the appropriate ministry.',
        true)
on conflict do nothing;
