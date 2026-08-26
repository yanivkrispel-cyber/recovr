import { createClient } from '@supabase/supabase-js';
import { useState } from 'react';
import Home from './pages/Home';
import ExerciseFlow from './pages/ExerciseFlow';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export { supabase };

type View = 'home' | 'exercise' | 'completion';

export default function App() {
  const [view, setView] = useState<View>('home');
  const [activeExerciseIndex, setActiveExerciseIndex] = useState(0);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cream)',
        fontFamily: 'var(--font-ui)',
        direction: 'rtl',
      }}
    >
      {view === 'home' && (
        <Home
          onStartExercise={(index) => {
            setActiveExerciseIndex(index);
            setView('exercise');
          }}
        />
      )}
      {view === 'exercise' && (
        <ExerciseFlow
          index={activeExerciseIndex}
          onComplete={() => setView('completion')}
          onCancel={() => setView('home')}
        />
      )}
      {view === 'completion' && (
        <CompletionScreen onDone={() => setView('home')} />
      )}
    </div>
  );
}

function CompletionScreen({ onDone }: { onDone: () => void }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', paddingTop: 80 }}>
      <div
        style={{
          width: 80,
          height: 80,
          margin: '0 auto 24px',
          borderRadius: '50%',
          background: 'var(--flag-green)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <path d="M10 20l7 7 13-15" stroke="var(--cream)" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      <h1
        style={{
          margin: '0 0 8px',
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--navy)',
          fontFamily: 'var(--font-display)',
        }}
      >
        סיימת להיום
      </h1>
      <p style={{ margin: '0 0 32px', fontSize: 15, color: 'var(--muted)' }}>
        נתראה באימון הבא
      </p>
      <button
        onClick={onDone}
        style={{
          background: 'var(--navy)',
          color: 'var(--cream)',
          border: 'none',
          borderRadius: 'var(--radius-button)',
          padding: '14px 32px',
          fontSize: 15,
          fontWeight: 600,
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        צפייה בהתקדמות
      </button>
    </div>
  );
}
