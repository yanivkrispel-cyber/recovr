import { useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t, parseYouTubeId } from 'shared';
import { Drawer, EmptyState, Skeleton, Input, Button, YouTubeFacade } from 'ui';
import { SupabaseContext } from '../App';
import ExerciseFormModal from './ExerciseFormModal';

interface Media {
  id: string;
  kind: 'image' | 'gif' | 'video';
  url: string;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  order: number;
  source_file: string | null;
  verified: boolean;
  verified_at: string | null;
}

interface ExerciseDetail {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  region: string | null;
  muscles: string[];
  equipment: string[];
  description: string | null;
  instructions: string | null;
  common_mistakes: string | null;
  safety_notes: string | null;
  is_bilateral: boolean;
  source: 'system' | 'clinic';
  external_ref: string | null;
  protocol_labels: string[];
  media: Media[];
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

function mediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

const categoryLabel: Record<string, string> = {
  Mobility: 'ניידות',
  Strength: 'כוח',
  Balance: 'שיווי משקל',
  Control: 'בקרה',
  Cardio: 'אירובי',
};

const chip: CSSProperties = {
  display: 'inline-block',
  padding: '3px 9px',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--nav-active-bg)',
  color: 'var(--gold-deep)',
  fontSize: 11,
  fontWeight: 600,
  marginInlineEnd: 6,
  marginBlockEnd: 6,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBlockStart: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--nav-inactive-text)', marginBlockEnd: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

// Supplementary tutorial video (kind='video', url is a YouTube id — see
// packages/shared/src/youtube.ts). Editable only for clinic-owned exercises,
// same rule as every other exercise edit here; a system-library video (once
// dataset ingest ever populates one) is view-only via the facade.
function ExerciseVideoEditor({
  exerciseId,
  video,
  editable,
  title,
  onDuplicateToEdit,
  duplicating,
}: {
  exerciseId: string;
  video: Media | null;
  editable: boolean;
  title: string;
  onDuplicateToEdit?: () => void;
  duplicating?: boolean;
}) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(youtubeId: string | null) {
    setSaving(true);
    setSaveError(null);
    const { data, error } = await supabase.functions.invoke(`exercises/${exerciseId}/video`, {
      method: 'PUT',
      body: { youtube_id: youtubeId },
    });
    setSaving(false);
    if (error || (data as { error?: string })?.error) {
      setSaveError('שמירת הסרטון נכשלה · Couldn’t save the video');
      return;
    }
    setEditing(false);
    setInput('');
    queryClient.invalidateQueries({ queryKey: ['exercise-detail', exerciseId] });
  }

  function handleSave() {
    const id = parseYouTubeId(input);
    if (!id) {
      setSaveError('קישור YouTube לא תקין · Not a recognizable YouTube link');
      return;
    }
    save(id);
  }

  if (!editable && !video && !onDuplicateToEdit) return null;

  return (
    <div style={{ marginBlockStart: 14 }}>
      {video && !editing && <YouTubeFacade youtubeId={video.url} title={title} height={220} />}

      {!editable && onDuplicateToEdit && (
        <div style={{ marginBlockStart: video ? 8 : 0 }}>
          <Button size="sm" variant="secondary" onClick={onDuplicateToEdit} loading={duplicating}>
            שכפל לספריית המרפאה כדי להוסיף סרטון · Duplicate to your clinic library to add a video
          </Button>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)', marginBlockStart: 5, lineHeight: 1.5 }}>
            זהו תרגיל ממערכת — לא ניתן לערוך אותו ישירות. השכפול יוצר עותק בספרייה שלכם שאפשר לערוך ולהוסיף לו סרטון. ·
            This is a system exercise and can't be edited directly. Duplicating creates an editable copy in your clinic library.
          </div>
        </div>
      )}

      {editable && (
        <div style={{ marginBlockStart: video && !editing ? 8 : 0 }}>
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="https://youtube.com/watch?v=…"
                dir="ltr"
                error={saveError ?? undefined}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" onClick={handleSave} loading={saving}>
                  שמור · Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setInput(''); setSaveError(null); }}>
                  ביטול · Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {video ? 'החלף סרטון · Replace video' : '+ הוסף סרטון YouTube · Add YouTube video'}
              </Button>
              {video && (
                <Button size="sm" variant="ghost" onClick={() => save(null)} loading={saving}>
                  הסר · Remove
                </Button>
              )}
            </div>
          )}
          {saveError && !editing && <div style={{ fontSize: 12, color: 'var(--danger)', marginBlockStart: 6 }}>{saveError}</div>}
        </div>
      )}
    </div>
  );
}

export default function ExerciseDetailDrawer({
  exerciseId,
  open,
  onClose,
  onDuplicated,
}: {
  exerciseId: string | null;
  open: boolean;
  onClose: () => void;
  /** Called with the new exercise id after "duplicate to add a video" succeeds, so the caller can re-point this drawer (or a list) at the editable copy. */
  onDuplicated?: (newExerciseId: string) => void;
}) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [duplicating, setDuplicating] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['exercise-detail', exerciseId],
    enabled: open && !!exerciseId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`exercises/${exerciseId}`, { method: 'GET' });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as ExerciseDetail;
    },
  });

  async function handleDuplicateToEdit() {
    if (!exerciseId) return;
    setDuplicating(true);
    const { data: result, error } = await supabase.functions.invoke(`exercises/${exerciseId}/duplicate`, { method: 'POST' });
    setDuplicating(false);
    const newId = (result as { id?: string })?.id;
    if (error || !newId) return;
    queryClient.invalidateQueries({ queryKey: ['exercises'] });
    queryClient.invalidateQueries({ queryKey: ['exercise-filter-options'] });
    onDuplicated?.(newId);
  }

  const primary = data?.media?.find((m) => m.kind === 'gif') ?? data?.media?.[0] ?? null;

  return (
    <>
    <Drawer open={open} onClose={onClose} title={data?.name ?? 'פרטי תרגיל · Exercise detail'} width="460px">
      {isLoading ? (
        <Skeleton count={7} height={18} />
      ) : error || !data ? (
        <EmptyState title={t('error.generic.title')} body={t('error.generic.body')} />
      ) : (
        <>
          {data.name_en && (
            <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)', marginBlockEnd: 4 }}>{data.name_en}</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={chip}>{categoryLabel[data.category] ?? data.category}</span>
            {data.region && <span style={chip}>{data.region}</span>}
            {data.is_bilateral && <span style={chip}>דו-צדדי</span>}
            {data.source === 'clinic' && <span style={chip}>נוצר על ידך</span>}
            {data.source === 'clinic' && (
              <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)} style={{ marginInlineStart: 'auto' }}>
                ערוך · Edit
              </Button>
            )}
          </div>

          {primary && (
            <div style={{ marginBlockStart: 14 }}>
              <div
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  border: '1px solid var(--line-soft)',
                  borderRadius: 'var(--radius-card)',
                  overflow: 'hidden',
                  background: 'var(--shell-sidebar-bg)',
                }}
              >
                <img
                  src={mediaSrc(primary.url)}
                  alt={data.name_en ?? data.name}
                  width={primary.width ?? 180}
                  height={primary.height ?? 180}
                  style={{ display: 'block', width: 240, height: 240, objectFit: 'contain', opacity: primary.verified ? 1 : 0.92 }}
                />
                {!primary.verified && (
                  <span
                    style={{
                      position: 'absolute',
                      insetBlockStart: 8,
                      insetInlineStart: 8,
                      background: 'var(--flag-red)',
                      color: 'var(--white)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      padding: '3px 8px',
                      borderRadius: 5,
                    }}
                  >
                    לא מאומת · UNVERIFIED
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)', marginBlockStart: 5 }}>
                © Gym visual — https://gymvisual.com/
              </div>
              {!primary.verified && (
                <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)', marginBlockStart: 4, lineHeight: 1.5 }}>
                  מדיה זו לא תוצג למטופל או בתדפיס עד לאימות. · Not shown to patients or in the printed program until verified.
                </div>
              )}
            </div>
          )}

          <ExerciseVideoEditor
            exerciseId={data.id}
            video={data.media.find((m) => m.kind === 'video') ?? null}
            editable={data.source === 'clinic'}
            title={data.name_en ?? data.name}
            onDuplicateToEdit={data.source === 'system' ? handleDuplicateToEdit : undefined}
            duplicating={duplicating}
          />

          {data.instructions && <Section title="הוראות ביצוע · INSTRUCTIONS">{data.instructions}</Section>}
          {data.description && <Section title="תיאור · DESCRIPTION">{data.description}</Section>}
          {data.common_mistakes && <Section title="טעויות נפוצות · COMMON MISTAKES">{data.common_mistakes}</Section>}
          {data.safety_notes && <Section title="הערות בטיחות · SAFETY">{data.safety_notes}</Section>}

          {data.muscles.length > 0 && (
            <Section title="שרירים · MUSCLES">
              {data.muscles.map((m) => (
                <span key={m} style={chip}>{m}</span>
              ))}
            </Section>
          )}
          {data.equipment.length > 0 && (
            <Section title="ציוד · EQUIPMENT">
              {data.equipment.map((e) => (
                <span key={e} style={chip}>{e}</span>
              ))}
            </Section>
          )}
          {data.protocol_labels.length > 0 && (
            <Section title="פתולוגיות · PATHOLOGIES">{data.protocol_labels.join(', ')}</Section>
          )}

          {(data.external_ref || primary?.source_file) && (
            <div style={{ marginBlockStart: 20, fontSize: 10, color: 'var(--nav-inactive-text)' }}>
              {data.external_ref && <span>ref: {data.external_ref}</span>}
              {data.external_ref && primary?.source_file && ' · '}
              {primary?.source_file && <span>{primary.source_file}</span>}
            </div>
          )}
        </>
      )}
    </Drawer>
    {data && data.source === 'clinic' && (
      <ExerciseFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        exercise={{
          id: data.id,
          name: data.name,
          name_en: data.name_en,
          category: data.category,
          region: data.region,
          description: data.description,
          instructions: data.instructions,
          is_bilateral: data.is_bilateral,
        }}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['exercise-detail', exerciseId] });
          queryClient.invalidateQueries({ queryKey: ['exercises'] });
        }}
      />
    )}
    </>
  );
}
