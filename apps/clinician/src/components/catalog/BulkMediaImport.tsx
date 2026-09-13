// T-31 bulk media import: pick many files, match each file name to an exercise
// (server-side similarity over names, English names and aliases), confirm or
// correct the matches, then upload them all with one rights declaration.
import { useContext, useEffect, useMemo, useState } from 'react';
import { checkUpload, formatBytes, normalizeMediaFilename, t, type MediaRights } from 'shared';
import { Button, Modal, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import { catalogSearch, matchMediaNames, type MatchCandidate } from './catalogApi';
import { RightsSelect, uploadErrorText } from './MediaManager';
import { StatusBadge, fieldLabelStyle, textInputStyle } from './catalogUi';
import { uploadMediaFile } from './mediaUpload';

const AUTO_ACCEPT_SCORE = 0.5;
const CONCURRENCY = 3;

interface Row {
  key: string;
  file: File;
  preview: string | null;
  error: string | null; // pre-check failure
  candidates: MatchCandidate[];
  exerciseId: string; // '' = skip
  state: 'idle' | 'uploading' | 'done' | 'failed';
  uploadError?: string;
}

export default function BulkMediaImport({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [matching, setMatching] = useState(false);
  const [rights, setRights] = useState<MediaRights | ''>('');
  const [attribution, setAttribution] = useState('');
  const [verify, setVerify] = useState(true);
  const [primary, setPrimary] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (open) return;
    setRows((rs) => {
      rs.forEach((r) => r.preview && URL.revokeObjectURL(r.preview));
      return [];
    });
    setFinished(false);
    setRunning(false);
  }, [open]);

  async function pick(files: File[]) {
    const fresh: Row[] = files.map((file) => {
      const check = checkUpload(file.type, file.size);
      return {
        key: `${file.name}-${file.size}-${Math.random()}`,
        file,
        preview: check.ok && check.kind !== 'clip' ? URL.createObjectURL(file) : null,
        error: check.ok ? null : uploadErrorText(check.reason, file.name),
        candidates: [],
        exerciseId: '',
        state: 'idle',
      };
    });
    setRows(fresh);
    setFinished(false);
    const valid = fresh.filter((r) => !r.error);
    if (valid.length === 0) return;

    setMatching(true);
    try {
      const matched = new Map<string, MatchCandidate[]>();
      for (let i = 0; i < valid.length; i += 100) {
        const chunk = valid.slice(i, i + 100);
        const res = await matchMediaNames(supabase, chunk.map((r) => normalizeMediaFilename(r.file.name) || r.file.name));
        res.items.forEach((item, k) => matched.set(chunk[k].key, item.candidates));
      }
      setRows((rs) => rs.map((r) => {
        const candidates = matched.get(r.key) ?? [];
        const best = candidates[0];
        return { ...r, candidates, exerciseId: best && best.score >= AUTO_ACCEPT_SCORE ? best.id : '' };
      }));
    } catch {
      toast.show(t('error.generic.body'), { tone: 'error' });
    } finally {
      setMatching(false);
    }
  }

  async function start() {
    if (!rights) {
      toast.show(t('media.upload.rights_required'), { tone: 'error' });
      return;
    }
    setRunning(true);
    const queue = rows.filter((r) => !r.error && r.exerciseId && r.state !== 'done');
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, state: 'uploading' } : r)));
        try {
          await uploadMediaFile(supabase, row.exerciseId, row.file, {
            rights, attribution: attribution.trim() || undefined, verify: verify && rights !== 'unknown', primary,
          });
          setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, state: 'done' } : r)));
        } catch (err) {
          setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, state: 'failed', uploadError: uploadErrorText(String(err), row.file.name) } : r)));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);
    setFinished(true);
    onDone();
  }

  const stats = useMemo(() => ({
    ready: rows.filter((r) => !r.error && r.exerciseId).length,
    done: rows.filter((r) => r.state === 'done').length,
    failed: rows.filter((r) => r.state === 'failed').length,
    skipped: rows.filter((r) => r.error || !r.exerciseId).length,
  }), [rows]);

  return (
    <Modal
      open={open}
      onClose={() => { if (!running) onClose(); }}
      title={t('media.import.title')}
      size="lg"
      footer={
        <>
          {(running || finished) && (
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginInlineEnd: 'auto' }}>
              {finished
                ? t('media.import.summary', { ok: stats.done, failed: stats.failed, skipped: stats.skipped })
                : t('media.import.progress', { done: stats.done + stats.failed, total: stats.ready })}
            </span>
          )}
          <Button variant="ghost" disabled={running} onClick={onClose}>{t('picker.close')}</Button>
          {!finished && (
            <Button disabled={stats.ready === 0 || !rights || matching} loading={running} onClick={start}>
              {t('media.import.start', { n: stats.ready })}
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabelStyle}>{t('media.import.pick')}</span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
            disabled={running}
            onChange={(e) => { void pick(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabelStyle}>{t('media.rights.label')}</span>
            <RightsSelect value={rights} onChange={setRights} disabled={running} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabelStyle}>{t('media.attribution')}</span>
            <input value={attribution} disabled={running} onChange={(e) => setAttribution(e.target.value)} style={{ ...textInputStyle, padding: '6px 9px', fontSize: 13 }} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
          <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <input type="checkbox" checked={verify} disabled={running} onChange={(e) => setVerify(e.target.checked)} /> {t('media.upload.verify')}
          </label>
          <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <input type="checkbox" checked={primary} disabled={running} onChange={(e) => setPrimary(e.target.checked)} /> {t('media.import.primary')}
          </label>
        </div>

        {matching && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('media.import.matching')}</div>}

        {rows.length > 0 && (
          <div style={{ border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-card)', overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '54px minmax(0,1fr) minmax(0,1.3fr) 70px', gap: 10, padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--shell-sidebar-bg)' }}>
              <span /><span>{t('media.import.col.file')}</span><span>{t('media.import.col.exercise')}</span><span />
            </div>
            {rows.map((r) => (
              <ImportRow
                key={r.key}
                row={r}
                disabled={running || r.state === 'done'}
                onPick={(exerciseId, extra) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, exerciseId, candidates: extra ? [extra, ...x.candidates.filter((c) => c.id !== extra.id)] : x.candidates } : x)))}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ImportRow({ row, disabled, onPick }: { row: Row; disabled: boolean; onPick: (id: string, extra?: MatchCandidate) => void }) {
  const supabase = useContext(SupabaseContext);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MatchCandidate[]>([]);

  useEffect(() => {
    if (!searching || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const h = setTimeout(async () => {
      try {
        const page = await catalogSearch(supabase, { q: q.trim() }, 8, 0);
        setResults(page.items.map((i) => ({ id: i.id, name: i.name, name_en: i.name_en, status: i.status, is_clinic_owned: i.is_clinic_owned, score: 0, media_count: 0 })));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [q, searching, supabase]);

  const chosen = row.candidates.find((c) => c.id === row.exerciseId);
  const stateText = row.state === 'uploading' ? '…' : row.state === 'done' ? '✓' : row.state === 'failed' ? '✗' : '';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '54px minmax(0,1fr) minmax(0,1.3fr) 70px', gap: 10, padding: '8px 10px', alignItems: 'center', borderBlockStart: '1px solid var(--line-soft)', background: row.state === 'done' ? 'var(--pill-good-bg)' : 'transparent' }}>
      <span style={{ width: 48, height: 48, borderRadius: 8, overflow: 'hidden', background: 'var(--shell-sidebar-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {row.preview ? <img src={row.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span aria-hidden>▶</span>}
      </span>
      <span style={{ minWidth: 0 }}>
        <span dir="ltr" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'end' }}>{row.file.name}</span>
        <span style={{ fontSize: 11, color: row.error || row.uploadError ? 'var(--danger)' : 'var(--muted)' }}>{row.error ?? row.uploadError ?? formatBytes(row.file.size)}</span>
      </span>
      <span style={{ minWidth: 0 }}>
        {row.error ? null : searching ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input autoFocus value={q} placeholder={t('media.import.search')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearching(false)} style={{ ...textInputStyle, padding: '5px 8px', fontSize: 12.5 }} />
            {results.map((c) => (
              <button key={c.id} type="button" onClick={() => { onPick(c.id, c); setSearching(false); setQ(''); }} style={{ textAlign: 'start', background: 'none', border: 'none', padding: '3px 2px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>
                {c.name} <span dir="ltr" style={{ color: 'var(--muted)' }}>{c.name_en}</span>
              </button>
            ))}
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={row.exerciseId}
              disabled={disabled}
              onChange={(e) => {
                if (e.target.value === '__search') setSearching(true);
                else onPick(e.target.value);
              }}
              style={{ ...textInputStyle, padding: '5px 8px', fontSize: 12.5, color: row.exerciseId ? 'var(--ink)' : 'var(--muted)' }}
            >
              <option value="">{row.candidates.length ? t('media.import.skip') : t('media.import.no_match')}</option>
              {row.candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.name_en && c.name_en !== c.name ? ` · ${c.name_en}` : ''}{c.score ? ` (${Math.round(c.score * 100)}%)` : ''}</option>
              ))}
              <option value="__search">{t('media.import.search')}</option>
            </select>
            {chosen && <StatusBadge status={chosen.status} compact />}
          </span>
        )}
      </span>
      <span style={{ textAlign: 'center', fontSize: 16, color: row.state === 'failed' ? 'var(--danger)' : 'var(--flag-green)' }}>{stateText}</span>
    </div>
  );
}
