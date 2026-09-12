import { useContext, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t, parseYouTubeId } from 'shared';
import { Button, Checkbox, Input, Modal, Select, YouTubeFacade, useToast } from 'ui';
import { SupabaseContext } from '../App';

interface EditableProtocol {
  id: string;
  name: string;
  is_editable: boolean;
  is_active: boolean;
}

interface ProtocolPhase {
  n: number;
  name: string;
}

export interface ExerciseFormValues {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  region: string | null;
  description: string | null;
  instructions: string | null;
  is_bilateral: boolean;
  /** Bare 11-char YouTube id, if a tutorial video is already attached. */
  video_youtube_id?: string | null;
}

const CATEGORY_OPTIONS = [
  { value: 'Mobility', label: 'ניידות' },
  { value: 'Strength', label: 'כוח' },
  { value: 'Balance', label: 'שיווי משקל' },
  { value: 'Control', label: 'בקרה' },
  { value: 'Cardio', label: 'אירובי' },
];

const textareaStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '10px 12px',
  borderRadius: 'var(--radius-button)',
  border: 'var(--border-input)',
  background: 'var(--white)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
  resize: 'vertical' as const,
  minHeight: 64,
};

// Doubles as the "create exercise" form and the "edit exercise" form — pass
// `exercise` to prefill and PUT instead of POST. Only clinic-owned exercises
// are ever editable (enforced server-side by update_custom_exercise); a
// system-library exercise must be duplicated first (see ExerciseDetailDrawer).
export default function ExerciseFormModal({
  open,
  onClose,
  onSaved,
  exercise,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  exercise?: ExerciseFormValues | null;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const isEdit = !!exercise;
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState('Strength');
  const [region, setRegion] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [isBilateral, setIsBilateral] = useState(false);
  const [videoInput, setVideoInput] = useState('');
  const [videoTouched, setVideoTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [protocolId, setProtocolId] = useState('');
  const [phaseN, setPhaseN] = useState('');
  const nameValid = name.trim().length > 0;
  const videoValid = videoInput.trim().length === 0 || parseYouTubeId(videoInput) !== null;

  // Re-seed the form whenever a different exercise is opened for editing (or
  // the modal is reopened in create mode after a previous edit).
  useEffect(() => {
    if (!open) return;
    setName(exercise?.name ?? '');
    setNameEn(exercise?.name_en ?? '');
    setCategory(exercise?.category ?? 'Strength');
    setRegion(exercise?.region ?? '');
    setDescription(exercise?.description ?? '');
    setInstructions(exercise?.instructions ?? '');
    setIsBilateral(exercise?.is_bilateral ?? false);
    setVideoInput(exercise?.video_youtube_id ?? '');
    setNameTouched(false);
    setVideoTouched(false);
    setSaveError(null);
    setProtocolId('');
    setPhaseN('');
  }, [open, exercise]);

  // Quick-attach (optional): only the clinic's own protocols can be targeted —
  // system protocols aren't editable, same rule as everything else here.
  const { data: protocols } = useQuery({
    queryKey: ['protocols-manage'],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('protocols/manage', { method: 'GET' });
      if (error) throw error;
      return ((data as EditableProtocol[] | { error?: string }) ?? []) as EditableProtocol[];
    },
  });
  const editableProtocols = (Array.isArray(protocols) ? protocols : []).filter((p) => p.is_editable && p.is_active);

  const { data: protocolDetail } = useQuery({
    queryKey: ['protocol-detail-for-attach', protocolId],
    enabled: open && !!protocolId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`protocols/${protocolId}`, { method: 'GET' });
      if (error) throw error;
      return data as { phases: ProtocolPhase[] };
    },
  });
  const phases = protocolDetail?.phases ?? [];

  async function attachToProtocol(exerciseId: string) {
    if (!protocolId || !phaseN) return;
    const { data, error } = await supabase.functions.invoke(`protocols/${protocolId}/exercises`, {
      method: 'POST',
      body: { exercise_id: exerciseId, phase_n: Number(phaseN) },
    });
    if (error || (data as { error?: string })?.error) {
      toast.show('התרגיל נשמר, אך השיוך לפרוטוקול נכשל · Exercise saved, but couldn’t attach it to the protocol', { tone: 'error', duration: 4000 });
      return;
    }
    toast.show('התרגיל שויך לפרוטוקול · Exercise attached to the protocol', { tone: 'success' });
  }

  async function saveVideo(exerciseId: string, youtubeId: string | null) {
    const { data, error } = await supabase.functions.invoke(`exercises/${exerciseId}/video`, {
      method: 'PUT',
      body: { youtube_id: youtubeId },
    });
    if (error || (data as { error?: string })?.error) {
      toast.show('התרגיל נשמר, אך שמירת קישור הסרטון נכשלה · Exercise saved, but the video link failed to save', { tone: 'error', duration: 4000 });
    }
  }

  async function handleSave() {
    if (!nameValid || !videoValid) {
      setNameTouched(true);
      setVideoTouched(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const body = {
      name: name.trim(),
      name_en: nameEn.trim() || undefined,
      category,
      region: region.trim() || undefined,
      description: description.trim() || undefined,
      instructions: instructions.trim() || undefined,
      is_bilateral: isBilateral,
    };
    const { data, error } = isEdit
      ? await supabase.functions.invoke(`exercises/${exercise!.id}`, { method: 'PUT', body })
      : await supabase.functions.invoke('exercises', { method: 'POST', body });
    if (error || (data as { error?: string })?.error) {
      setSaving(false);
      setSaveError(t('error.save.body'));
      return;
    }
    const savedId = isEdit ? exercise!.id : (data as { id: string }).id;
    const nextVideoId = videoInput.trim() ? parseYouTubeId(videoInput) : null;
    if (nextVideoId !== (exercise?.video_youtube_id ?? null)) {
      await saveVideo(savedId, nextVideoId);
    }
    await attachToProtocol(savedId);
    setSaving(false);
    onSaved();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'עריכת תרגיל · Edit Exercise' : 'תרגיל חדש · New Exercise'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('clinician.plan.discard')}</Button>
          <Button loading={saving} disabled={!nameValid || !videoValid || saving} onClick={handleSave}>
            {isEdit ? 'שמור שינויים · Save changes' : 'שמור תרגיל'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          label="שם התרגיל"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setNameTouched(true)}
          error={nameTouched && !nameValid ? t('valid.required') : undefined}
        />
        <Input label="שם באנגלית" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        <Select
          label="קטגוריה"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={CATEGORY_OPTIONS}
        />
        <Input label="אזור" value={region} onChange={(e) => setRegion(e.target.value)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>תיאור</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={textareaStyle} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>הוראות ביצוע</label>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} style={textareaStyle} />
        </div>
        <Checkbox
          label="תרגיל דו-צדדי"
          checked={isBilateral}
          onChange={(e) => setIsBilateral(e.target.checked)}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input
            label="קישור לסרטון YouTube (אופציונלי) · YouTube video link (optional)"
            value={videoInput}
            onChange={(e) => setVideoInput(e.target.value)}
            onBlur={() => setVideoTouched(true)}
            placeholder="https://youtube.com/watch?v=…"
            dir="ltr"
            error={videoTouched && !videoValid ? 'קישור YouTube לא תקין · Not a recognizable YouTube link' : undefined}
          />
          {videoValid && parseYouTubeId(videoInput) && (
            <YouTubeFacade youtubeId={parseYouTubeId(videoInput)!} title={name || 'תצוגה מקדימה · Preview'} height={160} />
          )}
        </div>

        {editableProtocols.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBlockStart: 4, borderBlockStart: '1px solid var(--shell-border-soft)' }}>
            <label style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
              שיוך לפרוטוקול (אופציונלי) · Add to protocol (optional)
            </label>
            <Select
              value={protocolId}
              onChange={(e) => { setProtocolId(e.target.value); setPhaseN(''); }}
              options={[{ value: '', label: 'ללא · None' }, ...editableProtocols.map((p) => ({ value: p.id, label: p.name }))]}
            />
            {protocolId && (
              <Select
                value={phaseN}
                onChange={(e) => setPhaseN(e.target.value)}
                options={[
                  { value: '', label: 'בחרו שלב · Select a phase' },
                  ...phases.map((p) => ({ value: String(p.n), label: `${p.n}. ${p.name}` })),
                ]}
              />
            )}
          </div>
        )}

        {saveError && <span style={{ fontSize: 13, color: 'var(--flag-red)' }}>{saveError}</span>}
      </div>
    </Modal>
  );
}
