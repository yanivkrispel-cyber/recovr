// T-31 browser side of a media upload: probe the file (dimensions, duration),
// render a JPEG thumbnail (first frame for GIF/clip), upload both straight to
// Storage through signed upload URLs, then register the row. Nothing is
// transcoded — the original file is what patients get.
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkUpload, type MediaRights } from 'shared';
import { CatalogApiError, addMedia, mediaUploadTargets, type UploadTarget } from './catalogApi';

const BUCKET = 'exercise-media';
const THUMB_MAX = 360;
// A video the browser can't decode (unsupported codec) never fires its load /
// seek events; without a deadline the upload would hang forever.
const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('probe_timeout')), PROBE_TIMEOUT_MS))]);
}

interface Probe {
  width: number;
  height: number;
  durationMs?: number;
  thumb: Blob;
}

function canvasToJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas_unavailable'));
  ctx.fillStyle = 'white'; // transparent PNG/GIF -> white, not black, in a JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('thumb_failed'))), 'image/jpeg', 0.82));
}

async function probeImage(file: File): Promise<Probe> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // for a GIF this is the first frame
    return { width: img.naturalWidth, height: img.naturalHeight, thumb: await canvasToJpeg(img, img.naturalWidth, img.naturalHeight) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeVideo(file: File): Promise<Probe> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video_unreadable'));
    });
    // a frame slightly in, so the thumbnail isn't a black fade-in
    const at = Math.min(0.5, (video.duration || 1) / 3);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = at;
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
      thumb: await canvasToJpeg(video, video.videoWidth, video.videoHeight),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type UploadError = 'unsupported_type' | 'too_large' | 'unreadable' | 'upload_failed' | 'rights_required' | string;

export interface UploadOptions {
  rights: MediaRights;
  attribution?: string;
  verify: boolean;
  primary?: boolean;
  /** pre-minted target (bulk import mints them in batches) */
  target?: UploadTarget;
}

/** Uploads one file to an exercise. Resolves with the new media id or throws an UploadError string. */
export async function uploadMediaFile(supabase: SupabaseClient, exerciseId: string, file: File, opts: UploadOptions): Promise<string> {
  const check = checkUpload(file.type, file.size);
  if (!check.ok) throw check.reason;

  let probe: Probe;
  try {
    probe = await withTimeout(check.kind === 'clip' ? probeVideo(file) : probeImage(file));
  } catch {
    throw 'unreadable';
  }

  const target = opts.target ?? (await mediaUploadTargets(supabase, exerciseId, [{ mime_type: file.type, size_bytes: file.size }])).targets[0];
  const storage = supabase.storage.from(BUCKET);
  const [main, thumb] = await Promise.all([
    storage.uploadToSignedUrl(target.path, target.token, file, { contentType: file.type }),
    storage.uploadToSignedUrl(target.thumb_path, target.thumb_token, probe.thumb, { contentType: 'image/jpeg' }),
  ]);
  if (main.error || thumb.error) throw 'upload_failed';

  try {
    const res = await addMedia(supabase, exerciseId, {
      kind: check.kind,
      path: target.path,
      thumb_path: target.thumb_path,
      source_file: file.name,
      width: probe.width,
      height: probe.height,
      duration_ms: probe.durationMs,
      mime_type: file.type,
      size_bytes: file.size,
      rights: opts.rights,
      attribution: opts.attribution,
      verify: opts.verify,
      primary: opts.primary,
    });
    return res.id;
  } catch (e) {
    throw e instanceof CatalogApiError ? (e.body.message ?? e.body.error) : 'upload_failed';
  }
}
