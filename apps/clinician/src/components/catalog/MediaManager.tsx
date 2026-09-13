// T-31 media section of the exercise editor: everything attached to one
// exercise — upload, YouTube, order / primary, rights, trim, verify, remove.
import { useContext, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
  MEDIA_RIGHTS, checkUpload, formatBytes, formatTimecode, mediaKindLabel, mediaRightsLabel, parseTimecode, parseYouTubeId,
  t, validTrim, youtubeThumbUrl, type MediaRights,
} from 'shared';
import { Button, YouTubeFacade, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import {
  CatalogApiError, addMedia, mediaSrc, removeMedia, reorderMedia, updateMedia, verifyMedia,
  type CatalogExercise, type CatalogMedia,
} from './catalogApi';
import { fieldLabelStyle, linkButtonStyle, smallButtonStyle, textInputStyle } from './catalogUi';
import { uploadMediaFile, type UploadError } from './mediaUpload';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm';

const badge = (bg: string, fg: string): CSSProperties => ({
  fontSize: 10.5, fontWeight: 700, borderRadius: 'var(--radius-pill)', padding: '2px 8px', background: bg, color: fg, whiteSpace: 'nowrap',
});

export function uploadErrorText(err: UploadError, name: string): string {
  switch (err) {
    case 'unsupported_type': return t('media.upload.unsupported', { name });
    case 'too_large': return t('media.upload.too_large', { name });
    case 'rights_required': return t('media.upload.rights_required');
    default: return t('media.upload.failed', { name });
  }
}

/** Thumbnail-sized preview for any media kind. */
export function MediaThumb({ media, size = 120, live = false }: { media: Pick<CatalogMedia, 'kind' | 'url' | 'thumb_url'>; size?: number; live?: boolean }) {
  const box: CSSProperties = { width: size, height: size, borderRadius: 10, overflow: 'hidden', background: 'var(--shell-sidebar-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', position: 'relative' };
  if (media.kind === 'video' && media.url) {
    return (
      <span style={box}>
        <img src={youtubeThumbUrl(media.url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <span aria-hidden style={{ position: 'absolute', fontSize: size / 4, color: 'var(--white)', textShadow: '0 1px 4px rgba(0,0,0,.6)' }}>▶</span>
      </span>
    );
  }
  if (media.kind === 'clip' && live && media.url) {
    return (
      <span style={box}>
        <video src={mediaSrc(media.url)} poster={media.thumb_url ? mediaSrc(media.thumb_url) : undefined} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </span>
    );
  }
  const src = media.kind === 'image' || media.kind === 'gif' ? (media.url ?? media.thumb_url) : media.thumb_url;
  return (
    <span style={box}>
      {src ? <img src={mediaSrc(src)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span aria-hidden style={{ color: 'var(--muted-2)' }}>◌</span>}
      {media.kind === 'clip' && <span aria-hidden style={{ position: 'absolute', insetBlockEnd: 5, insetInlineStart: 5, ...badge('rgba(0,0,0,.55)', 'var(--white)') }}>▶</span>}
    </span>
  );
}

export function RightsSelect({ value, onChange, disabled, allowUnknown = true, id }: { value: MediaRights | ''; onChange: (r: MediaRights) => void; disabled?: boolean; allowUnknown?: boolean; id?: string }) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as MediaRights)}
      style={{ ...textInputStyle, padding: '6px 8px', fontSize: 12.5, color: value === 'unknown' || value === '' ? 'var(--danger)' : 'var(--ink)' }}
    >
      {value === '' && <option value="">{t('media.rights.label')}…</option>}
      {MEDIA_RIGHTS.filter((r) => allowUnknown || r !== 'unknown').map((r) => <option key={r} value={r}>{mediaRightsLabel(r)}</option>)}
    </select>
  );
}

export default function MediaManager({
  ex, readOnly, onChanged,
}: {
  ex: CatalogExercise;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rights, setRights] = useState<MediaRights | ''>('');
  const [attribution, setAttribution] = useState('');
  const [verify, setVerify] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<{ key: string; name: string; state: 'uploading' | 'error'; error?: string }[]>([]);
  const [yt, setYt] = useState({ link: '', start: '', end: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const media = ex.media;
  const ownScope = media.filter((m) => m.scope === ex.media_scope);
  const otherScope = media.filter((m) => m.scope !== ex.media_scope);

  async function run(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key);
    try {
      await fn();
      if (success) toast.show(success, { tone: 'success' });
      onChanged();
    } catch (e) {
      const msg = e instanceof CatalogApiError ? e.body.message : undefined;
      toast.show(msg === 'video_exists' ? t('media.youtube.exists') : msg === 'rights_required' ? t('media.upload.rights_required') : t('error.save.body'), { tone: 'error', duration: 4000 });
    } finally {
      setBusy(null);
    }
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    if (!rights || (verify && rights === 'unknown')) {
      toast.show(t('media.upload.rights_required'), { tone: 'error' });
      return;
    }
    let ok = 0;
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const pre = checkUpload(file.type, file.size);
      if (!pre.ok) {
        toast.show(uploadErrorText(pre.reason, file.name), { tone: 'error', duration: 4000 });
        continue;
      }
      setUploads((u) => [...u, { key, name: file.name, state: 'uploading' }]);
      try {
        await uploadMediaFile(supabase, ex.id, file, { rights, attribution: attribution.trim() || undefined, verify: verify && rights !== 'unknown' });
        setUploads((u) => u.filter((x) => x.key !== key));
        ok++;
        onChanged(); // show each file as it lands, not after the whole batch
      } catch (err) {
        const text = uploadErrorText(String(err), file.name);
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'error', error: text } : x)));
      }
    }
    if (ok > 0) toast.show(t('media.upload.done'), { tone: 'success' });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    void uploadFiles(Array.from(e.dataTransfer.files));
  }

  async function addYoutube() {
    const id = parseYouTubeId(yt.link);
    const start = parseTimecode(yt.start);
    const end = parseTimecode(yt.end);
    if (!id || !validTrim(start, end)) return;
    await run('yt', () => addMedia(supabase, ex.id, { kind: 'video', youtube_id: id, rights: 'embed', start_sec: start, end_sec: end, verify }), t('media.upload.done'));
    setYt({ link: '', start: '', end: '' });
  }

  function move(list: CatalogMedia[], index: number, to: number) {
    const ids = list.map((m) => m.id);
    const [id] = ids.splice(index, 1);
    ids.splice(to, 0, id);
    void run(`order-${id}`, () => reorderMedia(supabase, ex.id, ids));
  }

  const ytId = parseYouTubeId(yt.link);
  const ytTrimValid = validTrim(parseTimecode(yt.start), parseTimecode(yt.end));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {t('media.not_shown_hint')}{' '}
        {!readOnly && (ex.media_scope === 'master' ? t('media.curator_scope') : !ex.is_clinic_owned ? t('media.master_readonly') : '')}
      </div>

      {media.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('media.empty')}</div>}

      {[ownScope, otherScope].map((list, gi) => list.length > 0 && (
        <div key={gi} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((m, i) => (
            <MediaRow
              key={m.id}
              m={m}
              isPrimary={media[0]?.id === m.id}
              readOnly={readOnly || !m.can_manage}
              reorderable={!readOnly && gi === 0 && list.length > 1}
              index={i}
              count={list.length}
              busy={busy}
              onMove={(to) => move(list, i, to)}
              onUpdate={(patch) => run(`upd-${m.id}`, () => updateMedia(supabase, m.id, patch))}
              onVerify={(v) => run(`ver-${m.id}`, async () => {
                const res = await verifyMedia(supabase, [m.id], v);
                if (res.skipped.length) throw new CatalogApiError({ error: 'validation_failed', message: 'rights_required' });
              })}
              onRemove={() => {
                if (window.confirm(t('media.remove.confirm'))) void run(`rm-${m.id}`, () => removeMedia(supabase, m.id));
              }}
            />
          ))}
        </div>
      ))}

      {!readOnly && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBlockStart: 12, borderBlockStart: '1px dashed var(--line-soft)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={fieldLabelStyle}>{t('media.rights.label')}</span>
              <RightsSelect value={rights} onChange={setRights} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={fieldLabelStyle}>{t('media.attribution')}</span>
              <input value={attribution} onChange={(e) => setAttribution(e.target.value)} style={{ ...textInputStyle, padding: '6px 9px', fontSize: 13 }} />
            </label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)' }}>
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            {t('media.upload.verify')}
          </label>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? 'var(--gold-deep)' : 'var(--line)'}`, borderRadius: 'var(--radius-card)',
              background: dragOver ? 'var(--nav-active-bg)' : 'var(--paper)', padding: '18px 14px', textAlign: 'center', cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>⬆ {t('media.drop.title')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBlockStart: 4 }}>{t('media.drop.hint')}</div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                void uploadFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </div>
          {uploads.map((u) => (
            <div key={u.key} style={{ fontSize: 12.5, color: u.state === 'error' ? 'var(--danger)' : 'var(--ink-soft)', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{u.state === 'uploading' ? t('media.upload.uploading', { name: u.name }) : u.error}</span>
              {u.state === 'error' && <button type="button" style={linkButtonStyle} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>×</button>}
            </div>
          ))}

          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 'var(--radius-card)',
              // a pasted link isn't saved until "Add video" — make that state impossible to miss
              background: ytId ? 'var(--nav-active-bg)' : 'transparent',
              border: ytId ? '1px solid var(--gold-deep)' : '1px solid transparent',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 220px' }}>
                <span style={fieldLabelStyle}>{t('media.youtube.add')}</span>
                <input
                  dir="ltr"
                  value={yt.link}
                  placeholder={t('media.youtube.placeholder')}
                  onChange={(e) => setYt({ ...yt, link: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && ytId && ytTrimValid) {
                      e.preventDefault();
                      void addYoutube();
                    }
                  }}
                  style={{ ...textInputStyle, direction: 'ltr', textAlign: 'left', padding: '6px 9px', fontSize: 13, borderColor: yt.link.trim() && !ytId ? 'var(--danger)' : undefined }}
                />
              </label>
              <TrimInputs start={yt.start} end={yt.end} onChange={(start, end) => setYt({ ...yt, start, end })} />
              <Button size="sm" variant={ytId ? 'primary' : 'secondary'} disabled={!ytId || !ytTrimValid} loading={busy === 'yt'} onClick={addYoutube}>
                + {t('media.youtube.submit')}
              </Button>
            </div>
            {yt.link.trim() !== '' && !ytId && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('catalog.field.video.invalid')}</span>}
            {!ytTrimValid && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('media.trim.invalid')}</span>}
            {ytId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <MediaThumb media={{ kind: 'video', url: ytId, thumb_url: null }} size={64} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gold-deep)' }}>{t('media.youtube.pending')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TrimInputs({ start, end, onChange, onCommit, disabled }: { start: string; end: string; onChange: (s: string, e: string) => void; onCommit?: () => void; disabled?: boolean }) {
  const small: CSSProperties = { ...textInputStyle, direction: 'ltr', width: 64, padding: '6px 7px', fontSize: 12.5, textAlign: 'center' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={fieldLabelStyle}>{t('media.trim')}</span>
      <span dir="ltr" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)' }}>
        <input aria-label={t('media.trim.start')} placeholder="0:00" value={start} disabled={disabled} onChange={(e) => onChange(e.target.value, end)} onBlur={onCommit} style={small} />
        –
        <input aria-label={t('media.trim.end')} placeholder="1:30" value={end} disabled={disabled} onChange={(e) => onChange(start, e.target.value)} onBlur={onCommit} style={small} />
      </span>
    </div>
  );
}

function MediaRow({
  m, isPrimary, readOnly, reorderable, index, count, busy, onMove, onUpdate, onVerify, onRemove,
}: {
  m: CatalogMedia;
  isPrimary: boolean;
  readOnly: boolean;
  reorderable: boolean;
  index: number;
  count: number;
  busy: string | null;
  onMove: (to: number) => void;
  onUpdate: (patch: Partial<CatalogMedia>) => void;
  onVerify: (verified: boolean) => void;
  onRemove: () => void;
}) {
  const [attribution, setAttribution] = useState(m.attribution ?? '');
  const [trim, setTrim] = useState({ start: formatTimecode(m.start_sec), end: formatTimecode(m.end_sec) });
  const [expanded, setExpanded] = useState(false);
  const trimStart = parseTimecode(trim.start);
  const trimEnd = parseTimecode(trim.end);
  const trimValid = validTrim(trimStart, trimEnd);
  const trimmable = m.kind === 'video' || m.kind === 'clip';

  return (
    <div style={{ display: 'flex', gap: 12, padding: 10, borderRadius: 'var(--radius-card)', border: isPrimary ? '1.5px solid var(--gold-deep)' : '1px solid var(--line-soft)', background: 'var(--white)' }}>
      <button type="button" onClick={() => setExpanded((x) => !x)} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} aria-expanded={expanded}>
        <MediaThumb media={m} size={96} />
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={badge('var(--cream)', 'var(--ink-soft)')}>{mediaKindLabel(m.kind)}</span>
          {isPrimary && <span style={badge('var(--gold-deep)', 'var(--cream)')}>★ {t('media.primary')}</span>}
          <span style={badge('var(--nav-active-bg)', 'var(--gold-deep)')}>{t(m.scope === 'master' ? 'media.scope.master' : 'media.scope.clinic')}</span>
          {m.verified
            ? <span style={badge('var(--pill-good-bg)', 'var(--flag-green)')}>✓ {t('media.verified')}</span>
            : <span style={badge('var(--pill-attention-bg)', 'var(--flag-red)')}>{t('media.pending')}</span>}
          {m.verified && m.rights === 'unknown' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{t('media.queue.rights_warning')}</span>}
          <span dir="ltr" style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
            {m.source_file ?? (m.kind === 'video' ? m.url : '')}{m.size_bytes ? ` · ${formatBytes(m.size_bytes)}` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 150px' }}>
            <span style={fieldLabelStyle}>{t('media.rights.label')}</span>
            <RightsSelect value={m.rights} disabled={readOnly} onChange={(r) => onUpdate({ rights: r })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '2 1 180px' }}>
            <span style={fieldLabelStyle}>{t('media.attribution')}</span>
            <input
              value={attribution}
              disabled={readOnly}
              onChange={(e) => setAttribution(e.target.value)}
              onBlur={() => { if (attribution !== (m.attribution ?? '')) onUpdate({ attribution }); }}
              style={{ ...textInputStyle, padding: '6px 9px', fontSize: 12.5 }}
            />
          </label>
          {trimmable && (
            <TrimInputs
              start={trim.start}
              end={trim.end}
              disabled={readOnly}
              onChange={(start, end) => setTrim({ start, end })}
              onCommit={() => {
                if (trimValid && (trimStart !== m.start_sec || trimEnd !== m.end_sec)) onUpdate({ start_sec: trimStart, end_sec: trimEnd });
              }}
            />
          )}
        </div>
        {trimmable && !trimValid && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('media.trim.invalid')}</span>}

        {!readOnly && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {m.verified
              ? <button type="button" style={smallButtonStyle} disabled={!!busy} onClick={() => onVerify(false)}>{t('media.unverify')}</button>
              : (
                <button
                  type="button"
                  style={{ ...smallButtonStyle, borderColor: 'var(--flag-green)', color: 'var(--flag-green)', opacity: m.rights === 'unknown' ? 0.5 : 1 }}
                  disabled={!!busy || m.rights === 'unknown'}
                  title={m.rights === 'unknown' ? t('media.upload.rights_required') : undefined}
                  onClick={() => onVerify(true)}
                >
                  ✓ {t('media.verify')}
                </button>
              )}
            {reorderable && (
              <>
                {index > 0 && <button type="button" style={smallButtonStyle} disabled={!!busy} onClick={() => onMove(0)}>★ {t('media.make_primary')}</button>}
                <button type="button" aria-label={t('catalog.field.move_up')} style={{ ...smallButtonStyle, opacity: index === 0 ? 0.35 : 1 }} disabled={!!busy || index === 0} onClick={() => onMove(index - 1)}>↑</button>
                <button type="button" aria-label={t('catalog.field.move_down')} style={{ ...smallButtonStyle, opacity: index === count - 1 ? 0.35 : 1 }} disabled={!!busy || index === count - 1} onClick={() => onMove(index + 1)}>↓</button>
              </>
            )}
            <button type="button" style={{ ...smallButtonStyle, color: 'var(--danger)', marginInlineStart: 'auto' }} disabled={!!busy} onClick={onRemove}>{t('media.remove')}</button>
          </div>
        )}

        {expanded && (
          <div style={{ maxWidth: 420 }}>
            {m.kind === 'video' && m.url
              ? <YouTubeFacade youtubeId={m.url} title={m.source_file ?? 'YouTube'} height={220} startSec={m.start_sec} endSec={m.end_sec} />
              : <MediaThumb media={m} size={320} live />}
          </div>
        )}
      </div>
    </div>
  );
}
