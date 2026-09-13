// T-30 exercise catalog — API types and calls for the library workspace.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BodyRegion, CompletenessKey, ContentField, ExerciseStatus, MediaKind, MediaRights } from 'shared';

export interface CatalogFilters {
  q?: string;
  body_region_id?: string;
  category?: string;
  status?: string;
  equipment?: string;
  start_position?: string;
  source?: string;
  media?: string;
  missing?: string;
  protocol?: string;
  sort?: string;
}

export const FACET_KEYS = ['body_region_id', 'category', 'status', 'start_position', 'equipment', 'source', 'media', 'missing'] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export interface CatalogItem {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  body_region: BodyRegion | null;
  status: ExerciseStatus;
  source: 'system' | 'clinic';
  is_clinic_owned: boolean;
  has_override: boolean;
  start_position: string | null;
  difficulty: number | null;
  is_bilateral: boolean;
  equipment: string[];
  muscle_group: string | null;
  completeness: number;
  missing: CompletenessKey[];
  revision: number;
  updated_at: string;
  thumb_url: string | null;
  gif_url: string | null;
  media_verified: boolean;
  has_verified_media: boolean;
  protocol_count: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

// The server's facet names — body_region / position are keyed differently
// from their filter params.
export interface CatalogFacets {
  body_region: FacetValue[];
  category: FacetValue[];
  status: FacetValue[];
  equipment: FacetValue[];
  start_position: FacetValue[];
  source: FacetValue[];
  media: FacetValue[];
  missing: FacetValue[];
}

export interface CatalogPage {
  total: number;
  items: CatalogItem[];
  facets: CatalogFacets;
  viewer: { is_curator: boolean };
}

export interface CatalogMedia {
  id: string;
  kind: MediaKind;
  url: string | null;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  duration_ms?: number | null;
  order: number;
  source_file: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  rights: MediaRights;
  attribution: string | null;
  start_sec: number | null;
  end_sec: number | null;
  review_note?: string | null;
  verified: boolean;
  verified_at?: string | null;
  scope: 'master' | 'clinic';
  can_manage: boolean;
}

export interface CatalogExercise {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  body_region_id: string | null;
  body_region: BodyRegion | null;
  muscle_group: string | null;
  muscles: string[];
  equipment: string[];
  aliases: string[];
  key_cues: string[];
  description: string | null;
  instructions: string | null;
  common_mistakes: string | null;
  safety_notes: string | null;
  contraindications: string | null;
  start_position: string | null;
  difficulty: number | null;
  is_bilateral: boolean;
  source: 'system' | 'clinic';
  external_ref: string | null;
  is_clinic_owned: boolean;
  status: ExerciseStatus;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  revision: number;
  override_revision: number;
  overridden_fields: ContentField[];
  master: Record<ContentField, string | string[] | null> | null;
  completeness: number;
  missing: CompletenessKey[];
  permissions: {
    is_curator: boolean;
    can_edit_master: boolean;
    can_edit_content: boolean;
    can_change_status: boolean;
    can_delete: boolean;
  };
  usage: {
    protocols: { protocol_id: string; name: string; is_clinic: boolean; phases: number[] }[];
    active_plan_count: number;
  };
  media: CatalogMedia[];
  media_scope: 'master' | 'clinic';
  created_at: string;
  updated_at: string;
}

/** Every field the editor can patch. */
export interface EditableFields {
  name: string;
  name_en: string | null;
  aliases: string[];
  body_region_id: string | null;
  category: string;
  start_position: string | null;
  difficulty: number | null;
  is_bilateral: boolean;
  muscles: string[];
  equipment: string[];
  description: string | null;
  instructions: string | null;
  key_cues: string[];
  common_mistakes: string | null;
  safety_notes: string | null;
  contraindications: string | null;
}
export type EditableKey = keyof EditableFields;
export type Patch = Partial<EditableFields>;

export const MASTER_ONLY_FIELDS: EditableKey[] = [
  'name', 'name_en', 'aliases', 'body_region_id', 'category', 'start_position', 'difficulty', 'is_bilateral', 'muscles', 'equipment',
];

export function editableFrom(ex: CatalogExercise): EditableFields {
  return {
    name: ex.name, name_en: ex.name_en, aliases: ex.aliases, body_region_id: ex.body_region_id,
    category: ex.category, start_position: ex.start_position, difficulty: ex.difficulty,
    is_bilateral: ex.is_bilateral, muscles: ex.muscles, equipment: ex.equipment,
    description: ex.description, instructions: ex.instructions, key_cues: ex.key_cues,
    common_mistakes: ex.common_mistakes, safety_notes: ex.safety_notes, contraindications: ex.contraindications,
  };
}

export interface SaveResult {
  ok: true;
  id: string;
  changed: boolean;
  revision?: number;
  override_revision?: number;
  overridden_fields?: ContentField[];
  completeness: number;
  missing: CompletenessKey[];
}

export interface HistoryEntry {
  id: string;
  scope: 'master' | 'clinic' | 'override';
  action: 'create' | 'update' | 'status' | 'revert' | 'restore' | 'duplicate';
  changes: Record<string, { from: unknown; to: unknown }>;
  changed_at: string;
  changed_by_name: string | null;
  by_catalog_team: boolean;
  restorable: boolean;
}

export interface BulkResult {
  updated: number;
  skipped: { id: string; reason: string }[];
}

export interface ApiError {
  error: string;
  message?: string;
  field?: string;
  revision?: number;
}

/** supabase.functions.invoke wraps non-2xx responses in an error whose `context` is the Response. */
async function call<T>(supabase: SupabaseClient, path: string, init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> }): Promise<T> {
  const { data, error } = await supabase.functions.invoke(path, init);
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let body: ApiError = { error: 'internal_error' };
    if (ctx && typeof ctx.json === 'function') {
      body = await ctx.json().catch(() => body);
    }
    throw new CatalogApiError(body);
  }
  if (data && typeof data === 'object' && 'error' in data) throw new CatalogApiError(data as ApiError);
  return data as T;
}

export class CatalogApiError extends Error {
  constructor(public body: ApiError) {
    super(body.message ?? body.error);
  }
}

export function catalogSearch(supabase: SupabaseClient, filters: CatalogFilters, limit: number, offset: number) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return call<CatalogPage>(supabase, `exercises/catalog?${params.toString()}`, { method: 'GET' });
}

export const getCatalogExercise = (supabase: SupabaseClient, id: string) =>
  call<CatalogExercise>(supabase, `exercises/catalog/${id}`, { method: 'GET' });

export const saveExercise = (supabase: SupabaseClient, id: string, patch: Patch, expectedRevision: number | null) =>
  call<SaveResult>(supabase, `exercises/${id}`, { method: 'PATCH', body: { patch, expected_revision: expectedRevision } });

export const createExercise = (supabase: SupabaseClient, patch: Patch, scope: 'clinic' | 'master') =>
  call<SaveResult>(supabase, 'exercises/catalog', { method: 'POST', body: { patch, scope } });

export const bulkUpdate = (supabase: SupabaseClient, ids: string[], patch: Patch) =>
  call<BulkResult>(supabase, 'exercises/bulk', { method: 'POST', body: { ids, patch } });

export const setStatus = (supabase: SupabaseClient, ids: string[], status: ExerciseStatus) =>
  call<BulkResult>(supabase, 'exercises/status', { method: 'POST', body: { ids, status } });

export const revertOverride = (supabase: SupabaseClient, id: string, fields: string[]) =>
  call<SaveResult>(supabase, `exercises/${id}/override?fields=${encodeURIComponent(fields.join(','))}`, { method: 'DELETE' });

export const getHistory = (supabase: SupabaseClient, id: string) =>
  call<{ items: HistoryEntry[] }>(supabase, `exercises/${id}/history`, { method: 'GET' });

export const restoreRevision = (supabase: SupabaseClient, revisionId: string) =>
  call<SaveResult>(supabase, `exercises/revisions/${revisionId}/restore`, { method: 'POST' });

export const duplicateExercise = (supabase: SupabaseClient, id: string) =>
  call<{ ok: true; id: string }>(supabase, `exercises/${id}/duplicate`, { method: 'POST' });

export const deleteExercise = (supabase: SupabaseClient, id: string) =>
  call<{ ok: true }>(supabase, `exercises/${id}`, { method: 'DELETE' });

export function findSimilar(supabase: SupabaseClient, name: string, nameEn: string, excludeId?: string) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (nameEn) params.set('name_en', nameEn);
  if (excludeId) params.set('exclude_id', excludeId);
  return call<{ items: { id: string; name: string; name_en: string | null; status: ExerciseStatus; is_clinic_owned: boolean; similarity: number }[] }>(
    supabase, `exercises/similar?${params.toString()}`, { method: 'GET' },
  );
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export function mediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

// --- T-31 media ---------------------------------------------------------------

export interface UploadTarget {
  path: string;
  token: string;
  thumb_path: string;
  thumb_token: string;
}

export interface MediaAddInput {
  kind: MediaKind;
  path?: string;
  youtube_id?: string;
  thumb_path?: string;
  source_file?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  mime_type?: string;
  size_bytes?: number;
  rights?: MediaRights;
  attribution?: string;
  start_sec?: number | null;
  end_sec?: number | null;
  primary?: boolean;
  verify?: boolean;
}

export interface MediaQueueItem extends Omit<CatalogMedia, 'order' | 'can_manage'> {
  source: 'dataset' | 'upload' | 'youtube';
  exercise: { id: string; name: string; name_en: string | null; status: ExerciseStatus; is_clinic_owned: boolean };
}

export interface MediaQueuePage {
  total: number;
  counts: { pending: number; verified: number; rights_unknown: number; all: number };
  items: MediaQueueItem[];
  viewer: { is_curator: boolean };
}

export interface MatchCandidate {
  id: string;
  name: string;
  name_en: string | null;
  status: ExerciseStatus;
  is_clinic_owned: boolean;
  score: number;
  media_count: number;
}

export const mediaUploadTargets = (supabase: SupabaseClient, exerciseId: string, files: { mime_type: string; size_bytes: number }[]) =>
  call<{ scope: 'master' | 'clinic'; targets: UploadTarget[] }>(supabase, `exercises/${exerciseId}/media/upload-url`, { method: 'POST', body: { files } });

export const addMedia = (supabase: SupabaseClient, exerciseId: string, media: MediaAddInput) =>
  call<{ ok: true; id: string; scope: string }>(supabase, `exercises/${exerciseId}/media`, { method: 'POST', body: { ...media } });

export const reorderMedia = (supabase: SupabaseClient, exerciseId: string, ids: string[]) =>
  call<{ ok: true }>(supabase, `exercises/${exerciseId}/media/order`, { method: 'PUT', body: { ids } });

export const updateMedia = (supabase: SupabaseClient, mediaId: string, patch: Partial<Pick<CatalogMedia, 'rights' | 'attribution' | 'start_sec' | 'end_sec' | 'review_note'>>) =>
  call<{ ok: true; verified: boolean }>(supabase, `exercises/media/${mediaId}`, { method: 'PATCH', body: { patch } });

export const removeMedia = (supabase: SupabaseClient, mediaId: string) =>
  call<{ ok: true }>(supabase, `exercises/media/${mediaId}`, { method: 'DELETE' });

export const verifyMedia = (supabase: SupabaseClient, ids: string[], verified: boolean, rights?: MediaRights | null, note?: string) =>
  call<BulkResult>(supabase, 'exercises/media/verify', { method: 'POST', body: { ids, verified, rights: rights ?? null, note: note ?? null } });

export function mediaQueue(supabase: SupabaseClient, filters: { status?: string; source?: string; exercise_status?: string }, limit: number, offset: number) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return call<MediaQueuePage>(supabase, `exercises/media/queue?${params.toString()}`, { method: 'GET' });
}

export const matchMediaNames = (supabase: SupabaseClient, names: string[]) =>
  call<{ items: { name: string; candidates: MatchCandidate[] }[] }>(supabase, 'exercises/media/match', { method: 'POST', body: { names } });
