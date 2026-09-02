import 'tokens/index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider, ErrorBoundary } from 'ui';
import App from './App';

const errorSink = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/client-errors`;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary app="clinician" reportUrl={errorSink} reportKey={import.meta.env.VITE_SUPABASE_ANON_KEY}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
