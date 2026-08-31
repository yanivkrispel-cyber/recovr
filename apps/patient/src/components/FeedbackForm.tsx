import { useState } from 'react';

interface FeedbackFormProps {
  onSubmit: (data: { pain: number; difficulty: 'easy' | 'medium' | 'hard'; note?: string }) => void;
  loading: boolean;
}

export default function FeedbackForm({ onSubmit, loading }: FeedbackFormProps) {
  const [pain, setPain] = useState(0);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [note, setNote] = useState('');

  return (
    <div>
      <h2
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--patient-text)',
          fontFamily: 'var(--font-display)',
          margin: '0 0 24px',
          textAlign: 'center',
        }}
      >
        איך הרגשת?
      </h2>

      {/* Pain scale 0-10 */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--patient-text)',
            marginBottom: 8,
          }}
        >
          כאב
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: 11 }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPain(i)}
              style={{
                flex: 1,
                minHeight: 44,
                background: pain === i ? 'var(--patient-gold)' : 'var(--patient-card)',
                color: pain === i ? 'var(--patient-gold-ink)' : 'var(--patient-text)',
                border: '1px solid var(--patient-border)',
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      {/* Difficulty */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--patient-text)',
            marginBottom: 8,
          }}
        >
          קושי
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['easy', 'medium', 'hard'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDifficulty(d)}
              style={{
                flex: 1,
                minHeight: 44,
                background: difficulty === d ? 'var(--patient-gold)' : 'var(--patient-card)',
                color: difficulty === d ? 'var(--patient-gold-ink)' : 'var(--patient-text)',
                border: '1px solid var(--patient-border)',
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {d === 'easy' ? 'קל' : d === 'medium' ? 'בינוני' : 'קשה'}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="הערה (לא חובה)"
        rows={3}
        style={{
          width: '100%',
          padding: 12,
          borderRadius: 10,
          border: '1px solid var(--patient-border)',
          background: 'var(--patient-card)',
          color: 'var(--patient-text)',
          fontSize: 14,
          fontFamily: 'var(--font-ui)',
          resize: 'none',
          marginBottom: 24,
          boxSizing: 'border-box',
        }}
      />

      <button
        onClick={() => onSubmit({ pain, difficulty, note: note || undefined })}
        disabled={loading}
        style={{
          width: '100%',
          minHeight: 56,
          background: 'var(--patient-gold)',
          color: 'var(--patient-gold-ink)',
          border: 'none',
          borderRadius: 999,
          fontSize: 16,
          fontWeight: 700,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
          fontFamily: 'inherit',
        }}
      >
        {loading ? 'שומר…' : 'סיום תרגיל'}
      </button>
    </div>
  );
}
