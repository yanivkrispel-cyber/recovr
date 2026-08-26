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
          fontSize: 22,
          fontWeight: 700,
          color: 'var(--navy)',
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
            color: 'var(--ink)',
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
                background: pain === i ? 'var(--navy)' : 'var(--white)',
                color: pain === i ? 'var(--cream)' : 'var(--ink)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-button)',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
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
            color: 'var(--ink)',
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
                background: difficulty === d ? 'var(--navy)' : 'var(--white)',
                color: difficulty === d ? 'var(--cream)' : 'var(--ink)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-button)',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
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
          borderRadius: 'var(--radius-button)',
          border: '1px solid var(--line-input)',
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
          background: 'var(--navy)',
          color: 'var(--cream)',
          border: 'none',
          borderRadius: 'var(--radius-button)',
          fontSize: 16,
          fontWeight: 700,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'שומר…' : 'סיום תרגיל'}
      </button>
    </div>
  );
}
