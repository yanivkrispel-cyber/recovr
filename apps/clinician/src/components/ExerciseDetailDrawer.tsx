import { useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'shared';
import { Drawer, EmptyState, Skeleton, Button, YouTubeFacade } from 'ui';
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
// packages/shared/src/youtube.ts). Read-only here — every field, including
// this one, is edited through the single ExerciseFormModal now (see the
// Edit / Duplicate & Edit button below).
function ExerciseVideoPreview({ video, title }: { video: Media | null; title: string }) {
  if (!video) return null;
  return (
    <div style={{ marginBlockStart: 14 }}>
      <YouTubeFacade youtubeId={video.url} title={title} height={220} />
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
  /** Called with the new exercise id after "Duplicate" succeeds, so the caller can re-point this drawer (or a list) at the editable copy. */
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

  // System exercises can't be edited directly — this clones one into a
  // clinic-owned copy and re-points the view at it (onDuplicated). Editing
  // that copy is then a separate step via the Edit button.
  async function handleDuplicate() {
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
            <div style={{ display: 'flex', gap: 6, marginInlineStart: 'auto' }}>
              {data.source === 'clinic' && (
                <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
                  ערוך · Edit
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={handleDuplicate} loading={duplicating}>
                שכפל · Duplicate
              </Button>
            </div>
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

          <ExerciseVideoPreview
            video={data.media.find((m) => m.kind === 'video') ?? null}
            title={data.name_en ?? data.name}
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
          video_youtube_id: data.media.find((m) => m.kind === 'video')?.url ?? null,
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
