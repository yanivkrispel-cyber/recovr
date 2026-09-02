import 'tokens/index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider, ErrorBoundary } from 'ui';
import App from './App';

const errorSink = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/client-errors`;

const queryClient = new QueryClient({
  defaultOptions: {
    // This is an offline-first PWA (T-12): the service worker decides what's
    // servable offline (cache-first media, stale-while-revalidate plan JSON),
    // and the offline queue decides what's safe to defer. React Query's own
    // default networkMode ('online') would short-circuit fetches whenever
    // navigator.onLine is false — before they ever reach the service worker
    // — which both starves the UI of cached data on an offline reload and
    // stalls session-item mutations that are actually local-only IndexedDB
    // writes. 'always' lets every request attempt to run so those layers
    // can do their job.
    queries: {
      staleTime: 30_000,
      retry: 2,
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary app="patient" reportUrl={errorSink} reportKey={import.meta.env.VITE_SUPABASE_ANON_KEY}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
