-- =============================================================================
-- Beginnings — 0002_document_workflow_engine.sql
-- Phase 2: the reusable spine for EVERY piece of processed paperwork.
--
-- Document requests, business permits, tax filings, and Auror contracts are all
-- the same machine: a template (built from configurable fields) → a submission
-- (field values + attachments) → a status workflow (immutable per-doc history)
-- → optionally an issued certificate. Later migrations add domain tables that
-- point AT this engine instead of re-implementing approvals.
--
-- Also introduces app_settings (nation name / fictional year / currency), which
-- public ID numbering depends on.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permission keys introduced by this migration (permissions is data-driven).
-- -----------------------------------------------------------------------------
insert into permissions (key, category, label) values
  ('settings.manage',           'Administration', 'Edit national configuration'),
  ('documents.manage_templates','Documents',      'Create & edit document templates')
on conflict do nothing;

-- =============================================================================
-- Global configuration (singleton row)
-- =============================================================================
create table app_settings (
  id                boolean primary key default true check (id),  -- singleton
  country_name      text not null default 'Beginnings',
  displayed_year    int  not null default extract(year from now())::int,
  currency_code     text not null default 'CR',
  currency_symbol   text not null default '¤',
  national_motto    text,
  legislative_session text,
  national_seal_path  text,
  updated_at        timestamptz not null default now()
);
insert into app_settings (id) values (true) on conflict do nothing;

create trigger app_settings_touch before update on app_settings
  for each row execute function touch_updated_at();

create or replace function gov_year()
returns int language sql stable security definer set search_path = public as $$
  select displayed_year from app_settings where id;
$$;

alter table app_settings enable row level security;
create policy app_settings_read  on app_settings for select to authenticated using (true);
create policy app_settings_write on app_settings for all to authenticated
  using (has_permission('settings.manage')) with check (has_permission('settings.manage'));

-- =============================================================================
-- Enums
-- =============================================================================
create type document_kind as enum ('document','permit','tax','contract');

create type document_status as enum (
  'draft','submitted','received','under_review','info_requested',
  'approved','rejected','issued','expired','revoked','archived'
);

create type classification_level as enum
  ('public','official','restricted','confidential','secret');

create type field_type as enum (
  'text','long_text','number','currency','date','dropdown','checkbox','radio',
  'region_select','user_select','company_select','file','signature','declaration'
);

-- =============================================================================
-- Public document numbering  (PREFIX-YEAR-NNNNNN; display only, UUIDs internal)
-- =============================================================================
create sequence document_no_seq;

create or replace function next_document_no(prefix text)
returns text language sql security definer set search_path = public as $$
  select prefix || '-' || gov_year() || '-' || lpad(nextval('document_no_seq')::text, 6, '0');
$$;

-- =============================================================================
-- Templates + the form-builder fields
-- =============================================================================
create table document_templates (
  id                       uuid primary key default gen_random_uuid(),
  code                     text unique not null,
  kind                     document_kind not null default 'document',
  name                     text not null,
  description              text,
  department               text,
  numbering_prefix         text not null default 'DOC',
  fee                      numeric(14,2) not null default 0,
  attachments_required     int not null default 0,   -- minimum attachments
  approval_permission      text not null default 'documents.approve'
                             references permissions(key),
  default_classification   classification_level not null default 'official',
  auto_issue_on_approval   boolean not null default false,
  expires_after_days       int,                       -- null = never expires
  applicant_account_types  account_type[] not null default '{civilian}',
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index document_templates_kind_idx on document_templates(kind) where is_active;
create trigger document_templates_touch before update on document_templates
  for each row execute function touch_updated_at();

-- Optional region restriction: NO rows = template applies to all regions.
create table document_template_regions (
  template_id uuid references document_templates(id) on delete cascade,
  region_id   uuid references regions(id) on delete cascade,
  primary key (template_id, region_id)
);

create table document_template_fields (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references document_templates(id) on delete cascade,
  key           text not null,
  label         text not null,
  description   text,
  field_type    field_type not null default 'text',
  required      boolean not null default false,
  sort_order    int not null default 0,
  default_value text,
  options       jsonb not null default '{}'::jsonb,  -- dropdown options, min/max, pattern…
  unique (template_id, key)
);
create index document_template_fields_tmpl_idx on document_template_fields(template_id, sort_order);

-- =============================================================================
-- Submissions + normalized field values + attachments
-- =============================================================================
create table document_submissions (
  id                     uuid primary key default gen_random_uuid(),
  public_no              text unique,                 -- assigned on first submit
  template_id            uuid not null references document_templates(id),
  submitted_by           uuid not null references profiles(id) on delete cascade,
  on_behalf_of_company_id uuid,   -- FK to companies added in 0005 (companies don't exist yet)
  region_id              uuid references regions(id),
  status                 document_status not null default 'draft',
  classification         classification_level not null default 'official',
  assigned_reviewer      uuid references profiles(id),
  fee_amount             numeric(14,2) not null default 0,
  fee_paid               boolean not null default false,
  submitted_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index document_submissions_owner_idx    on document_submissions(submitted_by);
create index document_submissions_template_idx on document_submissions(template_id);
create index document_submissions_status_idx   on document_submissions(status);
create index document_submissions_company_idx  on document_submissions(on_behalf_of_company_id);
create trigger document_submissions_touch before update on document_submissions
  for each row execute function touch_updated_at();

create table document_field_values (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references document_submissions(id) on delete cascade,
  field_id      uuid not null references document_template_fields(id) on delete cascade,
  value         text,
  value_json    jsonb,               -- for multi-select / structured values
  unique (submission_id, field_id)
);

create table document_attachments (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references document_submissions(id) on delete cascade,
  storage_path  text not null,       -- Supabase Storage object path
  file_name     text not null,
  mime_type     text,
  size_bytes    bigint,
  uploaded_by   uuid not null references profiles(id),
  created_at    timestamptz not null default now()
);
create index document_attachments_sub_idx on document_attachments(submission_id);

-- Immutable per-document history the applicant actually sees (distinct from the
-- global audit_logs). No update/delete policy → append-only for all clients.
create table document_workflow_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references document_submissions(id) on delete cascade,
  actor_id      uuid references profiles(id),
  from_status   document_status,
  to_status     document_status not null,
  action        text not null default 'status_change',
  comment       text,
  created_at    timestamptz not null default now()
);
create index document_workflow_events_sub_idx on document_workflow_events(submission_id, created_at);

-- Issued certificates / permits / licenses produced when a submission is issued.
create table issued_documents (
  id            uuid primary key default gen_random_uuid(),
  public_no     text unique not null,
  submission_id uuid references document_submissions(id) on delete set null,
  template_id   uuid not null references document_templates(id),
  holder_id     uuid not null references profiles(id),
  company_id    uuid,                -- FK added in 0005
  issued_by     uuid references profiles(id),
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz,
  status        text not null default 'valid' check (status in ('valid','expired','revoked')),
  data          jsonb not null default '{}'::jsonb,   -- snapshot for the certificate
  created_at    timestamptz not null default now()
);
create index issued_documents_holder_idx on issued_documents(holder_id);

-- =============================================================================
-- Status transition rules  (data-driven, admin-inspectable)
-- =============================================================================
create table document_status_transitions (
  from_status document_status not null,
  to_status   document_status not null,
  primary key (from_status, to_status)
);

insert into document_status_transitions (from_status, to_status) values
  ('draft','submitted'), ('draft','archived'),
  ('submitted','received'), ('submitted','rejected'),
  ('received','under_review'), ('received','info_requested'), ('received','rejected'),
  ('under_review','approved'), ('under_review','rejected'), ('under_review','info_requested'),
  ('info_requested','submitted'), ('info_requested','under_review'), ('info_requested','rejected'),
  ('approved','issued'), ('approved','archived'),
  ('issued','expired'), ('issued','revoked'), ('issued','archived'),
  ('rejected','draft'), ('rejected','archived'),
  ('expired','issued'), ('expired','archived'),
  ('revoked','archived')
on conflict do nothing;

create or replace function is_valid_transition(p_from document_status, p_to document_status)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from document_status_transitions
                 where from_status = p_from and to_status = p_to);
$$;

-- =============================================================================
-- Authorization helpers for the engine
-- =============================================================================
create or replace function can_apply_template(p_template uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from document_templates t
    where t.id = p_template and t.is_active
      and current_account_type() = any (t.applicant_account_types)
  );
$$;

create or replace function can_review_submission(p_submission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission((
    select t.approval_permission
    from document_submissions s
    join document_templates t on t.id = s.template_id
    where s.id = p_submission
  ));
$$;

create or replace function can_read_submission(p_submission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from document_submissions s
    where s.id = p_submission
      and (s.submitted_by = auth.uid()
           or can_review_submission(p_submission)
           or has_permission('documents.read_confidential'))
  );
$$;

create or replace function is_own_editable_submission(p_submission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from document_submissions s
    where s.id = p_submission
      and s.submitted_by = auth.uid()
      and s.status in ('draft','info_requested')
  );
$$;

-- =============================================================================
-- Core operations
-- =============================================================================
-- Produce the issued certificate for a submission (called on transition→issued).
create or replace function issue_document(p_submission uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_sub  document_submissions;
  v_tmpl document_templates;
  v_id   uuid;
begin
  select * into v_sub  from document_submissions where id = p_submission;
  select * into v_tmpl from document_templates   where id = v_sub.template_id;

  insert into issued_documents (public_no, submission_id, template_id, holder_id,
                                company_id, issued_by, expires_at, data)
  values (
    next_document_no(v_tmpl.numbering_prefix),
    v_sub.id, v_tmpl.id, v_sub.submitted_by, v_sub.on_behalf_of_company_id, auth.uid(),
    case when v_tmpl.expires_after_days is not null
         then now() + make_interval(days => v_tmpl.expires_after_days) end,
    coalesce((select jsonb_object_agg(f.key, coalesce(v.value, v.value_json::text))
              from document_field_values v
              join document_template_fields f on f.id = v.field_id
              where v.submission_id = v_sub.id), '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end $$;

-- The one entry point for moving a submission through its lifecycle. Enforces
-- authorization + valid transitions, writes the immutable history + audit log,
-- and issues the certificate when appropriate.
create or replace function document_transition(
  p_submission uuid, p_to document_status, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sub  document_submissions;
  v_tmpl document_templates;
begin
  select * into v_sub from document_submissions where id = p_submission for update;
  if not found then raise exception 'Submission not found'; end if;
  select * into v_tmpl from document_templates where id = v_sub.template_id;

  -- authorization
  if p_to = 'submitted' then
    if v_sub.submitted_by <> auth.uid() and not has_permission(v_tmpl.approval_permission) then
      raise exception 'Not authorized to submit this document';
    end if;
  else
    if not has_permission(v_tmpl.approval_permission) then
      raise exception 'Not authorized to change this document''s status';
    end if;
  end if;

  if not is_valid_transition(v_sub.status, p_to) then
    raise exception 'Invalid transition: % -> %', v_sub.status, p_to;
  end if;

  update document_submissions
     set status       = p_to,
         public_no    = case when p_to = 'submitted' and public_no is null
                             then next_document_no(v_tmpl.numbering_prefix) else public_no end,
         submitted_at = case when p_to = 'submitted' and submitted_at is null
                             then now() else submitted_at end
   where id = p_submission;

  insert into document_workflow_events (submission_id, actor_id, from_status, to_status, comment)
  values (p_submission, auth.uid(), v_sub.status, p_to, p_comment);

  perform log_action('document.' || p_to, 'document_submission',
                     coalesce(v_sub.public_no, v_sub.id::text),
                     jsonb_build_object('from', v_sub.status, 'to', p_to));

  if p_to = 'issued' then
    perform issue_document(p_submission);
  end if;
end $$;

-- Auto-approve → issue convenience when a template opts into auto_issue_on_approval.
create or replace function approve_and_issue(p_submission uuid, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_auto boolean;
begin
  perform document_transition(p_submission, 'approved', p_comment);
  select t.auto_issue_on_approval into v_auto
    from document_submissions s join document_templates t on t.id = s.template_id
    where s.id = p_submission;
  if v_auto then perform document_transition(p_submission, 'issued', null); end if;
end $$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table document_templates          enable row level security;
alter table document_template_regions   enable row level security;
alter table document_template_fields    enable row level security;
alter table document_submissions        enable row level security;
alter table document_field_values       enable row level security;
alter table document_attachments        enable row level security;
alter table document_workflow_events    enable row level security;
alter table issued_documents            enable row level security;
alter table document_status_transitions enable row level security;

-- Templates + fields: readable so applicants can browse; template managers edit.
create policy tmpl_read  on document_templates for select to authenticated using (true);
create policy tmpl_write on document_templates for all to authenticated
  using (has_permission('documents.manage_templates'))
  with check (has_permission('documents.manage_templates'));

create policy tmpl_regions_read  on document_template_regions for select to authenticated using (true);
create policy tmpl_regions_write on document_template_regions for all to authenticated
  using (has_permission('documents.manage_templates'))
  with check (has_permission('documents.manage_templates'));

create policy tmpl_fields_read  on document_template_fields for select to authenticated using (true);
create policy tmpl_fields_write on document_template_fields for all to authenticated
  using (has_permission('documents.manage_templates'))
  with check (has_permission('documents.manage_templates'));

create policy transitions_read on document_status_transitions for select to authenticated using (true);
create policy transitions_write on document_status_transitions for all to authenticated
  using (is_admin()) with check (is_admin());

-- Submissions: owner + reviewers + confidential-readers may see. Owner may edit
-- only while draft/info_requested and may NOT change status directly (status is
-- moved only through document_transition, which runs security-definer).
create policy sub_read on document_submissions for select to authenticated
  using (submitted_by = auth.uid()
         or can_review_submission(id)
         or has_permission('documents.read_confidential'));
create policy sub_insert on document_submissions for insert to authenticated
  with check (submitted_by = auth.uid() and status = 'draft' and can_apply_template(template_id));
create policy sub_update_owner on document_submissions for update to authenticated
  using (submitted_by = auth.uid() and status in ('draft','info_requested'))
  with check (submitted_by = auth.uid() and status in ('draft','info_requested'));
create policy sub_delete_owner on document_submissions for delete to authenticated
  using (submitted_by = auth.uid() and status = 'draft');

-- Field values: visible with the submission; editable by owner while editable.
create policy fv_read on document_field_values for select to authenticated
  using (can_read_submission(submission_id));
create policy fv_write on document_field_values for all to authenticated
  using (is_own_editable_submission(submission_id))
  with check (is_own_editable_submission(submission_id));

-- Attachments: same access model.
create policy att_read on document_attachments for select to authenticated
  using (can_read_submission(submission_id));
create policy att_write on document_attachments for all to authenticated
  using (is_own_editable_submission(submission_id) and uploaded_by = auth.uid())
  with check (is_own_editable_submission(submission_id) and uploaded_by = auth.uid());

-- Workflow history: readable with the submission; writes only via the function.
create policy wfe_read on document_workflow_events for select to authenticated
  using (can_read_submission(submission_id));

-- Issued documents: holder sees theirs; issuers/confidential-readers see all;
-- issuers may revoke/expire via update. Inserts happen only through issue_document.
create policy issued_read on issued_documents for select to authenticated
  using (holder_id = auth.uid()
         or has_permission('documents.issue')
         or has_permission('documents.read_confidential'));
create policy issued_update on issued_documents for update to authenticated
  using (has_permission('documents.issue')) with check (has_permission('documents.issue'));

-- =============================================================================
-- Seed: one example template per kind so the engine is exercisable immediately.
-- =============================================================================
insert into document_templates (code, kind, name, description, department, numbering_prefix,
                                approval_permission, applicant_account_types, auto_issue_on_approval,
                                expires_after_days)
values
  ('RESIDENCY_CERT', 'document', 'Residency Certificate',
   'Confirms a citizen''s registered residence in their home region.',
   'Ministry of Interior', 'DOC', 'documents.approve', '{civilian}', true, 365),
  ('TRADE_PERMIT', 'permit', 'Trade Permit',
   'Authorizes a company to trade within a region.',
   'Ministry of Commerce', 'PRM', 'business.permit_review', '{company}', true, 730)
on conflict do nothing;

-- Fields for the Residency Certificate example.
insert into document_template_fields (template_id, key, label, field_type, required, sort_order)
select t.id, v.key, v.label, v.ftype::field_type, v.req, v.ord
from document_templates t
join (values
  ('full_name','Full Legal Name','text', true, 1),
  ('residence_since','Resident Since','date', true, 2),
  ('address','Registered Address','long_text', true, 3),
  ('declaration','I declare the above to be true','declaration', true, 4)
) as v(key,label,ftype,req,ord) on true
where t.code = 'RESIDENCY_CERT'
on conflict do nothing;
