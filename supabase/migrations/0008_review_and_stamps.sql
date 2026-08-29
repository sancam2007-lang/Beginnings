-- =============================================================================
-- Beginnings — 0008_review_and_stamps.sql
-- Delegated, tray-based document review.
--
--   * Anyone holding a template's approval_permission can rule on its documents
--     (this was always true in the engine; now workers get a surface for it).
--   * When a document is submitted, every reviewer who can rule on it is notified
--     into their incoming tray (optionally scoped to a routed office).
--   * my_review_queue() returns exactly what the current user may rule on.
--   * process_stamps() applies a set of stamps as one authorized ruling —
--     Received / Approved / Denied / Void plus the metadata marks Paid (fee_paid)
--     and Classified (raises the secrecy level). This is the "send to the outgoing
--     tray" commit for the queued stamps.
-- =============================================================================

-- Optional routing: send a submission to a specific office's members.
alter table document_submissions
  add column if not exists routed_office_id uuid references offices(id);

-- -----------------------------------------------------------------------------
-- The current user's review queue (pending items they may rule on, not their own)
-- -----------------------------------------------------------------------------
create or replace function my_review_queue()
returns table (id uuid, public_no text, status document_status,
               template_name text, kind document_kind, submitted_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.public_no, s.status, t.name, t.kind, s.submitted_at
  from document_submissions s
  join document_templates t on t.id = s.template_id
  where s.status in ('submitted','received','under_review','info_requested')
    and s.submitted_by <> auth.uid()
    and has_permission(t.approval_permission)
    and (s.routed_office_id is null
         or exists (select 1 from office_members m
                    where m.office_id = s.routed_office_id and m.user_id = auth.uid() and m.is_active))
  order by s.submitted_at nulls first;
$$;

-- -----------------------------------------------------------------------------
-- Apply queued stamps as one ruling.
-- -----------------------------------------------------------------------------
create or replace function process_stamps(p_submission uuid, p_stamps text[], p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sub   document_submissions;
  v_tmpl  document_templates;
  v_from  document_status;
  v_target document_status;
  v_class classification_level;
begin
  select * into v_sub from document_submissions where id = p_submission for update;
  if not found then raise exception 'Submission not found'; end if;
  select * into v_tmpl from document_templates where id = v_sub.template_id;

  if not has_permission(v_tmpl.approval_permission) then
    raise exception 'You are not authorized to rule on this document';
  end if;
  v_from := v_sub.status;

  -- CLASSIFIED raises the secrecy level one meaningful step.
  v_class := v_sub.classification;
  if 'classified' = any (p_stamps) then
    v_class := case v_sub.classification
      when 'public' then 'restricted'::classification_level
      when 'official' then 'restricted'::classification_level
      when 'restricted' then 'confidential'::classification_level
      when 'confidential' then 'secret'::classification_level
      else 'secret'::classification_level end;
  end if;

  -- Terminal ruling (precedence: void > denied > approved > received).
  v_target := null;
  if 'void' = any (p_stamps) then
    v_target := case when v_sub.status = 'issued' then 'revoked'::document_status else 'rejected'::document_status end;
  elsif 'denied' = any (p_stamps) then
    v_target := 'rejected';
  elsif 'approved' = any (p_stamps) then
    v_target := case when v_tmpl.auto_issue_on_approval then 'issued'::document_status else 'approved'::document_status end;
  elsif 'received' = any (p_stamps) then
    v_target := 'received';
  end if;

  update document_submissions
     set fee_paid       = case when 'paid' = any (p_stamps) then true else fee_paid end,
         classification = v_class,
         status         = coalesce(v_target, status)
   where id = p_submission;

  if v_target = 'issued' then
    perform issue_document(p_submission);
  end if;

  insert into document_workflow_events (submission_id, actor_id, from_status, to_status, action, comment)
  values (p_submission, auth.uid(), v_from, coalesce(v_target, v_from), 'stamped',
          trim(coalesce(p_comment, '') || ' [stamps: ' || array_to_string(p_stamps, ', ') || ']'));

  perform log_action('document.stamped', 'document_submission',
                     coalesce(v_sub.public_no, v_sub.id::text),
                     jsonb_build_object('stamps', to_jsonb(p_stamps), 'to', coalesce(v_target, v_from)));
end $$;

-- -----------------------------------------------------------------------------
-- When a document is submitted, notify every reviewer who can rule on it.
-- -----------------------------------------------------------------------------
create or replace function notify_reviewers()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_perm text; v_routed uuid; v_no text; r record;
begin
  if new.to_status <> 'submitted' then return new; end if;
  select t.approval_permission, s.routed_office_id, s.public_no
    into v_perm, v_routed, v_no
  from document_submissions s join document_templates t on t.id = s.template_id
  where s.id = new.submission_id;

  for r in
    select distinct uid from (
      select m.user_id uid
      from office_members m
      join office_permissions op on op.office_id = m.office_id
      where m.is_active and op.permission_key = v_perm
        and (v_routed is null or m.office_id = v_routed)
      union
      select o.user_id uid
      from user_permission_overrides o
      where o.permission_key = v_perm and o.effect = 'grant'
    ) u
    where uid <> new.actor_id
      and not exists (select 1 from user_permission_overrides rv
                      where rv.user_id = u.uid and rv.permission_key = v_perm and rv.effect = 'revoke')
  loop
    perform notify(r.uid, 'review_needed', 'Document awaiting your ruling',
                   coalesce(v_no, ''), 'review', new.submission_id::text);
  end loop;
  return new;
end $$;

create trigger document_submitted_notify_reviewers
  after insert on document_workflow_events
  for each row execute function notify_reviewers();
