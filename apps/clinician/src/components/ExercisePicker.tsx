import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EXERCISE_CATEGORIES, equipmentLabel, exerciseCategoryLabel, formatRecommendReason, t, type BodyRegion, type I18nKey,
} from 'shared';
import { Button, Checkbox, EmptyState, QueryError, Select, Skeleton } from 'ui';
import { SupabaseContext } from '../App';
import ExerciseDetailDrawer from './ExerciseDetailDrawer';
import ExercisePickerCard, { formatPrescription, type PickerCardData } from './ExercisePickerCard';

// Smart exercise picker (T-29). One window for every "Add Exercise" entry
// point: context-aware recommendations with a visible "why", fast search and
// filters, favorites, recent picks, and a basket where the dose is set before
// anything lands in the phase. Ranking is computed server-side
// (app.recommend_exercises); nothing is ever added without the clinician
// picking it.

export type DoseField = 'sets' | 'reps' | 'hold_sec' | 'rest_sec';

export interface PickedExercise {
  exercise_id: string;
  name: string;
  name_en: string | null;
  category: string;
  sets: number | null;
  reps: number | null;
  hold_sec: number | null;
  rest_sec: number | null;
  frequency: string | null;
}

export interface ExercisePickerContext {
  entry: 'protocol' | 'plan';
  /** Saved protocol this phase belongs to (null while creating a new protocol). */
  protocolId: string | null;
  /** Explicit region; when null the server falls back to the protocol's region. */
  bodyRegionId: string | null;
  phaseN: number | null;
  phaseName?: string | null;
  /** Protocol / pathology name shown in the header. */
  label?: string | null;
}

interface ExercisePickerProps {
  open: boolean;
  onClose: () => void;
  context: ExercisePickerContext;
  /** Exercise ids already in the phase being edited. */
  existingIds: string[];
  /** Which dose inputs the basket shows — matches what the target editor stores. */
  doseFields: DoseField[];
  onAdd: (picked: PickedExercise[]) => void;
}

type View = 'recommended' | 'all' | 'favorites' | 'recent';
type PickSource = 'recommended' | 'search' | 'favorite' | 'recent';

interface Selected {
  card: PickerCardData;
  source: PickSource;
  sets: number | null;
  reps: number | null;
  hold_sec: number | null;
  rest_sec: number | null;
}

interface RecommendResponse {
  context: {
    protocol_id: string | null;
    body_region: BodyRegion | null;
    phase_n: number | null;
    region_protocol_total: number;
    anchor_categories: Record<string, string>;
  };
  items: PickerCardData[];
}

interface FilterOptions {
  categories: string[];
  body_regions: BodyRegion[];
  equipment: string[];
}

const PAGE_SIZE = 48;

const DOSE_LABEL_KEY = {
  sets: 'picker.basket.sets',
  reps: 'picker.basket.reps',
  hold_sec: 'picker.basket.hold_sec',
  rest_sec: 'picker.basket.rest_sec',
} as const satisfies Record<DoseField, I18nKey>;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

function newSessionId(): string {
  return crypto.randomUUID();
}

export default function ExercisePicker({ open, onClose, context, existingIds, doseFields, onAdd }: ExercisePickerProps) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState<View>('recommended');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [regionId, setRegionId] = useState('');
  const [equipment, setEquipment] = useState('');
  const [mediaOnly, setMediaOnly] = useState(false);
  const [selected, setSelected] = useState<Selected[]>([]);
  const [favOverrides, setFavOverrides] = useState<Record<string, boolean>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(newSessionId());
  const shownLoggedRef = useRef<Set<string>>(new Set());

  const debouncedQuery = useDebounced(query.trim(), 250);
  const existingSet = useMemo(() => new Set(existingIds), [existingIds]);
  const existingKey = useMemo(() => [...existingIds].sort().join(','), [existingIds]);
  const selectedIds = useMemo(() => selected.map((s) => s.card.id), [selected]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Fresh state for every opening — each opening is one picker session.
  useEffect(() => {
    if (!open) return;
    sessionIdRef.current = newSessionId();
    shownLoggedRef.current = new Set();
    setView('recommended');
    setQuery('');
    setCategory('');
    setRegionId('');
    setEquipment('');
    setMediaOnly(false);
    setSelected([]);
    setFavOverrides({});
    setDetailId(null);
    const h = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(h);
  }, [open]);

  const { data: filterOptions } = useQuery({
    queryKey: ['exercise-filter-options'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('exercises/filter-options', { method: 'GET' });
      if (error) throw error;
      return data as FilterOptions;
    },
    enabled: open,
  });

  function recommendParams(anchorIds: string[], excludeIds: string[], limit: number) {
    const params = new URLSearchParams();
    if (context.protocolId) params.set('protocol_id', context.protocolId);
    if (context.bodyRegionId) params.set('region_id', context.bodyRegionId);
    if (context.phaseN != null) params.set('phase', String(context.phaseN));
    if (anchorIds.length) params.set('anchor_ids', anchorIds.join(','));
    if (excludeIds.length) params.set('exclude_ids', excludeIds.join(','));
    params.set('limit', String(limit));
    return params;
  }

  // Main recommendations: anchored on what's already in the phase only, so the
  // grid stays put while the clinician is selecting.
  const recommend = useQuery({
    queryKey: ['picker-recommend', context.protocolId, context.bodyRegionId, context.phaseN, existingKey],
    queryFn: async () => {
      const params = recommendParams(existingIds, existingIds, 24);
      const { data, error } = await supabase.functions.invoke(`exercises/recommend?${params.toString()}`, { method: 'GET' });
      if (error) throw error;
      return data as RecommendResponse;
    },
    enabled: open,
  });

  // "Complete the selection": re-anchored on existing + selected, shown beside
  // the basket. Only suggestions the selection itself drives are kept.
  const completeKey = [...selectedIds].sort().join(',');
  const complete = useQuery({
    queryKey: ['picker-complete', context.protocolId, context.bodyRegionId, context.phaseN, existingKey, completeKey],
    queryFn: async () => {
      const ids = [...existingIds, ...selectedIds];
      const params = recommendParams(ids, ids, 8);
      const { data, error } = await supabase.functions.invoke(`exercises/recommend?${params.toString()}`, { method: 'GET' });
      if (error) throw error;
      return data as RecommendResponse;
    },
    enabled: open && selectedIds.length > 0,
    placeholderData: (prev) => prev,
  });

  const searchView = view === 'all' || view === 'favorites';
  const search = useInfiniteQuery({
    queryKey: ['picker-search', view, debouncedQuery, category, regionId, equipment, mediaOnly],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (debouncedQuery) params.set('q', debouncedQuery);
      if (category) params.set('category', category);
      if (regionId) params.set('region_id', regionId);
      if (equipment) params.set('equipment', equipment);
      if (mediaOnly) params.set('media', '1');
      if (view === 'favorites') params.set('favorites', '1');
      if (context.phaseN != null) params.set('phase', String(context.phaseN));
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(pageParam));
      const { data, error } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
      if (error) throw error;
      return data as { items: PickerCardData[]; total: number };
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    enabled: open && searchView,
  });

  const recent = useQuery({
    queryKey: ['picker-recent'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('exercises/recent', { method: 'GET' });
      if (error) throw error;
      return data as { items: PickerCardData[] };
    },
    enabled: open && view === 'recent',
  });

  const recommendedItems = recommend.data?.items ?? [];
  const resolvedRegion = recommend.data?.context.body_region ?? null;

  function logEvents(events: { exercise_id: string; event: 'shown' | 'added'; source?: PickSource; rank?: number; score?: number }[]) {
    if (events.length === 0) return;
    supabase.functions
      .invoke('exercises/picker-events', {
        method: 'POST',
        body: {
          picker_session_id: sessionIdRef.current,
          entry: context.entry,
          protocol_id: context.protocolId,
          body_region_id: resolvedRegion?.id ?? context.bodyRegionId,
          phase_n: context.phaseN,
          events,
        },
      })
      .catch(() => undefined); // best-effort: the log must never block picking
  }

  // Log each recommendation once per session, the first time it's shown.
  useEffect(() => {
    if (!open || view !== 'recommended' || recommendedItems.length === 0) return;
    const fresh = recommendedItems.filter((c) => !shownLoggedRef.current.has(c.id));
    fresh.forEach((c) => shownLoggedRef.current.add(c.id));
    logEvents(fresh.map((c) => ({ exercise_id: c.id, event: 'shown', source: 'recommended', rank: c.rank, score: c.score })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, recommend.data]);

  function isFavorite(card: PickerCardData) {
    return favOverrides[card.id] ?? card.is_favorite;
  }

  async function toggleFavorite(card: PickerCardData) {
    const next = !isFavorite(card);
    setFavOverrides((o) => ({ ...o, [card.id]: next }));
    const { error } = await supabase.functions.invoke(`exercises/${card.id}/favorite`, { method: next ? 'PUT' : 'DELETE' });
    if (error) {
      setFavOverrides((o) => ({ ...o, [card.id]: !next }));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['picker-search', 'favorites'] });
  }

  function toggleSelect(card: PickerCardData, source: PickSource) {
    if (existingSet.has(card.id)) return;
    setSelected((list) => {
      if (list.some((s) => s.card.id === card.id)) return list.filter((s) => s.card.id !== card.id);
      const rx = card.prescription;
      return [
        ...list,
        {
          card,
          source,
          sets: rx?.sets ?? 3,
          reps: rx?.reps ?? (rx?.hold_sec != null ? null : 10),
          hold_sec: rx?.hold_sec ?? null,
          rest_sec: doseFields.includes('rest_sec') ? 60 : null,
        },
      ];
    });
  }

  function updateDose(id: string, field: DoseField, value: string) {
    const n = value === '' ? null : Math.max(0, Number(value));
    setSelected((list) => list.map((s) => (s.card.id === id ? { ...s, [field]: n } : s)));
  }

  function commit() {
    if (selected.length === 0) return;
    const recRank = new Map(recommendedItems.map((c) => [c.id, c]));
    logEvents(selected.map((s) => {
      const rec = recRank.get(s.card.id) ?? (s.card.rank != null ? s.card : undefined);
      return { exercise_id: s.card.id, event: 'added', source: s.source, rank: rec?.rank, score: rec?.score };
    }));
    onAdd(selected.map((s) => ({
      exercise_id: s.card.id,
      name: s.card.name,
      name_en: s.card.name_en,
      category: s.card.category,
      sets: s.sets,
      reps: s.reps,
      hold_sec: s.hold_sec,
      rest_sec: s.rest_sec,
      frequency: s.card.frequency ?? null,
    })));
    queryClient.invalidateQueries({ queryKey: ['picker-recent'] });
    queryClient.invalidateQueries({ queryKey: ['picker-recommend'] });
    onClose();
  }

  function requestClose() {
    if (selected.length > 0 && !window.confirm(t('picker.confirm_close'))) return;
    queryClient.invalidateQueries({ queryKey: ['picker-recommend'] });
    onClose();
  }

  // Keyboard: "/" focuses search, Ctrl/Cmd+Enter adds, Escape closes (the
  // detail drawer handles its own Escape while it's open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && detailId === null) {
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!open) return null;

  const filtersActive = !!(category || regionId || equipment || mediaOnly);

  function clearFilters() {
    setCategory('');
    setRegionId('');
    setEquipment('');
    setMediaOnly(false);
  }

  function onQueryChange(value: string) {
    setQuery(value);
    if (value.trim() && (view === 'recommended' || view === 'recent')) setView('all');
  }

  function renderGrid(cards: PickerCardData[], source: PickSource, showReasons: boolean) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 12 }}>
        {cards.map((card) => (
          <ExercisePickerCard
            key={card.id}
            card={card}
            selected={selectedSet.has(card.id)}
            inPhase={existingSet.has(card.id)}
            favorite={isFavorite(card)}
            showReasons={showReasons}
            onToggle={() => toggleSelect(card, source)}
            onFavorite={() => toggleFavorite(card)}
            onDetails={() => setDetailId(card.id)}
          />
        ))}
      </div>
    );
  }

  function renderLoadingGrid() {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 12 }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: 12 }}>
            <Skeleton height={120} />
            <div style={{ marginBlockStart: 10 }}><Skeleton count={2} height={12} /></div>
          </div>
        ))}
      </div>
    );
  }

  function renderMain(): ReactNode {
    if (view === 'recommended') {
      if (recommend.isLoading) return renderLoadingGrid();
      if (recommend.error) return <QueryError onRetry={() => recommend.refetch()} />;
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>
                {context.phaseN != null
                  ? t('picker.recommended.heading', { phase_n: context.phaseN })
                  : t('picker.recommended.heading_no_phase')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBlockStart: 3 }}>{t('picker.recommended.explainer')}</div>
            </div>
          </div>
          {!resolvedRegion && (
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', background: 'var(--pill-attention-bg)', borderRadius: 'var(--radius-card)', padding: '9px 12px' }}>
              {t('picker.recommended.no_region')}
            </div>
          )}
          {recommendedItems.length === 0 ? (
            <EmptyState
              title={t('picker.empty.recommended.title')}
              body={t('picker.empty.recommended.body')}
              action={<Button size="sm" variant="secondary" onClick={() => setView('all')}>{t('picker.recommended.show_all')}</Button>}
            />
          ) : (
            <>
              {renderGrid(recommendedItems, 'recommended', true)}
              <div style={{ textAlign: 'center' }}>
                <Button size="sm" variant="ghost" onClick={() => setView('all')}>{t('picker.recommended.show_all')} ←</Button>
              </div>
            </>
          )}
        </>
      );
    }

    if (view === 'recent') {
      if (recent.isLoading) return renderLoadingGrid();
      if (recent.error) return <QueryError onRetry={() => recent.refetch()} />;
      const items = recent.data?.items ?? [];
      return items.length === 0
        ? <EmptyState title={t('picker.empty.recent.title')} body={t('picker.empty.recent.body')} />
        : renderGrid(items, 'recent', false);
    }

    if (search.isLoading) return renderLoadingGrid();
    if (search.error) return <QueryError onRetry={() => search.refetch()} />;
    const items = search.data?.pages.flatMap((p) => p.items) ?? [];
    const total = search.data?.pages[0]?.total ?? 0;
    if (items.length === 0) {
      if (view === 'favorites' && !debouncedQuery && !filtersActive) {
        return <EmptyState title={t('picker.empty.favorites.title')} body={t('picker.empty.favorites.body')} />;
      }
      return (
        <EmptyState
          title={debouncedQuery ? t('empty.search', { query: debouncedQuery }) : t('picker.empty.filtered')}
          action={filtersActive ? <Button size="sm" variant="secondary" onClick={clearFilters}>{t('picker.filter.clear')}</Button> : undefined}
        />
      );
    }
    return (
      <>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('picker.results', { shown: items.length, total })}</div>
        {renderGrid(items, view === 'favorites' ? 'favorite' : 'search', false)}
        {search.hasNextPage && (
          <div style={{ textAlign: 'center' }}>
            <Button size="sm" variant="secondary" loading={search.isFetchingNextPage} onClick={() => search.fetchNextPage()}>
              {t('picker.load_more')} ({items.length} / {total})
            </Button>
          </div>
        )}
      </>
    );
  }

  // Category balance of the phase after adding the current selection.
  const anchorCategories = recommend.data?.context.anchor_categories ?? {};
  const balance = new Map<string, number>(EXERCISE_CATEGORIES.map((c) => [c, 0]));
  for (const id of existingIds) {
    const c = anchorCategories[id];
    if (c) balance.set(c, (balance.get(c) ?? 0) + 1);
  }
  for (const s of selected) balance.set(s.card.category, (balance.get(s.card.category) ?? 0) + 1);

  const completeItems = (complete.data?.items ?? [])
    .filter((c) => (c.reasons ?? []).some((r) => r.code === 'co_occurs' || r.code === 'fills_gap'))
    .filter((c) => !selectedSet.has(c.id))
    .slice(0, 4);

  const headerChips = [
    context.label,
    resolvedRegion?.name,
    // phase names are often already "שלב 2 — …"; don't say "שלב 2" twice
    context.phaseName?.trim().startsWith('שלב')
      ? context.phaseName.trim()
      : context.phaseN != null ? `שלב ${context.phaseN}${context.phaseName ? ` · ${context.phaseName}` : ''}` : null,
  ].filter((x): x is string => !!x);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('picker.title')}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', background: 'var(--shell-content-bg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-ui)' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 22px', borderBottom: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)' }}>
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)' }}>
            {t('picker.title')} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted-2)' }}>· Add Exercises</span>
          </div>
          {headerChips.length > 0 && (
            <div style={{ display: 'flex', gap: 5, marginBlockStart: 5, flexWrap: 'wrap' }}>
              {headerChips.map((c) => <span key={c} style={contextChipStyle}>{c}</span>)}
            </div>
          )}
        </div>
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('picker.search.placeholder')}
          aria-label={t('picker.search.placeholder')}
          style={{ flex: 1, minWidth: 0, maxWidth: 560, marginInline: 'auto', padding: '11px 14px', border: 'var(--border-input)', borderRadius: 'var(--radius-pill)', fontFamily: 'inherit', fontSize: 14, background: 'var(--white)', color: 'var(--ink)' }}
        />
        <button onClick={requestClose} aria-label={t('picker.close')} style={closeBtnStyle}>✕</button>
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Views + filters */}
        <nav style={{ width: 216, flex: 'none', padding: '16px 12px', borderInlineEnd: '1px solid var(--shell-border)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {([
            ['recommended', `✦ ${t('picker.view.recommended')}`],
            ['all', t('picker.view.all')],
            ['favorites', `★ ${t('picker.view.favorites')}`],
            ['recent', t('picker.view.recent')],
          ] as [View, string][]).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} aria-current={view === v ? 'page' : undefined} style={viewBtnStyle(view === v)}>
              {label}
            </button>
          ))}

          {searchView && (
            <div style={{ marginBlockStart: 14, paddingBlockStart: 14, borderBlockStart: '1px solid var(--shell-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Select
                label={t('picker.filter.region')}
                value={regionId}
                onChange={(e) => setRegionId(e.target.value)}
                options={[
                  { value: '', label: t('picker.filter.region.any') },
                  ...(filterOptions?.body_regions ?? []).map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
              <div>
                <div style={filterLabelStyle}>{t('picker.filter.category')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  <button onClick={() => setCategory('')} style={filterChipStyle(category === '')}>{t('picker.filter.all')}</button>
                  {EXERCISE_CATEGORIES.map((c) => (
                    <button key={c} onClick={() => setCategory(category === c ? '' : c)} style={filterChipStyle(category === c)}>
                      {exerciseCategoryLabel(c)}
                    </button>
                  ))}
                </div>
              </div>
              <Select
                label={t('picker.filter.equipment')}
                value={equipment}
                onChange={(e) => setEquipment(e.target.value)}
                options={[
                  { value: '', label: t('picker.filter.all') },
                  ...(filterOptions?.equipment ?? []).map((e) => ({ value: e, label: equipmentLabel(e) })),
                ]}
              />
              <Checkbox label={t('picker.filter.media_only')} checked={mediaOnly} onChange={(e) => setMediaOnly(e.target.checked)} style={{ fontSize: 13 }} />
              {filtersActive && (
                <Button size="sm" variant="ghost" onClick={clearFilters}>{t('picker.filter.clear')}</Button>
              )}
            </div>
          )}
        </nav>

        {/* Results */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {renderMain()}
        </main>

        {/* Basket */}
        <aside style={{ width: 340, flex: 'none', borderInlineStart: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 16px 10px', borderBottom: '1px solid var(--shell-border-soft)' }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>{t('picker.basket.title', { n: selected.length })}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBlockStart: 2 }}>{t('picker.basket.in_phase', { n: existingIds.length })}</div>
            <div style={{ ...filterLabelStyle, marginBlockStart: 10 }}>{t('picker.basket.balance')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {EXERCISE_CATEGORIES.map((c) => {
                const n = balance.get(c) ?? 0;
                return (
                  <span key={c} style={balanceChipStyle(n > 0)}>
                    {exerciseCategoryLabel(c)} {n}
                  </span>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selected.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '28px 12px', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)' }}>
                {t('picker.basket.empty')}
              </div>
            ) : selected.map((s) => (
              <div key={s.card.id} style={{ background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: '9px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.card.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted-2)' }}>{exerciseCategoryLabel(s.card.category)}</div>
                  </div>
                  <button onClick={() => toggleSelect(s.card, s.source)} aria-label={t('picker.basket.remove')} title={t('picker.basket.remove')} style={smallIconBtnStyle}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBlockStart: 7 }}>
                  {doseFields.map((f) => (
                    <label key={f} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'var(--muted)' }}>
                      {t(DOSE_LABEL_KEY[f])}
                      <input
                        type="number"
                        min={0}
                        value={s[f] ?? ''}
                        onChange={(e) => updateDose(s.card.id, f, e.target.value)}
                        style={{ width: '100%', padding: '5px 6px', border: 'var(--border-input)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {completeItems.length > 0 && (
              <div style={{ marginBlockStart: 6 }}>
                <div style={filterLabelStyle}>✦ {t('picker.complete.heading')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {completeItems.map((c) => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--white)', border: '1px dashed var(--shell-border)', borderRadius: 'var(--radius-card)', padding: '7px 9px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--gold-deep)' }}>{c.reasons?.[0] ? formatRecommendReason(c.reasons[0]) : ''}</div>
                        {formatPrescription(c.prescription, c.frequency) && (
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{formatPrescription(c.prescription, c.frequency)}</div>
                        )}
                      </div>
                      <button onClick={() => toggleSelect(c, 'recommended')} aria-label={`${t('picker.card.selected')}: ${c.name}`} style={{ ...smallIconBtnStyle, color: 'var(--gold-deep)', borderColor: 'var(--gold-deep)', fontSize: 15 }}>+</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ padding: 14, borderBlockStart: '1px solid var(--shell-border)' }}>
            <Button onClick={commit} disabled={selected.length === 0} style={{ width: '100%', justifyContent: 'center' }}>
              {t('picker.add', { n: selected.length })}
            </Button>
            <div style={{ fontSize: 10, color: 'var(--muted-2)', textAlign: 'center', marginBlockStart: 6 }}>{t('picker.add.hint')}</div>
          </div>
        </aside>
      </div>

      <ExerciseDetailDrawer
        exerciseId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        onDuplicated={(newId) => setDetailId(newId)}
      />
    </div>
  );
}

const contextChipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 9px',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--nav-active-bg)',
  color: 'var(--gold-deep)',
  whiteSpace: 'nowrap',
};

const closeBtnStyle: CSSProperties = {
  flexShrink: 0,
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: '1px solid var(--shell-border)',
  background: 'var(--white)',
  color: 'var(--ink-soft)',
  fontSize: 15,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const smallIconBtnStyle: CSSProperties = {
  flexShrink: 0,
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--ink-soft)',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const filterLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.03em',
  color: 'var(--muted)',
  marginBlockEnd: 6,
};

function viewBtnStyle(active: boolean): CSSProperties {
  return {
    textAlign: 'start',
    padding: '9px 12px',
    borderRadius: 'var(--radius-button)',
    border: 'none',
    background: active ? 'var(--nav-active-bg)' : 'transparent',
    color: active ? 'var(--gold-deep)' : 'var(--ink-soft)',
    fontWeight: active ? 700 : 500,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function filterChipStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 'var(--radius-pill)',
    border: active ? '1px solid var(--gold-deep)' : '1px solid var(--line)',
    background: active ? 'var(--gold-deep)' : 'var(--white)',
    color: active ? 'var(--cream)' : 'var(--ink-soft)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function balanceChipStyle(filled: boolean): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 'var(--radius-pill)',
    background: filled ? 'var(--pill-good-bg)' : 'transparent',
    color: filled ? 'var(--flag-green)' : 'var(--muted-2)',
    border: filled ? '1px solid transparent' : '1px dashed var(--placeholder)',
  };
}
