import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { t } from 'shared';
import { Badge, Button, EmptyState, Input, Modal, Select, Skeleton, clickableDivProps, useToast } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Israeli local (05X-XXXXXXX) -> E.164-ish digits wa.me expects (no leading 0).
function toWhatsAppDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}
// Sentinel injury option: no protocol — clinician types a free-text condition
// and hand-picks exercises (the backend builds a hidden ad-hoc protocol).
const OTHER = '__other__';

type PatientRow = {
  id: string;
  name: string;
  nameEn: string | null;
  status: 'ontrack' | 'attention' | 'ready' | 'inactive' | 'pending' | 'discharged';
  injury: string;
  phase: number | null;
  day: number | null;
  adherence: number | null;
  dischargedAt?: string | null;
};

const statusLabel: Record<PatientRow['status'], string> = {
  ontrack: 'במסלול · On track',
  attention: 'תשומת לב · Attention',
  ready: 'מוכן לקידום · Ready',
  inactive: 'לא פעיל · Inactive',
  pending: 'ממתין/ת להפעלה · Pending activation',
  discharged: 'משוחרר · Discharged',
};

export default function PatientList() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { invite?: boolean };
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const toast = useToast();

  // Dashboard's "+ Add patient" links here with ?invite=1 to open the modal
  // in one click instead of landing on the list first.
  useEffect(() => {
    if (!search.invite) return;
    setInviteOpen(true);
    navigate({ to: '/patients', search: {}, replace: true });
  }, [search.invite, navigate]);

  const { data: patients, isLoading, error } = useQuery({
    queryKey: ['patients', tab],
    queryFn: async () => {
      const filterParam = tab === 'archived' ? 'discharged' : 'all';
      const { data, error } = await supabase.functions.invoke(`patients?filter=${filterParam}`, { method: 'GET' });
      if (error) throw error;
      return data as PatientRow[];
    },
  });

  const reactivate = useMutation({
    mutationFn: async (patientId: string) => {
      const { data, error } = await supabase.functions.invoke(`patient-overview/patients/${patientId}/reactivate`, { method: 'POST' });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data;
    },
    onSuccess: () => {
      toast.show(t('toast.patient_reactivated'), { tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });

  const filtered = useMemo(() => {
    if (!patients) return patients;
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) => p.name.includes(query.trim()) || (p.nameEn ?? '').toLowerCase().includes(q));
  }, [patients, query]);

  if (!user) return null;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
              {t('clinician.patients.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Patients</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
              {tab === 'archived'
                ? `${patients?.length ?? 0} מטופלים בארכיון · archived patients`
                : `${patients?.length ?? 0} מטופלים פעילים · active patients`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חפש מטופל... · Search patients..."
              style={{ width: 230, padding: '9px 12px', border: '1px solid var(--shell-border)', borderRadius: 9, fontFamily: 'inherit', fontSize: 13, background: 'var(--shell-sidebar-bg)' }}
            />
            {tab === 'active' && (
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                + {t('clinician.patient.add')}
              </Button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setTab('active')}
            style={{
              padding: '6px 15px', borderRadius: 'var(--radius-pill)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              background: tab === 'active' ? 'var(--gold-deep)' : 'transparent',
              color: tab === 'active' ? 'var(--cream)' : 'var(--nav-inactive-text)',
              border: tab === 'active' ? 'none' : '1px solid rgba(34,28,20,0.2)',
            }}
          >
            {t('clinician.patients.tab_active')}
          </button>
          <button
            onClick={() => setTab('archived')}
            style={{
              padding: '6px 15px', borderRadius: 'var(--radius-pill)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              background: tab === 'archived' ? 'var(--gold-deep)' : 'transparent',
              color: tab === 'archived' ? 'var(--cream)' : 'var(--nav-inactive-text)',
              border: tab === 'archived' ? 'none' : '1px solid rgba(34,28,20,0.2)',
            }}
          >
            {t('clinician.patients.tab_archived')}
          </button>
        </div>

        {isLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', padding: 18 }}>
                <Skeleton count={3} height={16} />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title={t('error.generic.title')}
            body={t('error.generic.body')}
            action={<Button size="sm" onClick={() => window.location.reload()}>{t('error.generic.action')}</Button>}
          />
        ) : (filtered?.length ?? 0) === 0 ? (
          query ? (
            <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)', padding: 36, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13 }}>
              לא נמצאו מטופלים · No patients found
            </div>
          ) : tab === 'archived' ? (
            <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)', padding: 36, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13 }}>
              אין מטופלים בארכיון · No archived patients
            </div>
          ) : (
            <EmptyState title={t('empty.patients.title')} body={t('empty.patients.body')} action={<Button size="sm">{t('empty.patients.action')}</Button>} />
          )
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {filtered!.map((p) => (
              <div
                key={p.id}
                {...clickableDivProps(() => navigate({ to: '/patients/$patientId', params: { patientId: p.id } }))}
                style={{
                  background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)',
                  padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>{p.nameEn}</div>
                  </div>
                  <Badge tone={p.status === 'pending' || p.status === 'discharged' ? 'neutral' : p.status === 'attention' || p.status === 'inactive' ? 'attention' : 'success'}>
                    {statusLabel[p.status]}
                  </Badge>
                </div>

                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{p.injury}</div>

                {p.status === 'discharged' ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
                      {p.dischargedAt ? `שוחרר ב-${new Date(p.dischargedAt).toLocaleDateString('he-IL')}` : 'שוחרר'}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        reactivate.mutate(p.id);
                      }}
                      disabled={reactivate.isPending}
                      style={{ background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.5)', borderRadius: 'var(--radius-pill)', padding: '5px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: reactivate.isPending ? 0.5 : 1 }}
                    >
                      {t('clinician.patient.reactivate')}
                    </button>
                  </div>
                ) : p.status === 'pending' ? (
                  <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
                    ההזמנה נשלחה · טרם הפעיל/ה את החשבון
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', border: '1px solid rgba(140,100,35,0.5)', color: 'var(--gold-deep)', padding: '3px 9px', borderRadius: 'var(--radius-pill)' }}>
                        שלב {p.phase}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', border: '1px solid rgba(34,28,20,0.22)', color: 'var(--nav-inactive-text)', padding: '3px 9px', borderRadius: 6 }}>
                        יום {p.day}
                      </span>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--nav-inactive-text)', marginBottom: 5 }}>
                        <span>היענות · Adherence</span>
                        <span>{p.adherence}%</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--sand)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 'var(--radius-pill)', width: `${p.adherence ?? 0}%`, background: (p.adherence ?? 0) < 70 ? 'var(--flag-red)' : 'var(--gold-deep)' }} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <AddPatientModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['patients'] })}
      />
    </AppShell>
  );
}

type ProtoExercise = {
  exercise_id: string;
  name: string;
  name_en: string | null;
  order: number;
  prescription: { sets?: number; reps?: number; rest_sec?: number } | null;
};
type ProtoPhase = {
  n: number;
  name: string;
  name_en: string | null;
  duration_days: number | null;
  exercises: ProtoExercise[];
};
type ProtocolOption = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  region: string | null;
  phases: ProtoPhase[];
};

type ExSearchRow = { id: string; name: string; name_en: string | null };

function presSummary(p: ProtoExercise['prescription']): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.sets != null && p.reps != null) parts.push(`${p.sets}×${p.reps}`);
  if (p.rest_sec != null) parts.push(`${p.rest_sec}s מנוחה`);
  return parts.join(' · ');
}

function AddPatientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [protocolId, setProtocolId] = useState('');
  const [phaseN, setPhaseN] = useState(1);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [condition, setCondition] = useState('');
  const [conditionTouched, setConditionTouched] = useState(false);
  const [picked, setPicked] = useState<ExSearchRow[]>([]);
  const [exQuery, setExQuery] = useState('');
  const [exResults, setExResults] = useState<ExSearchRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<{ patientId: string; inviteUrl: string; emailed: boolean } | null>(null);

  const { data: protocols, isLoading: protoLoading, error: protoError } = useQuery({
    queryKey: ['protocol-options'],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('protocols', { method: 'GET' });
      if (error) throw error;
      return data as ProtocolOption[];
    },
  });

  const isOther = protocolId === OTHER;
  const selectedProtocol = protocols?.find((p) => p.id === protocolId) ?? null;
  const selectedPhase =
    selectedProtocol?.phases.find((ph) => ph.n === phaseN) ?? selectedProtocol?.phases[0] ?? null;

  // "Other" collapses the phase step; the wizard runs 1 -> 3.
  const stepList = isOther ? [1, 3] : [1, 2, 3];

  const nameValid = name.trim().length > 0;
  const emailValid = EMAIL_RE.test(email.trim());
  const conditionValid = condition.trim().length > 0;
  const step1Valid = nameValid && emailValid && !!protocolId && (!isOther || conditionValid);

  useEffect(() => {
    if (!open || !isOther || step !== 3) return;
    const h = setTimeout(async () => {
      const params = new URLSearchParams();
      if (exQuery.trim()) params.set('q', exQuery.trim());
      const { data } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
      setExResults((data as { items: ExSearchRow[] })?.items ?? []);
    }, 250);
    return () => clearTimeout(h);
  }, [open, isOther, step, exQuery, supabase]);

  function reset() {
    setStep(1);
    setName('');
    setEmail('');
    setPhone('');
    setNameTouched(false);
    setEmailTouched(false);
    setProtocolId('');
    setPhaseN(1);
    setExcluded([]);
    setCondition('');
    setConditionTouched(false);
    setPicked([]);
    setExQuery('');
    setExResults([]);
    setSaving(false);
    setSaveError(null);
    setResult(null);
  }

  function close() {
    reset();
    onClose();
  }

  function pickProtocol(id: string) {
    setProtocolId(id);
    setPhaseN(1);
    setExcluded([]);
    setCondition('');
    setConditionTouched(false);
    setPicked([]);
    setExQuery('');
    setExResults([]);
  }

  function toggleExclude(id: string) {
    setExcluded((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]));
  }

  function addPicked(row: ExSearchRow) {
    setPicked((p) => (p.some((x) => x.id === row.id) ? p : [...p, row]));
  }

  function removePicked(id: string) {
    setPicked((p) => p.filter((x) => x.id !== id));
  }

  async function handleCreate() {
    setSaving(true);
    setSaveError(null);
    const { data, error } = await supabase.functions.invoke('patient-invite', {
      method: 'POST',
      body: isOther
        ? {
            name: name.trim(),
            email: email.trim(),
            condition: condition.trim(),
            custom_exercise_ids: picked.map((p) => p.id),
          }
        : {
            name: name.trim(),
            email: email.trim(),
            protocol_id: protocolId,
            start_phase_n: phaseN,
            excluded_exercise_ids: excluded,
          },
    });
    setSaving(false);
    if (error || data?.error || !data?.invite_token) {
      setSaveError(t('error.save.body'));
      return;
    }
    setResult({
      patientId: data.patient_id,
      inviteUrl: data.invite_url ?? `${window.location.origin}/m/invite/${data.invite_token}`,
      emailed: Boolean(data.emailed),
    });
    onCreated();
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      toast.show(t('toast.copied'), { tone: 'success' });
    } catch {
      toast.show(t('error.generic.body'), { tone: 'error' });
    }
  }

  let footer: ReactNode;
  if (result) {
    footer = (
      <>
        <Button variant="ghost" onClick={close}>סגור · Close</Button>
        <Button
          onClick={() => {
            const id = result.patientId;
            close();
            navigate({ to: '/patients/$patientId', params: { patientId: id } });
          }}
        >
          פתח כרטיס · Open patient
        </Button>
      </>
    );
  } else if (step === 1) {
    footer = (
      <>
        <Button variant="ghost" onClick={close}>ביטול · Cancel</Button>
        <Button
          disabled={!step1Valid}
          onClick={() => {
            if (!step1Valid) {
              setNameTouched(true);
              setEmailTouched(true);
              setConditionTouched(true);
              return;
            }
            setStep(isOther ? 3 : 2);
          }}
        >
          הבא · Next
        </Button>
      </>
    );
  } else if (step === 2) {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep(1)}>← הקודם · Back</Button>
        <Button onClick={() => setStep(3)}>הבא · Next</Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep(isOther ? 1 : 2)}>← הקודם · Back</Button>
        <Button
          loading={saving}
          disabled={isOther && picked.length === 0}
          onClick={handleCreate}
        >
          הפעל תכנית · Activate
        </Button>
      </>
    );
  }

  const includedCount = selectedPhase
    ? selectedPhase.exercises.filter((e) => !excluded.includes(e.exercise_id)).length
    : 0;

  return (
    <Modal open={open} onClose={close} title="מטופל חדש · Add patient" size="sm" footer={footer}>
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 14, color: 'var(--ink)' }}>
            {result.emailed
              ? `נשלח מייל הפעלה ל${name.trim()} · Activation email sent`
              : t('toast.invite_sent', { name: name.trim() })}
          </div>
          <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
            התכנית הוקצתה. שלח/י למטופל/ת את קישור ההפעלה · Plan assigned. Share the activation link.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={result.inviteUrl}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                padding: '9px 12px',
                border: '1px solid var(--shell-border)',
                borderRadius: 9,
                fontFamily: 'inherit',
                fontSize: 12,
                background: 'var(--shell-sidebar-bg)',
                color: 'var(--ink-soft)',
              }}
            />
            <Button size="sm" variant="ghost" onClick={copyLink}>העתק · Copy</Button>
          </div>
          {phone.trim() && (
            <Button
              size="sm"
              onClick={() => {
                const text = `שלום ${name.trim()}, הוזמנת להפעיל את חשבון ReCOVR שלך. הקישור: ${result.inviteUrl}`;
                const waLink = `https://wa.me/${toWhatsAppDigits(phone)}?text=${encodeURIComponent(text)}`;
                window.open(waLink, '_blank', 'noopener');
              }}
            >
              שלח בוואטסאפ · Send via WhatsApp
            </Button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
              שלב {stepList.indexOf(step) + 1} / {stepList.length} · Step {stepList.indexOf(step) + 1} of {stepList.length}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {stepList.map((s, i) => (
              <div
                key={s}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 'var(--radius-pill)',
                  background: i <= stepList.indexOf(step) ? 'var(--gold-deep)' : 'var(--sand)',
                }}
              />
            ))}
          </div>

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input
                label="שם מלא · Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                error={nameTouched && !nameValid ? t('valid.required') : undefined}
              />
              <Input
                label="אימייל · Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                error={
                  emailTouched && !emailValid
                    ? email.trim().length === 0
                      ? t('valid.required')
                      : t('valid.email')
                    : undefined
                }
              />
              <Input
                label="טלפון (לשליחה בוואטסאפ) · Phone (optional, for WhatsApp)"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              {protoError ? (
                <span style={{ fontSize: 13, color: 'var(--flag-red)' }}>{t('error.generic.body')}</span>
              ) : (
                <Select
                  label="פציעה · Injury"
                  value={protocolId}
                  onChange={(e) => pickProtocol(e.target.value)}
                  options={[
                    { value: '', label: protoLoading ? t('loading.generic') : 'בחר/י פרוטוקול…' },
                    ...(protocols ?? []).map((p) => ({ value: p.id, label: p.name })),
                    { value: OTHER, label: 'אחר · Other' },
                  ]}
                />
              )}
              {isOther && (
                <Input
                  label="תיאור הבעיה · Problem description"
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  onBlur={() => setConditionTouched(true)}
                  error={conditionTouched && !conditionValid ? t('valid.required') : undefined}
                />
              )}
              {selectedProtocol && (
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                  פרוטוקול נבחר · Selected:{' '}
                  <strong style={{ color: 'var(--ink)' }}>{selectedProtocol.name}</strong>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                בחר/י שלב התחלה · Select starting phase
              </div>
              {(selectedProtocol?.phases ?? []).map((ph) => {
                const active = ph.n === phaseN;
                return (
                  <div
                    key={ph.n}
                    {...clickableDivProps(() => {
                      setPhaseN(ph.n);
                      setExcluded([]);
                    })}
                    style={{
                      border: `1px solid ${active ? 'var(--gold-deep)' : 'var(--shell-border)'}`,
                      background: active ? 'var(--sand)' : 'transparent',
                      borderRadius: 10,
                      padding: '10px 12px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
                      שלב {ph.n} · {ph.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
                      {ph.name_en}
                      {ph.duration_days ? ` · ${ph.duration_days} ימים` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {step === 3 && isOther && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                בחירת תרגילים · Choose exercises
              </div>
              <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                כל תרגיל נוסף עם מרשם ברירת מחדל 3×10 · Each added with a default 3×10; fine-tune later on the patient card ({picked.length})
              </div>

              {picked.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {picked.map((ex) => (
                    <span
                      key={ex.id}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        border: '1px solid var(--gold-deep)', background: 'var(--sand)',
                        color: 'var(--ink)', fontSize: 12, padding: '4px 8px', borderRadius: 'var(--radius-pill)',
                      }}
                    >
                      {ex.name}
                      <button
                        type="button"
                        onClick={() => removePicked(ex.id)}
                        aria-label={`הסר ${ex.name}`}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--nav-inactive-text)', fontSize: 14, lineHeight: 1, padding: 0 }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <Input
                label="חיפוש תרגילים · Search exercises"
                value={exQuery}
                onChange={(e) => setExQuery(e.target.value)}
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {exResults
                  .filter((ex) => !picked.some((p) => p.id === ex.id))
                  .slice(0, 20)
                  .map((ex) => (
                    <div
                      key={ex.id}
                      {...clickableDivProps(() => addPicked({ id: ex.id, name: ex.name, name_en: ex.name_en }))}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        border: '1px solid var(--shell-border)', borderRadius: 10, padding: '9px 12px',
                        fontSize: 13, color: 'var(--ink)', cursor: 'pointer',
                      }}
                    >
                      <span>
                        {ex.name}{' '}
                        <span style={{ color: 'var(--nav-inactive-text)', fontSize: 11 }}>{ex.name_en}</span>
                      </span>
                      <span style={{ color: 'var(--gold-deep)', fontSize: 12, fontWeight: 700 }}>+ הוסף</span>
                    </div>
                  ))}
                {exResults.filter((ex) => !picked.some((p) => p.id === ex.id)).length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                    אין תוצאות · No matching exercises
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && !isOther && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                התאמת התכנית · Customize plan
              </div>
              <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                בטל/י סימון כדי להסיר תרגיל מהתכנית ההתחלתית · Uncheck to remove an exercise ({includedCount})
              </div>
              {(selectedPhase?.exercises ?? []).map((ex) => (
                <label
                  key={ex.exercise_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    border: '1px solid var(--shell-border)',
                    borderRadius: 10,
                    padding: '10px 12px',
                    fontSize: 13,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!excluded.includes(ex.exercise_id)}
                    onChange={() => toggleExclude(ex.exercise_id)}
                  />
                  <span>
                    {ex.name}{' '}
                    <span style={{ color: 'var(--nav-inactive-text)', fontSize: 11 }}>
                      {[ex.name_en, presSummary(ex.prescription)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </label>
              ))}
              {(selectedPhase?.exercises.length ?? 0) === 0 && (
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                  אין תרגילים מוגדרים לשלב זה · No exercises defined for this phase
                </div>
              )}
            </div>
          )}

          {saveError && <span style={{ fontSize: 13, color: 'var(--flag-red)' }}>{saveError}</span>}
        </div>
      )}
    </Modal>
  );
}
