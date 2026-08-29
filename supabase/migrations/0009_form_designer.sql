-- =============================================================================
-- Beginnings — 0009_form_designer.sql
-- Turns document templates into freely-laid-out forms:
--   * templates carry a background image key, a page aspect, and a layout blob
--     (for decorations like seals),
--   * each field carries a position + size (fractions of the page) and font size,
--   * templates (and their fields) can be deleted by holders of
--     documents.manage_templates.
-- All columns are nullable/defaulted so existing stacked templates keep working.
-- =============================================================================

alter table document_templates
  add column if not exists background_key text,
  add column if not exists page_aspect  numeric,
  add column if not exists layout        jsonb not null default '{}'::jsonb;

alter table document_template_fields
  add column if not exists pos_x     numeric,   -- 0..1 fraction of page width  (top-left)
  add column if not exists pos_y     numeric,   -- 0..1 fraction of page height (top-left)
  add column if not exists width     numeric,   -- 0..1 fraction of page width
  add column if not exists height    numeric,   -- 0..1 fraction of page height
  add column if not exists font_size numeric;   -- 0..1 fraction of page height

drop policy if exists tmpl_delete on document_templates;
create policy tmpl_delete on document_templates
  for delete using (has_permission('documents.manage_templates'));

drop policy if exists tmpl_fields_delete on document_template_fields;
create policy tmpl_fields_delete on document_template_fields
  for delete using (has_permission('documents.manage_templates'));
