// T-30 exercise library workspace: search + faceted filters + saved views on
// top; a two-pane list/editor (or the bulk grid) below.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  COMPLETENESS_KEYS, EXERCISE_STATUSES, completenessKeyLabel, equipmentLabel, exerciseCategoryLabel, exerciseStatusLabel,
  startPositionLabel, t, type BodyRegion,
} from 'shared';
import { Button, EmptyState, Skeleton, useIsTablet } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';
import CatalogBulkGrid from '../components/catalog/CatalogBulkGrid';
import ExerciseEditor from '../components/catalog/ExerciseEditor';
import NewExerciseModal from '../components/catalog/NewExerciseModal';
import {
  FACET_KEYS, catalogSearch, mediaSrc, type CatalogFacets, type CatalogFilters, type CatalogItem, type CatalogPage,
  type FacetKey,
} from '../components/catalog/catalogApi';
import { CompletenessRing, FacetDropdown, StatusBadge, smallButtonStyle } from '../components/catalog/catalogUi';

const PAGE_SIZE = 60;
const VIEW_KEY = 'catalog.view';
const SAVED_VIEWS_KEY = 'catalog.savedViews';

interface FilterOptions {
  body_regions: BodyRegion[];
  protocols: { slug: string; name: string }[];
}

interface SavedView {
  name: string;
  filters: CatalogFilters;
}

const PRESETS: { key: Parameters<typeof t>[0]; filters: CatalogFilters }[] = [
  { key: 'catalog.views.all', filters: {} },
  { key: 'catalog.views.drafts', filters: { status: 'draft' } },
  { key: 'catalog.views.in_review', filters: { status: 'in_review' } },
  { key: 'catalog.views.missing_he', filters: { missing: 'name_he' } },
  { key: 'catalog.views.no_region', filters: { missing: 'body_region' } },
  { key: 'catalog.views.no_media', filters: { media: 'without' } },
  { key: 'catalog.views.override', filters: { source: 'override' } },
  { key: 'catalog.views.clinic', filters: { source: 'clinic' } },
];

function facetPart(f: CatalogFilters): CatalogFilters {
  const out: CatalogFilters = {};
  for (const k of [...FACET_KEYS, 'protocol'] as const) if (f[k]) out[k] = f[k];
  return out;
}

function sameFacets(a: CatalogFilters, b: CatalogFilters) {
  const x = facetPart(a);
  const y = facetPart(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof CatalogFilters>;
  return [...keys].every((k) => x[k] === y[k]);
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function isTypingTarget(el: EventTarget | null) {
  const tag = (el as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement | null)?.isContentEditable;
}

export default function ExerciseLibrary() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: string };
  const isTablet = useIsTablet(); // T-22: tablet is view-only

  const [view, setView] = useState<'workspace' | 'bulk'>(() => readLocal(VIEW_KEY, 'workspace'));
  const [qInput, setQInput] = useState('');
  const [filters, setFilters] = useState<CatalogFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(search.id ?? null);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => readLocal(SAVED_VIEWS_KEY, []));
  const [namingView, setNamingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const effectiveView = isTablet ? 'workspace' : view;

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* storage unavailable */ }
  }, [view]);

  // debounce the search box into the query
  useEffect(() => {
    const h = setTimeout(() => setFilters((f) => (f.q ?? '') === qInput.trim() ? f : { ...f, q: qInput.trim() || undefined }), 250);
    return () => clearTimeout(h);
  }, [qInput]);

  // keep ?id= in the URL so a selection can be linked / survives reload
  useEffect(() => {
    if ((search.id ?? null) === selectedId) return;
    navigate({ to: '/exercises', search: selectedId ? { id: selectedId } : {}, replace: true });
  }, [selectedId, search.id, navigate]);

  const { data: options } = useQuery({
    queryKey: ['exercise-filter-options'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('exercises/filter-options', { method: 'GET' });
      if (error) throw error;
      return data as FilterOptions;
    },
  });
  const regions = options?.body_regions ?? [];

  const searchKey = ['catalog-search', filters] as const;
  const { data, isLoading, isFetching, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: searchKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => catalogSearch(supabase, filters, PAGE_SIZE, pageParam),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: (prev) => prev,
  });

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;
  const facets: CatalogFacets | undefined = data?.pages[0]?.facets;
  const isCurator = data?.pages[0]?.viewer.is_curator ?? false;

  // first load: select the first result
  useEffect(() => {
    if (effectiveView === 'workspace' && !selectedId && items.length > 0) setSelectedId(items[0].id);
  }, [effectiveView, selectedId, items]);

  // infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { root: effectiveView === 'workspace' ? listRef.current : null, rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, effectiveView, items.length]);

  const moveSelection = useCallback((delta: number) => {
    if (items.length === 0) return;
    const idx = items.findIndex((i) => i.id === selectedId);
    const next = items[Math.min(items.length - 1, Math.max(0, idx + delta))];
    if (next && next.id !== selectedId) {
      setSelectedId(next.id);
      document.getElementById(`row-${next.id}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [items, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' && !isTypingTarget(e.target)) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (effectiveView !== 'workspace' || isTypingTarget(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveView, moveSelection]);

  const onItemChanged = useCallback((id: string, patch: Partial<CatalogItem>) => {
    queryClient.setQueriesData<InfiniteData<CatalogPage>>({ queryKey: ['catalog-search'] }, (old) => old && {
      ...old,
      pages: old.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    });
  }, [queryClient]);

  const invalidateList = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['catalog-search'] });
  }, [queryClient]);

  function setFacet(key: FacetKey | 'protocol', value: string | null) {
    setFilters((f) => ({ ...f, [key]: value ?? undefined }));
  }

  function applyView(viewFilters: CatalogFilters) {
    setFilters((f) => ({ q: f.q, sort: f.sort, ...viewFilters }));
  }

  function persistViews(next: SavedView[]) {
    setSavedViews(next);
    try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }

  if (!user) return null;

  const facetCount = (name: keyof CatalogFacets, value: string) => facets?.[name]?.find((v) => v.value === value)?.count ?? 0;
  const regionName = (id: string) => regions.find((r) => r.id === id)?.name ?? id;
  const hasFacetFilters = Object.keys(facetPart(filters)).length > 0;

  const facetDefs: { key: FacetKey | 'protocol'; label: string; options: { value: string; label: string; count?: number }[] }[] = [
    {
      key: 'body_region_id', label: t('catalog.filter.region'),
      options: regions.map((r) => ({ value: r.id, label: r.name, count: facetCount('body_region', r.id) })),
    },
    {
      key: 'category', label: t('catalog.filter.category'),
      options: ['Strength', 'Mobility', 'Balance', 'Control', 'Cardio'].map((c) => ({ value: c, label: exerciseCategoryLabel(c), count: facetCount('category', c) })),
    },
    {
      key: 'status', label: t('catalog.filter.status'),
      options: EXERCISE_STATUSES.map((s) => ({ value: s as string, label: exerciseStatusLabel(s), count: facetCount('status', s) })),
    },
    {
      key: 'missing', label: t('catalog.filter.missing'),
      options: COMPLETENESS_KEYS.map((k) => ({ value: k as string, label: completenessKeyLabel(k), count: facetCount('missing', k) })),
    },
    {
      key: 'start_position', label: t('catalog.filter.position'),
      options: (facets?.start_position ?? []).map((v) => ({ value: v.value, label: startPositionLabel(v.value), count: v.count })),
    },
    {
      key: 'equipment', label: t('catalog.filter.equipment'),
      options: (facets?.equipment ?? []).map((v) => ({ value: v.value, label: equipmentLabel(v.value), count: v.count })),
    },
    {
      key: 'media', label: t('catalog.filter.media'),
      options: [
        { value: 'with', label: t('catalog.media.with'), count: facetCount('media', 'with') },
        { value: 'without', label: t('catalog.media.without'), count: facetCount('media', 'without') },
      ],
    },
    {
      key: 'source', label: t('catalog.filter.source'),
      options: (['system', 'clinic', 'override'] as const).map((s) => ({ value: s as string, label: t(`catalog.source.${s}`), count: facetCount('source', s) })),
    },
    {
      key: 'protocol', label: t('catalog.filter.protocol'),
      options: (options?.protocols ?? []).map((p) => ({ value: p.slug, label: p.name })),
    },
  ];

  const listFooter = hasNextPage ? (
    <div ref={sentinelRef} style={{ padding: 14, textAlign: 'center' }}>
      <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
        {t('catalog.load_more', { shown: items.length, total })}
      </Button>
    </div>
  ) : null;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 52px)', minHeight: 560 }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 auto' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>{t('catalog.title')}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBlockStart: 2 }}>
              {t('catalog.subtitle', { total })}{isFetching && !isFetchingNextPage ? ' · …' : ''}
            </div>
          </div>
          <div style={{ flex: '1 1 320px', position: 'relative' }}>
            <input
              ref={searchRef}
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQInput('');
                if (e.key === 'ArrowDown' && effectiveView === 'workspace') {
                  e.preventDefault();
                  listRef.current?.focus();
                  moveSelection(selectedId ? 1 : 0);
                }
              }}
              placeholder={t('catalog.search.placeholder')}
              aria-label={t('catalog.search.placeholder')}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 14px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--shell-border)', background: 'var(--white)', fontFamily: 'inherit', fontSize: 14 }}
            />
          </div>
          <select
            aria-label={t('catalog.sort.label')}
            value={filters.sort ?? (filters.q ? 'relevance' : 'name')}
            onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}
            style={{ padding: '9px 10px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--shell-border)', background: 'var(--white)', fontFamily: 'inherit', fontSize: 13, color: 'var(--ink-soft)' }}
          >
            {(['relevance', 'name', 'updated', 'completeness'] as const).map((s) => (
              <option key={s} value={s}>{t('catalog.sort.label')}: {t(`catalog.sort.${s}`)}</option>
            ))}
          </select>
          {!isTablet && (
            <div role="tablist" style={{ display: 'inline-flex', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)', padding: 3, background: 'var(--white)' }}>
              {(['workspace', 'bulk'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  style={{ border: 'none', borderRadius: 'var(--radius-pill)', padding: '6px 13px', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: view === v ? 'var(--navy)' : 'transparent', color: view === v ? 'var(--cream)' : 'var(--ink-soft)' }}
                >
                  {t(v === 'workspace' ? 'catalog.view.workspace' : 'catalog.view.bulk')}
                </button>
              ))}
            </div>
          )}
          {!isTablet && <Button onClick={() => setCreateOpen(true)}>+ {t('catalog.new')}</Button>}
        </div>

        {/* Views + facets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginInlineEnd: 2 }}>{t('catalog.views.title')}</span>
            {PRESETS.map((p) => (
              <ViewChip key={p.key} label={t(p.key)} active={sameFacets(filters, p.filters)} onClick={() => applyView(p.filters)} />
            ))}
            {savedViews.map((v) => (
              <ViewChip
                key={v.name}
                label={v.name}
                active={sameFacets(filters, v.filters)}
                onClick={() => applyView(v.filters)}
                onRemove={() => persistViews(savedViews.filter((x) => x.name !== v.name))}
              />
            ))}
            {hasFacetFilters && !namingView && !PRESETS.some((p) => sameFacets(filters, p.filters)) && !savedViews.some((v) => sameFacets(filters, v.filters)) && (
              <button type="button" style={{ ...smallButtonStyle, borderStyle: 'dashed' }} onClick={() => setNamingView(true)}>{t('catalog.views.save')}</button>
            )}
            {namingView && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = viewName.trim();
                  if (name) persistViews([...savedViews.filter((v) => v.name !== name), { name, filters: facetPart(filters) }]);
                  setNamingView(false);
                  setViewName('');
                }}
              >
                <input
                  autoFocus
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  onBlur={() => setNamingView(false)}
                  onKeyDown={(e) => e.key === 'Escape' && setNamingView(false)}
                  placeholder={t('catalog.views.save.placeholder')}
                  style={{ padding: '5px 10px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--gold-deep)', fontFamily: 'inherit', fontSize: 12.5, width: 140 }}
                />
              </form>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {facetDefs.map((f) => {
              const value = filters[f.key];
              const valueLabel = value
                ? (f.options.find((o) => o.value === value)?.label ?? (f.key === 'body_region_id' ? regionName(value) : value))
                : null;
              return (
                <FacetDropdown key={f.key} label={f.label} valueLabel={valueLabel} options={f.options} active={!!value} onSelect={(v) => setFacet(f.key, v)} />
              );
            })}
            {hasFacetFilters && (
              <button type="button" style={{ ...smallButtonStyle, border: 'none', textDecoration: 'underline' }} onClick={() => applyView({})}>
                {t('catalog.filter.clear')}
              </button>
            )}
            <span style={{ marginInlineStart: 'auto', fontSize: 11, color: 'var(--muted)' }}>{effectiveView === 'workspace' && t('catalog.keys.hint')}</span>
          </div>
        </div>

        {isTablet && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.tablet.readonly')}</div>}

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
          {error ? (
            <div style={{ padding: 24, flex: 1 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>
          ) : effectiveView === 'bulk' ? (
            isLoading ? <div style={{ padding: 20, flex: 1 }}><Skeleton count={10} height={30} /></div> : (
              <CatalogBulkGrid
                items={items}
                regions={regions}
                isCurator={isCurator}
                readOnly={isTablet}
                onApplied={invalidateList}
                onOpen={(id) => { setSelectedId(id); setView('workspace'); }}
                footer={listFooter}
              />
            )
          ) : (
            <>
              <div
                ref={listRef}
                tabIndex={0}
                role="listbox"
                aria-label={t('catalog.title')}
                aria-activedescendant={selectedId ? `row-${selectedId}` : undefined}
                style={{ width: 'clamp(300px, 34%, 420px)', flex: 'none', overflowY: 'auto', borderInlineEnd: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)', outline: 'none' }}
              >
                {isLoading ? (
                  <div style={{ padding: 16 }}><Skeleton count={10} height={44} radius={10} /></div>
                ) : items.length === 0 ? (
                  <div style={{ padding: 20 }}><EmptyState title={t('catalog.empty.title')} body={t('catalog.empty.body')} /></div>
                ) : (
                  items.map((i) => (
                    <ListRow key={i.id} item={i} selected={i.id === selectedId} onClick={() => setSelectedId(i.id)} />
                  ))
                )}
                {listFooter}
              </div>
              <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
                {selectedId ? (
                  <ExerciseEditor
                    key={selectedId}
                    exerciseId={selectedId}
                    regions={regions}
                    equipmentSuggestions={(facets?.equipment ?? []).map((e) => e.value)}
                    readOnly={isTablet}
                    onItemChanged={onItemChanged}
                    onSelect={(id) => setSelectedId(id)}
                    onListInvalidate={invalidateList}
                    onDeleted={() => {
                      setSelectedId(null);
                      invalidateList();
                    }}
                  />
                ) : (
                  <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{t('catalog.empty.select')}</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <NewExerciseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        regions={regions}
        isCurator={isCurator}
        onCreated={(id) => {
          setQInput('');
          applyView({});
          setView('workspace');
          setSelectedId(id);
          invalidateList();
        }}
        onOpenExisting={(id) => {
          setView('workspace');
          setSelectedId(id);
        }}
      />
    </AppShell>
  );
}

function ViewChip({ label, active, onClick, onRemove }: { label: string; active: boolean; onClick: () => void; onRemove?: () => void }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', borderRadius: 'var(--radius-pill)',
        background: active ? 'var(--gold-deep)' : 'transparent', border: active ? '1px solid var(--gold-deep)' : '1px solid var(--shell-border)',
      }}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        style={{ background: 'none', border: 'none', padding: '5px 12px', fontFamily: 'inherit', fontSize: 12, fontWeight: active ? 700 : 500, color: active ? 'var(--cream)' : 'var(--ink-soft)', cursor: 'pointer' }}
      >
        {label}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`${t('catalog.views.remove')} ${label}`}
          onClick={onRemove}
          style={{ background: 'none', border: 'none', paddingInline: '0 9px', fontSize: 13, color: active ? 'var(--cream)' : 'var(--muted)', cursor: 'pointer' }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function ListRow({ item, selected, onClick }: { item: CatalogItem; selected: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const img = hover && item.gif_url ? item.gif_url : item.thumb_url;
  return (
    <div
      id={`row-${item.id}`}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer',
        borderBlockEnd: '1px solid var(--shell-border-soft)',
        background: selected ? 'var(--white)' : hover ? 'var(--nav-active-bg)' : 'transparent',
        boxShadow: selected ? 'inset -3px 0 0 var(--gold-deep)' : undefined,
      }}
    >
      <span style={{ width: 42, height: 42, flex: 'none', borderRadius: 9, overflow: 'hidden', background: 'var(--white)', border: '1px solid var(--line-soft)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {img ? <img src={mediaSrc(img)} alt="" width={42} height={42} loading="lazy" style={{ objectFit: 'cover' }} /> : <span aria-hidden style={{ color: 'var(--muted-2)' }}>◌</span>}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span dir="auto" style={{ display: 'block', textAlign: 'start', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginBlockStart: 2, fontSize: 11.5, color: 'var(--muted)', minWidth: 0 }}>
          <StatusBadge status={item.status} compact />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.body_region?.name ?? '—'} · {exerciseCategoryLabel(item.category)}
            {item.has_override && ` · ${t('catalog.override.badge')}`}
          </span>
        </span>
      </span>
      <CompletenessRing score={item.completeness} size={32} />
    </div>
  );
}
