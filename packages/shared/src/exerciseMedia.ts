// T-31 exercise media manager — shared rules for uploads, rights, trimming
// and bulk-import filename matching. The server re-validates everything here
// (app.catalog_media_add / the exercises edge function); these exist so the
// UI can reject a bad file before uploading it.
import { t } from './i18n';

export const MEDIA_RIGHTS = ['own', 'licensed', 'open', 'embed', 'unknown'] as const;
export type MediaRights = (typeof MEDIA_RIGHTS)[number];

export type UploadKind = 'image' | 'gif' | 'clip';
export type MediaKind = UploadKind | 'video';

/** Accepted upload types and their size caps (bytes). Mirrored in supabase/functions/exercises. */
export const UPLOAD_RULES: Record<string, { kind: UploadKind; maxBytes: number; ext: string }> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: 'jpg' },
  'image/png': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: 'png' },
  'image/webp': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: 'webp' },
  'image/gif': { kind: 'gif', maxBytes: 15 * 1024 * 1024, ext: 'gif' },
  'video/mp4': { kind: 'clip', maxBytes: 50 * 1024 * 1024, ext: 'mp4' },
  'video/webm': { kind: 'clip', maxBytes: 50 * 1024 * 1024, ext: 'webm' },
};

export type UploadCheck =
  | { ok: true; kind: UploadKind; ext: string }
  | { ok: false; reason: 'unsupported_type' | 'too_large'; maxBytes?: number };

export function checkUpload(mimeType: string, sizeBytes: number): UploadCheck {
  const rule = UPLOAD_RULES[mimeType];
  if (!rule) return { ok: false, reason: 'unsupported_type' };
  if (sizeBytes > rule.maxBytes) return { ok: false, reason: 'too_large', maxBytes: rule.maxBytes };
  return { ok: true, kind: rule.kind, ext: rule.ext };
}

/**
 * Turns an uploaded file name into the text matched against exercise names:
 * extension and leading numbering removed ("03 - heel_slide.mp4" ->
 * "heel slide"), camelCase split, separators collapsed, lower-cased.
 * Hebrew letters are kept as-is.
 */
export function normalizeMediaFilename(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const noExt = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return noExt
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.+()[\]]+/g, ' ')
    .replace(/^\s*\d+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "1:05" -> 65, "90" -> 90, "1:02:03" -> 3723; blank -> null; anything else -> NaN. */
export function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return Number.NaN;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some((p) => p > 59)) return Number.NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTimecode(sec: number | null | undefined): string {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A trim window is valid when each side is blank or a timecode and end > start. */
export function validTrim(start: number | null, end: number | null): boolean {
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start != null && start < 0) return false;
  if (end != null && end <= (start ?? 0)) return false;
  return true;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaRightsLabel(r: string): string {
  switch (r) {
    case 'own': return t('media.rights.own');
    case 'licensed': return t('media.rights.licensed');
    case 'open': return t('media.rights.open');
    case 'embed': return t('media.rights.embed');
    case 'unknown': return t('media.rights.unknown');
    default: return r;
  }
}

export function mediaKindLabel(k: string): string {
  switch (k) {
    case 'image': return t('media.kind.image');
    case 'gif': return t('media.kind.gif');
    case 'clip': return t('media.kind.clip');
    case 'video': return t('media.kind.video');
    default: return k;
  }
}
