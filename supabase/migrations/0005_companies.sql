-- =============================================================================
-- Beginnings — 0005_companies.sql
-- Phase 5: companies as real organizations.
--
--   * A company is owned by one user and staffed by MEMBERS (manager / accountant
--     / employee) — no shared password. Roles decide who may file and who may
--     touch finances.
--   * Financial ledger + asset registry are private company data (finance staff
--     + government oversight only).
--   * Tax filings and permits are NOT new systems: they are document_submissions
--     of kind 'tax' / 'permit', filed on behalf of a company through the Phase-2
--     engine. This migration wires the on_behalf_of_company_id foreign key that
--     0002 left as a forward stub, and adds company-scoped RLS so authorized
--     staff can file and read their company's paperwork.
-- =============================================================================

-- Configurable estimate rate for the ledger's tax projection.
alter table app_settings
  add column if not exists default_corporate_tax_rate numeric not null default 0.15;

-- =============================================================================
-- Enums
-- =============================================================================
create type company_status  as enum ('pending','active','suspended','dissolved');
create type company_role     as enum ('manager','accountant','employee'); -- owner lives on companies.owner_id
create type transaction_type as enum ('revenue','expense','liability','asset_acquisition','adjustment');
create type asset_status     as enum ('active','sold','depreciated','written_off','transferred');

-- Company numbering (COM-000081)
create sequence company_id_seq;

-- =============================================================================
-- Tables
-- =============================================================================
create table companies (
  id          uuid primary key default gen_random_uuid(),
  public_no   text unique not null default format_public_id('COM', nextval('company_id_seq')),
  name        text not null,
  owner_id    uuid not null references profiles(id) on delete restrict,
  region_id   uuid references regions(id),
  industry    text,
  description text,
  status      company_status not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index companies_owner_idx on companies(owner_id);
create trigger companies_touch before update on companies
  for each row execute function touch_updated_at();

create table company_members (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       company_role not null default 'employee',
  is_active  boolean not null default true,
  added_at   timestamptz not null default now(),
  unique (company_id, user_id)
);
create index company_members_user_idx on company_members(user_id) where is_active;

create table asset_categories (
  code       text primary key,
  label      text not null,
  is_enabled boolean not null default true
);

create table company_assets (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  category_code     text references asset_categories(code),
  name              text not null,
  description       text,
  acquisition_value numeric(14,2) not null default 0,
  current_value     numeric(14,2) not null default 0,
  acquired_on       date,
  location          text,
  status            asset_status not null default 'active',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index company_assets_company_idx on company_assets(company_id);
create trigger company_assets_touch before update on company_assets
  for each row execute function touch_updated_at();

create table company_transactions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  type        transaction_type not null,
  category    text,
  description text,
  amount      numeric(14,2) not null default 0,
  occurred_on date not null default current_date,
  recorded_by uuid references profiles(id),
  created_at  timestamptz not null default now()
);
create index company_transactions_company_idx on company_transactions(company_id, occurred_on);

-- =============================================================================
-- Wire the document engine's forward stubs to real companies (from 0002).
-- =============================================================================
alter table document_submissions
  add constraint fk_submission_company
  foreign key (on_behalf_of_company_id) references companies(id) on delete set null;

alter table issued_documents
  add constraint fk_issued_company
  foreign key (company_id) references companies(id) on delete set null;

-- =============================================================================
-- Membership / authorization helpers
-- =============================================================================
-- Effective role of the current user at a company (owner derived from owner_id).
create or replace function company_role(p_company uuid)
returns company_role language sql stable security definer set search_path = public as $$
  select m.role
  from company_members m
  where m.company_id = p_company and m.user_id = auth.uid() and m.is_active;
$$;

create or replace function is_company_owner(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from companies c where c.id = p_company and c.owner_id = auth.uid());
$$;

create or replace function is_company_member(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_company_owner(p_company) or company_role(p_company) is not null;
$$;

-- Owner + managers run the company (details, roster).
create or replace function can_manage_company(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_company_owner(p_company) or company_role(p_company) = 'manager';
$$;

-- Owner + manager + accountant may see/record finances and file paperwork.
create or replace function can_manage_company_finances(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_company_owner(p_company) or company_role(p_company) in ('manager','accountant');
$$;

create or replace function can_file_for_company(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_manage_company_finances(p_company);
$$;

-- Does a template target company applicants? (routes company filing policies)
create or replace function template_targets_companies(p_template uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from document_templates t
                 where t.id = p_template and 'company' = any (t.applicant_account_types));
$$;

create or replace function is_company_editable_submission(p_submission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from document_submissions s
    where s.id = p_submission
      and s.on_behalf_of_company_id is not null
      and s.status in ('draft','info_requested')
      and can_file_for_company(s.on_behalf_of_company_id)
  );
$$;

create or replace function can_read_company_submission(p_submission uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from document_submissions s
    where s.id = p_submission
      and s.on_behalf_of_company_id is not null
      and can_manage_company_finances(s.on_behalf_of_company_id)
  );
$$;

-- =============================================================================
-- Financial summary (ledger totals, asset value, tax estimate, monthly series)
-- =============================================================================
create or replace function company_financials(p_company uuid, p_year int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rate numeric;
  v_rev numeric; v_exp numeric; v_liab numeric; v_assets numeric; v_net numeric;
  v_monthly jsonb;
begin
  if not (can_manage_company_finances(p_company) or has_permission('business.manage')) then
    raise exception 'Not authorized to view these financials';
  end if;

  select default_corporate_tax_rate into v_rate from app_settings where id;

  select
    coalesce(sum(amount) filter (where type = 'revenue'), 0),
    coalesce(sum(amount) filter (where type = 'expense'), 0),
    coalesce(sum(amount) filter (where type = 'liability'), 0)
  into v_rev, v_exp, v_liab
  from company_transactions
  where company_id = p_company
    and (p_year is null or extract(year from occurred_on) = p_year);

  select coalesce(sum(current_value), 0) into v_assets
  from company_assets where company_id = p_company and status = 'active';

  v_net := v_rev - v_exp;

  select jsonb_agg(jsonb_build_object('month', m, 'revenue', rev, 'expenses', exp,
                                      'net', rev - exp) order by m)
    into v_monthly
  from (
    select extract(month from occurred_on)::int m,
           coalesce(sum(amount) filter (where type = 'revenue'), 0) rev,
           coalesce(sum(amount) filter (where type = 'expense'), 0) exp
    from company_transactions
    where company_id = p_company
      and (p_year is null or extract(year from occurred_on) = p_year)
    group by 1
  ) t;

  return jsonb_build_object(
    'year', p_year,
    'revenue', v_rev, 'expenses', v_exp, 'liabilities', v_liab,
    'net_profit', v_net, 'asset_value', v_assets,
    'estimated_tax', round(greatest(v_net, 0) * v_rate, 2),
    'tax_rate', v_rate,
    'monthly', coalesce(v_monthly, '[]'::jsonb));
end $$;

-- =============================================================================
-- Guard: only government (business.manage) changes standing; only owner (or gov)
-- transfers ownership.
-- =============================================================================
create or replace function guard_company_privileged()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and not has_permission('business.manage') then
    raise exception 'Only government officials may change company standing';
  end if;
  if new.owner_id is distinct from old.owner_id
     and not (old.owner_id = auth.uid() or has_permission('business.manage')) then
    raise exception 'Only the current owner may transfer ownership';
  end if;
  return new;
end $$;
create trigger companies_guard before update on companies
  for each row execute function guard_company_privileged();

-- =============================================================================
-- Row Level Security — company core
-- =============================================================================
alter table companies            enable row level security;
alter table company_members      enable row level security;
alter table asset_categories     enable row level security;
alter table company_assets       enable row level security;
alter table company_transactions enable row level security;

-- Companies: a public business registry (name/region/industry/status readable);
-- managed by owner/managers; standing changes gated by the guard trigger above.
create policy companies_read on companies for select to authenticated using (true);
create policy companies_insert on companies for insert to authenticated
  with check (owner_id = auth.uid() or has_permission('business.manage'));
create policy companies_update on companies for update to authenticated
  using (can_manage_company(id) or has_permission('business.manage'))
  with check (can_manage_company(id) or has_permission('business.manage'));
create policy companies_delete on companies for delete to authenticated
  using (has_permission('business.manage'));

-- Membership roster: visible to members + gov; managed by owner/managers + gov.
create policy members_read on company_members for select to authenticated
  using (is_company_member(company_id) or has_permission('business.manage'));
create policy members_write on company_members for all to authenticated
  using (can_manage_company(company_id) or has_permission('business.manage'))
  with check (can_manage_company(company_id) or has_permission('business.manage'));

-- Asset categories: public read (forms need them); admin/gov manage.
create policy asset_cats_read on asset_categories for select to authenticated using (true);
create policy asset_cats_write on asset_categories for all to authenticated
  using (is_admin() or has_permission('business.manage'))
  with check (is_admin() or has_permission('business.manage'));

-- Assets + ledger: private financial data — finance staff + gov oversight only.
create policy assets_read on company_assets for select to authenticated
  using (can_manage_company_finances(company_id) or has_permission('business.manage'));
create policy assets_write on company_assets for all to authenticated
  using (can_manage_company_finances(company_id))
  with check (can_manage_company_finances(company_id));

create policy tx_read on company_transactions for select to authenticated
  using (can_manage_company_finances(company_id) or has_permission('business.manage'));
create policy tx_write on company_transactions for all to authenticated
  using (can_manage_company_finances(company_id) and recorded_by = auth.uid())
  with check (can_manage_company_finances(company_id) and recorded_by = auth.uid());

-- =============================================================================
-- RLS — let authorized company staff file & read company paperwork via the
-- document engine (added alongside 0002's owner-based policies; they OR together).
-- =============================================================================
create policy sub_read_company on document_submissions for select to authenticated
  using (on_behalf_of_company_id is not null
         and can_manage_company_finances(on_behalf_of_company_id));
create policy sub_insert_company on document_submissions for insert to authenticated
  with check (submitted_by = auth.uid() and status = 'draft'
              and on_behalf_of_company_id is not null
              and can_file_for_company(on_behalf_of_company_id)
              and template_targets_companies(template_id));
create policy sub_update_company on document_submissions for update to authenticated
  using (on_behalf_of_company_id is not null and status in ('draft','info_requested')
         and can_file_for_company(on_behalf_of_company_id))
  with check (on_behalf_of_company_id is not null and status in ('draft','info_requested')
         and can_file_for_company(on_behalf_of_company_id));
create policy sub_delete_company on document_submissions for delete to authenticated
  using (on_behalf_of_company_id is not null and status = 'draft'
         and can_file_for_company(on_behalf_of_company_id));

create policy fv_read_company on document_field_values for select to authenticated
  using (can_read_company_submission(submission_id));
create policy fv_write_company on document_field_values for all to authenticated
  using (is_company_editable_submission(submission_id))
  with check (is_company_editable_submission(submission_id));

create policy att_read_company on document_attachments for select to authenticated
  using (can_read_company_submission(submission_id));
create policy att_write_company on document_attachments for all to authenticated
  using (is_company_editable_submission(submission_id) and uploaded_by = auth.uid())
  with check (is_company_editable_submission(submission_id) and uploaded_by = auth.uid());

create policy wfe_read_company on document_workflow_events for select to authenticated
  using (can_read_company_submission(submission_id));

-- =============================================================================
-- Seed: asset categories (admins can disable) + a corporate tax return template.
-- =============================================================================
insert into asset_categories (code, label) values
  ('building','Building'), ('factory','Factory'), ('vehicle','Vehicle'),
  ('machinery','Machinery'), ('land','Land'), ('ship','Ship'),
  ('inventory','Inventory'), ('patent','Patent'), ('misc','Miscellaneous')
on conflict do nothing;

insert into document_templates (code, kind, name, description, department, numbering_prefix,
                                approval_permission, applicant_account_types, fee)
values ('CORP_TAX_RETURN', 'tax', 'Corporate Tax Return',
        'Annual corporate tax declaration submitted to the Ministry of Finance.',
        'Ministry of Finance', 'TAX', 'business.tax_review', '{company}', 0)
on conflict do nothing;

insert into document_template_fields (template_id, key, label, field_type, required, sort_order)
select t.id, v.key, v.label, v.ftype::field_type, v.req, v.ord
from document_templates t
join (values
  ('tax_year','Tax Year','number', true, 1),
  ('gross_revenue','Gross Revenue','currency', true, 2),
  ('operating_expenses','Operating Expenses','currency', true, 3),
  ('taxable_profit','Taxable Profit','currency', true, 4),
  ('calculated_tax','Calculated Tax Due','currency', true, 5),
  ('declaration','I declare this return accurate and complete','declaration', true, 6)
) as v(key,label,ftype,req,ord) on true
where t.code = 'CORP_TAX_RETURN'
on conflict do nothing;
