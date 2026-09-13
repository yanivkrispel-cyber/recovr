// T-31 media verification queue: every media item the caller manages, filtered
// by review state and source, with bulk verify. Verification needs known
// rights — pick them per item, or once for the whole selection.
import { useContext, useMemo, useState, type CSSProperties } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { mediaKindLabel, mediaRightsLabel, t, type MediaRights } from 'shared';
import { Button, EmptyState, Skeleton, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import { mediaQueue, updateMedia, verifyMedia, type MediaQueueItem } from './catalogApi';
import { RightsSelect, MediaThumb } from './MediaManager';
import { StatusBadge, linkButtonStyle, smallButtonStyle } from './catalogUi';

const PAGE = 48;
const STATUSES = ['pending', 'rights_unknown', 'verified', 'all'] as const;

const chip = (active: boolean): CSSProperties => ({
  padding: '6px 13px', borderRadius: 'var(--radius-pill)', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer',
  background: active ? 'var(--gold-deep)' : 'var(--white)', color: active ? 'var(--cream)' : 'var(--ink-soft)',
  border: active ? '1px solid var(--gold-deep)' : '1px solid var(--shell-border)', fontWeight: active ? 700 : 500,
});

export default function MediaQueue({ readOnly, onOpenExercise }: { readOnly: boolean; onOpenExercise: (id: string) => void }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const [source, setSource] = useState('');
  const [onlyApproved, setOnlyApproved] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRights, setBulkRights] = useState<MediaRights | ''>('');
  const [working, setWorking] = useState(false);

  const filters = { status, source, exercise_status: onlyApproved ? 'approved' : '' };
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['media-queue', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => mediaQueue(supabase, filters, PAGE, pageParam),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: (prev) => prev,
  });
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const counts = data?.pages[0]?.counts;
  const total = data?.pages[0]?.total ?? 0;
  const selectedIds = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['media-queue'] });
    queryClient.invalidateQueries({ queryKey: ['catalog-search'] });
    queryClient.invalidateQueries({ queryKey: ['catalog-exercise'] });
  }

  async function verify(ids: string[], verified: boolean, rights?: MediaRights | null) {
    setWorking(true);
    try {
      const res = await verifyMedia(supabase, ids, verified, rights);
      if (res.updated) toast.show(t('catalog.bulk.done', { updated: res.updated }), { tone: 'success' });
      if (res.skipped.length) {
        const unknown = res.skipped.filter((s) => s.reason === 'rights_unknown').length;
        toast.show(t('catalog.bulk.skipped', { n: res.skipped.length, reasons: unknown ? `${mediaRightsLabel('unknown')} (${unknown})` : res.skipped[0].reason }), { tone: 'error', duration: 5000 });
      }
      setSelected(new Set());
      refresh();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      setWorking(false);
    }
  }

  async function setRights(item: MediaQueueItem, rights: MediaRights) {
    try {
      await updateMedia(supabase, item.id, { rights });
      refresh();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '10px 14px', borderBlockEnd: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)' }}>
        {STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={status === s} style={chip(status === s)} onClick={() => { setStatus(s); setSelected(new Set()); }}>
            {t(`media.queue.status.${s}`)}{counts ? ` · ${counts[s]}` : ''}
          </button>
        ))}
        <select
          aria-label={t('media.queue.source')}
          value={source}
          onChange={(e) => { setSource(e.target.value); setSelected(new Set()); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--shell-border)', background: 'var(--white)', fontFamily: 'inherit', fontSize: 12.5 }}
        >
          <option value="">{t('media.queue.source')}: {t('catalog.filter.any')}</option>
          {(['dataset', 'upload', 'youtube'] as const).map((s) => <option key={s} value={s}>{t(`media.queue.source.${s}`)}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-soft)' }}>
          <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
          {t('media.queue.only_approved')}
        </label>
      </div>

      {!readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderBlockEnd: '1px solid var(--shell-border)', background: selectedIds.length ? 'var(--nav-active-bg)' : 'var(--white)' }}>
          <strong style={{ fontSize: 13, minWidth: 70, color: selectedIds.length ? 'var(--gold-deep)' : 'var(--muted)' }}>{t('catalog.bulk.selected', { n: selectedIds.length })}</strong>
          <button type="button" style={smallButtonStyle} disabled={items.length === 0} onClick={() => setSelected(new Set(items.map((i) => i.id)))}>{t('catalog.bulk.select_all')}</button>
          <span style={{ width: 170 }}>
            <RightsSelect value={bulkRights} allowUnknown={false} onChange={setBulkRights} />
          </span>
          <Button size="sm" disabled={working || selectedIds.length === 0} onClick={() => verify(selectedIds, true, bulkRights || null)}>
            ✓ {t('media.queue.verify_selected', { n: selectedIds.length })}
          </Button>
          <Button size="sm" variant="secondary" disabled={working || selectedIds.length === 0} onClick={() => verify(selectedIds, false)}>{t('media.unverify')}</Button>
          <button type="button" style={{ ...smallButtonStyle, marginInlineStart: 'auto' }} disabled={selectedIds.length === 0} onClick={() => setSelected(new Set())}>{t('catalog.bulk.clear')}</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {isLoading ? (
          <Skeleton count={6} height={60} radius={12} />
        ) : error ? (
          <EmptyState title={t('error.generic.title')} body={t('error.generic.body')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('media.queue.empty')} body="" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
            {items.map((m) => {
              const checked = selected.has(m.id);
              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 'var(--radius-card)', background: 'var(--white)', border: checked ? '2px solid var(--gold-deep)' : '1px solid var(--line-soft)', margin: checked ? 0 : 1 }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {!readOnly && (
                      <input
                        type="checkbox"
                        aria-label={m.exercise.name}
                        checked={checked}
                        onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                        style={{ alignSelf: 'flex-start' }}
                      />
                    )}
                    <MediaThumb media={m} size={96} />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button type="button" onClick={() => onOpenExercise(m.exercise.id)} style={{ ...linkButtonStyle, textDecoration: 'none', color: 'var(--ink)', fontSize: 13, textAlign: 'start' }}>
                        <span dir="auto" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'start', lineHeight: 1.35 }}>{m.exercise.name}</span>
                      </button>
                      <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                        <StatusBadge status={m.exercise.status} compact />
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{mediaKindLabel(m.kind)} · {t(`media.queue.source.${m.source}`)} · {t(m.scope === 'master' ? 'media.scope.master' : 'media.scope.clinic')}</span>
                      </span>
                      {m.verified
                        ? <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--flag-green)' }}>✓ {t('media.verified')}</span>
                        : <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--flag-red)' }}>{t('media.pending')}</span>}
                      {m.verified && m.rights === 'unknown' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{t('media.queue.rights_warning')}</span>}
                    </div>
                  </div>
                  {m.attribution && <div dir="auto" style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'start', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.attribution}</div>}
                  {!readOnly && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ flex: 1 }}><RightsSelect value={m.rights} onChange={(r) => setRights(m, r)} /></span>
                      {m.verified
                        ? <button type="button" style={smallButtonStyle} disabled={working} onClick={() => verify([m.id], false)}>{t('media.unverify')}</button>
                        : (
                          <button
                            type="button"
                            style={{ ...smallButtonStyle, borderColor: 'var(--flag-green)', color: 'var(--flag-green)', opacity: m.rights === 'unknown' ? 0.45 : 1 }}
                            disabled={working || m.rights === 'unknown'}
                            title={m.rights === 'unknown' ? t('media.upload.rights_required') : undefined}
                            onClick={() => verify([m.id], true)}
                          >
                            ✓ {t('media.verify')}
                          </button>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {hasNextPage && (
          <div style={{ padding: 14, textAlign: 'center' }}>
            <Button size="sm" variant="secondary" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
              {t('catalog.load_more', { shown: items.length, total })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
