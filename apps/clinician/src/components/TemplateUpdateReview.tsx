import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Badge, Button, Checkbox, Modal, Skeleton, useToast } from 'ui';
import { SupabaseContext } from '../App';

// Per-patient review of protocol template changes (RULES §3). The server
// computes a 3-way diff (base version / current template / this plan); the
// clinician picks which changes to take. Conflicts (the plan was changed for
// this patient) start unchecked, so personal edits win unless chosen.

type Rx = {
  sets: number | null; reps: number | null; load: number | null; load_unit: string | null;
  tempo: string | null; hold_sec: number | null; rest_sec: number | null; side: string | null;
};
type CriterionRow = { type: string; label: string; operator: string; value: number; unit: string | null };

interface Change {
  key: string;
  phase_n: number;
  phase_name: string;
  is_current: boolean;
  type: 'exercise' | 'criteria' | 'phase';
  kind: 'add' | 'remove' | 'update' | 'replace';
  name?: string;
  name_en?: string | null;
  template_before?: Rx | CriterionRow[] | null;
  template_after?: Rx | CriterionRow[] | { exercises: { name: string; rx: Rx }[]; criteria: CriterionRow[] } | null;
  plan?: Rx | CriterionRow[] | null;
  conflict: boolean;
  default_accept: boolean;
}

interface Diff {
  plan_version: number;
  current_phase_n: number;
  base: { id: string; version: string } | null;
  latest: { id: string; version: string };
  up_to_date: boolean;
  changes: Change[];
}

interface Props {
  patientId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function formatRx(rx: Rx | null | undefined): string {
  if (!rx) return '—';
  const parts: string[] = [];
  if (rx.sets != null || rx.reps != null) parts.push(`${rx.sets ?? '—'}×${rx.reps ?? '—'}`);
  if (rx.hold_sec != null) parts.push(`החזקה ${rx.hold_sec}ש׳`);
  if (rx.load != null) parts.push(`${rx.load}${rx.load_unit ?? ''}`);
  if (rx.rest_sec != null) parts.push(`מנוחה ${rx.rest_sec}ש׳`);
  if (rx.tempo) parts.push(rx.tempo);
  if (rx.side) parts.push(rx.side);
  return parts.length ? parts.join(' · ') : '—';
}

function formatCriteria(list: CriterionRow[] | null | undefined): string {
  if (!list || list.length === 0) return '—';
  const op: Record<string, string> = { gte: '≥', lte: '≤', eq: '=' };
  return list.map((c) => `${c.label} ${op[c.operator] ?? c.operator} ${c.value}${c.unit ? ` ${c.unit}` : ''}`).join(' | ');
}

const kindLabel: Record<string, string> = {
  add: 'נוסף · Added',
  remove: 'הוסר · Removed',
  update: 'שונה · Changed',
  replace: 'קריטריונים · Criteria',
};

async function readErrorBody(error: unknown): Promise<{ error?: string } | null> {
  if (!(error instanceof FunctionsHttpError)) return null;
  return (error.context as Response).json().catch(() => null);
}

export default function TemplateUpdateReview({ patientId, open, onClose, onDone }: Props) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: diff, isLoading, refetch } = useQuery({
    queryKey: ['plan-template-diff', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`plan/patients/${patientId}/plan/template-diff`, { method: 'GET' });
      if (error) throw error;
      return data as Diff;
    },
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (!diff) return;
    setAccepted(new Set(diff.changes.filter((c) => c.default_accept).map((c) => c.key)));
    setSaveError(null);
  }, [diff]);

  function toggle(key: string) {
    setAccepted((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit(keys: string[]) {
    if (!diff) return;
    setSaving(true);
    setSaveError(null);
    const { data, error } = await supabase.functions.invoke(`plan/patients/${patientId}/plan/template-update`, {
      method: 'POST',
      body: { base_version: diff.plan_version, protocol_version_id: diff.latest.id, accept: keys },
    });
    setSaving(false);
    if (error || data?.error) {
      const body = data ?? (await readErrorBody(error));
      if (body?.error === 'plan_version_conflict' || body?.error === 'template_changed') {
        setSaveError('התכנית או הפרוטוקול השתנו בינתיים — טוען מחדש. · The plan or protocol changed meanwhile — reloaded.');
        void refetch();
      } else {
        setSaveError('השמירה נכשלה · Save failed');
      }
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['plan', patientId] });
    queryClient.invalidateQueries({ queryKey: ['patient-overview', patientId] });
    queryClient.invalidateQueries({ queryKey: ['plan-template-diff', patientId] });
    toast.show(keys.length ? `${keys.length} שינויים עודכנו בתכנית` : 'סומן כנבדק — התכנית לא שונתה', { tone: 'success' });
    onDone();
  }

  const phases = diff ? [...new Set(diff.changes.map((c) => c.phase_n))].sort((a, b) => a - b) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={diff?.base ? `עדכון פרוטוקול · v${diff.base.version} → v${diff.latest.version}` : 'עדכון פרוטוקול · Protocol update'}
      footer={diff && !diff.up_to_date ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%', flexWrap: 'wrap' }}>
          <Button variant="ghost" disabled={saving} onClick={() => submit([])}>דלג על הכל · Skip all</Button>
          <Button loading={saving} onClick={() => submit([...accepted])}>
            עדכן {accepted.size} שינויים · Apply {accepted.size}
          </Button>
        </div>
      ) : undefined}
    >
      {isLoading || !diff ? (
        <Skeleton count={5} height={18} />
      ) : diff.up_to_date || diff.changes.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          {diff.up_to_date ? 'התכנית מעודכנת לגרסת הפרוטוקול הנוכחית.' : 'השינויים בפרוטוקול אינם נוגעים לשלבים הנוכחיים והעתידיים של המטופל.'}
          {!diff.up_to_date && (
            <div style={{ marginTop: 12 }}>
              <Button size="sm" loading={saving} onClick={() => submit([])}>סמן כנבדק · Mark reviewed</Button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
            רק השלב הנוכחי והשלבים הבאים. שינויים שסומנו ייכנסו כגרסת תכנית חדשה; שינויים בשלב הנוכחי יחולו מהאימון הבא. התנגשות = התכנית שונתה אישית למטופל, והשינוי האישי נשמר אלא אם תבחר אחרת.
            <br />Only the current and future phases. Conflicts keep the patient's personal edit unless you tick them.
          </div>
          {phases.map((n) => {
            const rows = diff.changes.filter((c) => c.phase_n === n);
            return (
              <div key={n} style={sectionStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>
                  שלב {n} · {rows[0].phase_name}
                  {rows[0].is_current && <Badge tone="gold">שלב נוכחי · Current</Badge>}
                </div>
                {rows.map((c) => (
                  <div key={c.key} style={rowStyle}>
                    <Checkbox checked={accepted.has(c.key)} onChange={() => toggle(c.key)} aria-label={c.name ?? kindLabel[c.kind]} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: 'var(--gold-deep)' }}>
                          {c.type === 'phase' ? 'שלב חדש בפרוטוקול · New phase' : c.type === 'criteria' ? 'קריטריונים להתקדמות' : c.name}
                        </span>
                        {c.type === 'exercise' && <Badge tone="neutral">{kindLabel[c.kind]}</Badge>}
                        {c.conflict && <Badge tone="attention">התנגשות · Conflict</Badge>}
                      </div>
                      <ChangeDetail change={c} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {saveError && <p style={{ color: 'var(--flag-red)', fontSize: 13, margin: 0 }}>{saveError}</p>}
        </div>
      )}
    </Modal>
  );
}

function ChangeDetail({ change: c }: { change: Change }) {
  const line = (label: string, value: string, strong = false) => (
    <div style={{ fontSize: 12, color: strong ? 'var(--ink)' : 'var(--nav-inactive-text)' }}>
      <span style={{ display: 'inline-block', minWidth: 110 }}>{label}</span>{value}
    </div>
  );

  if (c.type === 'phase') {
    const after = c.template_after as { exercises: { name: string; rx: Rx }[]; criteria: CriterionRow[] };
    return (
      <div style={{ marginTop: 4 }}>
        {line('תרגילים', after.exercises.map((e) => `${e.name} (${formatRx(e.rx)})`).join(' | ') || '—', true)}
        {line('קריטריונים', formatCriteria(after.criteria))}
      </div>
    );
  }
  if (c.type === 'criteria') {
    return (
      <div style={{ marginTop: 4 }}>
        {line('פרוטוקול קודם', formatCriteria(c.template_before as CriterionRow[]))}
        {line('פרוטוקול חדש', formatCriteria(c.template_after as CriterionRow[]), true)}
        {c.conflict && line('אצל המטופל', formatCriteria(c.plan as CriterionRow[]))}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4 }}>
      {c.kind !== 'add' && line('אצל המטופל', formatRx(c.plan as Rx))}
      {c.template_before && line('פרוטוקול קודם', formatRx(c.template_before as Rx))}
      {c.template_after && line('פרוטוקול חדש', formatRx(c.template_after as Rx), true)}
      {c.kind === 'add' && c.conflict && line('', 'התרגיל הוסר בעבר מהתכנית של המטופל · Removed for this patient before')}
    </div>
  );
}

const sectionStyle: CSSProperties = {
  background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)',
  borderRadius: 'var(--radius-card)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
};

const rowStyle: CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start',
  borderTop: '1px solid var(--shell-border-soft)', paddingTop: 10,
};
