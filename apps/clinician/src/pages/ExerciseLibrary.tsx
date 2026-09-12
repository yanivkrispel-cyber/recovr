import { useContext, useState, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'shared';
import { Badge, Button, EmptyState, Skeleton, useIsTablet } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';
import ExerciseDetailDrawer from '../components/ExerciseDetailDrawer';
import ExerciseFormModal from '../components/ExerciseFormModal';

interface Prescription {
  sets?: number;
  reps?: number;
  load?: number;
  tempo?: string;
  hold_sec?: number;
  side?: string;
}

interface ExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  region: string | null;
  is_bilateral: boolean;
  source: 'system' | 'clinic';
  protocol_labels: string[];
  prescription: Prescription | null;
}

interface FilterOptions {
  categories: string[];
  regions: string[];
  phases: number[];
  protocols: { slug: string; name: string }[];
  custom_count: number;
}

const PAGE_SIZE = 60;

// Single source of truth for the table's column widths — used by both the
// header and every row so they can never drift out of alignment. minmax(0, …)
// (rather than a bare fr) keeps a long unbroken name/label from blowing a
// track wider than its share instead of wrapping inside it.
const EXERCISE_ROW_GRID = 'minmax(0, 2.2fr) minmax(0, 1.6fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1.1fr)';

const categoryLabel: Record<string, string> = {
  Mobility: 'ניידות',
  Strength: 'כוח',
  Balance: 'שיווי משקל',
  Control: 'בקרה',
  Cardio: 'אירובי',
};

function formatPrescription(rx: Prescription | null): string {
  if (!rx) return '—';
  if (rx.sets != null && rx.reps != null) return `${rx.sets} × ${rx.reps}`;
  if (rx.hold_sec != null) return `${rx.hold_sec} שנ׳`;
  if (rx.reps != null) return `${rx.reps} חזרות`;
  return '—';
}

function chipStyle(active: boolean): CSSProperties {
  return active
    ? { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 12, fontWeight: 600, letterSpacing: '0.03em', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
    : { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'transparent', border: '1px solid rgba(34,28,20,0.2)', color: 'var(--nav-inactive-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' };
}

export default function ExerciseLibrary() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const isTablet = useIsTablet(); // T-22: tablet is view-only for v1

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [protocol, setProtocol] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: options } = useQuery({
    queryKey: ['exercise-filter-options'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('exercises/filter-options', { method: 'GET' });
      if (error) throw error;
      return data as FilterOptions;
    },
  });

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['exercises', query, category, protocol],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category) params.set('category', category);
      if (protocol) params.set('protocol', protocol);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(pageParam));
      const { data, error } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
      if (error) throw error;
      return data as { items: ExerciseRow[]; total: number };
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const exercises = data?.pages.flatMap((p) => p.items);
  const matchingCount = data?.pages[0]?.total ?? 0;

  async function handleDuplicate(id: string) {
    setDuplicatingId(id);
    await supabase.functions.invoke(`exercises/${id}/duplicate`, { method: 'POST' });
    setDuplicatingId(null);
    queryClient.invalidateQueries({ queryKey: ['exercises'] });
  }

  async function handleDelete(id: string) {
    if (!window.confirm(`${t('confirm.delete_exercise.title')}\n${t('confirm.delete_exercise.body')}`)) return;
    setDeletingId(id);
    await supabase.functions.invoke(`exercises/${id}`, { method: 'DELETE' });
    setDeletingId(null);
    queryClient.invalidateQueries({ queryKey: ['exercises'] });
    queryClient.invalidateQueries({ queryKey: ['exercise-filter-options'] });
  }

  if (!user) return null;

  const customCount = options?.custom_count ?? 0;
  const hasFilters = query.trim().length > 0 || category.length > 0 || protocol.length > 0;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
              {t('clinician.exercise.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Exercise Library</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
              {hasFilters
                ? `${matchingCount} תוצאות תואמות`
                : `${matchingCount} תרגילים בספרייה`} · {customCount} נוצרו על ידך
              {(exercises?.length ?? 0) < matchingCount && ` · מוצגים ${exercises?.length ?? 0}`}
            </div>
          </div>
          {!isTablet && <Button onClick={() => setCreateOpen(true)}>+ תרגיל חדש · New Exercise</Button>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              style={{ padding: '9px 12px', border: '1px solid var(--shell-border)', borderRadius: 9, fontFamily: 'inherit', fontSize: 13, maxWidth: 320, background: 'var(--white)' }}
            >
              <option value="">כל הפתולוגיות · All pathologies</option>
              {(options?.protocols ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חפש תרגילים... · Search exercises..."
              style={{ flex: 1, padding: '9px 12px', border: '1px solid var(--shell-border)', borderRadius: 9, fontFamily: 'inherit', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => setCategory('')} style={chipStyle(category === '')}>הכל</button>
            {(options?.categories ?? []).map((c) => (
              <button key={c} onClick={() => setCategory(c)} style={chipStyle(category === c)}>
                {categoryLabel[c] ?? c}
              </button>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: EXERCISE_ROW_GRID, padding: '12px 18px', fontSize: 12, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
            <div>תרגיל · Exercise</div><div>פתולוגיות · Pathologies</div><div>קטגוריה</div><div>מרשם</div><div />
          </div>

          {isLoading ? (
            <div style={{ padding: 20 }}><Skeleton count={6} height={18} /></div>
          ) : error ? (
            <div style={{ padding: 20 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>
          ) : exercises?.length === 0 ? (
            <div style={{ padding: 44, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, borderTop: '1px solid var(--shell-border-soft)' }}>
              לא נמצאו תרגילים · No exercises found
            </div>
          ) : (
            exercises?.map((ex) => (
              <div
                key={ex.id}
                onDoubleClick={() => setDetailId(ex.id)}
                style={{ display: 'grid', gridTemplateColumns: EXERCISE_ROW_GRID, padding: '13px 18px', borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center', gap: 10, cursor: 'pointer' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 7, overflowWrap: 'anywhere' }}>
                    {ex.name}
                    {ex.source === 'clinic' && (
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', background: 'var(--nav-active-bg)', border: '1px solid rgba(140,100,35,0.4)', color: 'var(--gold-deep)', padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap' }}>
                        נוצר על ידך
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 2, overflowWrap: 'anywhere' }}>{ex.name_en}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {ex.protocol_labels.length > 0 ? ex.protocol_labels.join(', ') : '—'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', minWidth: 0 }}>{categoryLabel[ex.category] ?? ex.category}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', minWidth: 0 }}>{formatPrescription(ex.prescription)}</div>
                <div onDoubleClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 7, justifyContent: 'flex-start' }}>
                  <button
                    onClick={() => setDetailId(ex.id)}
                    style={{ background: 'transparent', color: 'var(--ink-soft)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                  >
                    פרטים · Details
                  </button>
                  {!isTablet && (
                    <button
                      onClick={() => handleDuplicate(ex.id)}
                      disabled={duplicatingId === ex.id}
                      style={{ background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.5)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: duplicatingId === ex.id ? 0.5 : 1 }}
                    >
                      שכפל · Duplicate
                    </button>
                  )}
                  {!isTablet && ex.source === 'clinic' && (
                    <button
                      onClick={() => handleDelete(ex.id)}
                      disabled={deletingId === ex.id}
                      style={{ background: 'transparent', color: 'var(--flag-red)', border: '1px solid var(--flag-red)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: deletingId === ex.id ? 0.5 : 1 }}
                    >
                      מחק · Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          {hasNextPage && (
            <div style={{ padding: 16, textAlign: 'center', borderTop: '1px solid var(--shell-border-soft)' }}>
              <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                טען עוד · Load more ({(exercises?.length ?? 0)} / {matchingCount})
              </Button>
            </div>
          )}
        </div>
      </div>

      <ExerciseDetailDrawer
        exerciseId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        onDuplicated={(newId) => setDetailId(newId)}
      />

      <ExerciseFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['exercises'] });
          queryClient.invalidateQueries({ queryKey: ['exercise-filter-options'] });
        }}
      />
    </AppShell>
  );
}
