// T-30 "how the patient sees it" — renders the editor's current values in the
// patient app's visual language. Media shows only when verified, same rule
// as the patient app (CLAUDE.md §Media).
import { t } from 'shared';
import { Modal, YouTubeFacade } from 'ui';
import { mediaSrc, type CatalogMedia, type EditableFields } from './catalogApi';

export default function PatientPreview({
  open, onClose, fields, media,
}: {
  open: boolean;
  onClose: () => void;
  fields: EditableFields;
  media: CatalogMedia[];
}) {
  // same selection the patient app makes: verified only, list order, YouTube separately
  const verified = media.filter((m) => m.verified && m.url);
  const primary = verified.find((m) => m.kind !== 'video') ?? null;
  const video = verified.find((m) => m.kind === 'video') ?? null;
  const steps = (fields.instructions ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const cues = fields.key_cues.map((c) => c.trim()).filter(Boolean);
  const safety = [fields.safety_notes, fields.contraindications].map((s) => s?.trim()).filter(Boolean) as string[];

  return (
    <Modal open={open} onClose={onClose} title={t('catalog.preview.title')} size="sm">
      <div style={{ background: 'var(--patient-bg)', borderRadius: 22, padding: 14, color: 'var(--patient-text)', fontFamily: 'var(--font-ui)' }}>
        <div style={{ background: 'var(--patient-card)', borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ height: 190, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--patient-card-light)' }}>
            {primary?.kind === 'clip'
              ? <video src={mediaSrc(primary.url!)} muted loop autoPlay playsInline style={{ maxHeight: 180, maxWidth: '100%' }} />
              : primary
                ? <img src={mediaSrc(primary.url!)} alt="" style={{ maxHeight: 180, objectFit: 'contain' }} />
                : <span style={{ fontSize: 12, color: 'var(--patient-muted)' }}>{t('catalog.preview.media_pending')}</span>}
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fields.name}</div>
              {fields.description && <div style={{ fontSize: 13, color: 'var(--patient-muted)', marginBlockStart: 4, lineHeight: 1.5 }}>{fields.description}</div>}
            </div>
            {video?.url && <YouTubeFacade youtubeId={video.url} title={fields.name} height={170} startSec={video.start_sec} endSec={video.end_sec} />}
            {steps.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--patient-gold)', marginBlockEnd: 6 }}>{t('catalog.preview.steps')}</div>
                <ol style={{ margin: 0, paddingInlineStart: 20, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13.5, lineHeight: 1.5 }}>
                  {steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>
            )}
            {cues.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--patient-gold)', marginBlockEnd: 6 }}>{t('catalog.preview.cues')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {cues.map((c) => (
                    <span key={c} style={{ fontSize: 12.5, border: '1px solid var(--patient-border)', borderRadius: 'var(--radius-pill)', padding: '4px 10px' }}>{c}</span>
                  ))}
                </div>
              </div>
            )}
            {safety.length > 0 && (
              <div style={{ border: '1px solid var(--patient-danger)', borderRadius: 12, padding: '9px 11px', fontSize: 12.5, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, color: 'var(--patient-danger)', marginBlockEnd: 3 }}>{t('catalog.preview.safety')}</div>
                {safety.map((s, i) => <div key={i}>{s}</div>)}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
