// Row shapes for the tables this frontend reads. These mirror the SQL
// migrations; regenerate with `supabase gen types typescript` once the CLI is
// linked if you prefer fully generated types.

export type AccountType = "admin" | "politician" | "company" | "auror" | "civilian";

export interface Profile {
  id: string;
  citizen_id: string;
  account_type: AccountType;
  full_name: string | null;
  username: string | null;
  home_region_id: string | null;
  occupation: string | null;
  status: string;
  registered_at: string;
}

export interface Region {
  id: string;
  code: string;
  name: string;
}

export interface Announcement {
  id: string;
  level: string;
  title: string;
  body: string | null;
  is_pinned: boolean;
  published_at: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_type: string | null;
  link_id: string | null;
  is_read: boolean;
  created_at: string;
}

export type FieldType =
  | "text" | "long_text" | "number" | "currency" | "date"
  | "dropdown" | "checkbox" | "radio" | "region_select" | "user_select"
  | "company_select" | "file" | "signature" | "declaration";

export interface DocumentTemplate {
  id: string;
  code: string;
  kind: string;
  name: string;
  description: string | null;
  department: string | null;
  applicant_account_types: AccountType[];
  is_active: boolean;
  background_key?: string | null;
  page_aspect?: number | null;
}

export interface TemplateField {
  id: string;
  template_id: string;
  key: string;
  label: string;
  description: string | null;
  field_type: FieldType;
  required: boolean;
  sort_order: number;
  options: Record<string, unknown>;
  pos_x?: number | null;
  pos_y?: number | null;
  width?: number | null;
  height?: number | null;
  font_size?: number | null;
}

export interface Office {
  id: string;
  code: string;
  name: string;
  ministry: string | null;
}
