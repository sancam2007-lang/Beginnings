-- =============================================================================
-- Beginnings — 0010_stamp_layout.sql
-- Reviewers place stamps and seals onto a document (like the form editor).
-- Their placements are persisted so a processed document stays visibly stamped.
-- =============================================================================

alter table document_submissions
  add column if not exists stamps_layout jsonb not null default '[]'::jsonb;

-- Replace process_stamps with a 4-arg version that also records the visual layout.
drop function if exists process_stamps(uuid, text[], text);

create or replace function process_stamps(
  p_submission uuid, p_stamps text[], p_comment text default null, p_layout jsonb default null)
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

  v_class := v_sub.classification;
  if 'classified' = any (p_stamps) then
    v_class := case v_sub.classification
      when 'public' then 'restricted'::classification_level
      when 'official' then 'restricted'::classification_level
      when 'restricted' then 'confidential'::classification_level
      when 'confidential' then 'secret'::classification_level
      else 'secret'::classification_level end;
  end if;

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
         status         = coalesce(v_target, status),
         stamps_layout  = coalesce(p_layout, stamps_layout)
   where id = p_submission;

  if v_target = 'issued' then perform issue_document(p_submission); end if;

  insert into document_workflow_events (submission_id, actor_id, from_status, to_status, action, comment)
  values (p_submission, auth.uid(), v_from, coalesce(v_target, v_from), 'stamped',
          trim(coalesce(p_comment, '') || ' [stamps: ' || array_to_string(p_stamps, ', ') || ']'));

  perform log_action('document.stamped', 'document_submission',
                     coalesce(v_sub.public_no, v_sub.id::text),
                     jsonb_build_object('stamps', to_jsonb(p_stamps), 'to', coalesce(v_target, v_from)));
end $$;
