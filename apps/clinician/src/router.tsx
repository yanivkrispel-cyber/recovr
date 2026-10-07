import { Suspense } from 'react';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { Skeleton, lazyWithRetry } from 'ui';
import Dashboard from './pages/Dashboard';

// Dashboard loads with the shell; the rest split into their own chunks so
// first paint doesn't carry the whole app (mirrors patient app, T-24).
const PatientList = lazyWithRetry(() => import('./pages/PatientList'));
const PatientOverview = lazyWithRetry(() => import('./pages/PatientOverview'));
const ExerciseLibrary = lazyWithRetry(() => import('./pages/ExerciseLibrary'));
const Protocols = lazyWithRetry(() => import('./pages/Protocols'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const Messages = lazyWithRetry(() => import('./pages/Messages'));
const Chat = lazyWithRetry(() => import('./pages/Chat'));
const Calendar = lazyWithRetry(() => import('./pages/Calendar'));
const CalendarSetup = lazyWithRetry(() => import('./pages/CalendarSetup'));

export const PATIENT_TABS = ['overview', 'plan', 'progress', 'assessments', 'history', 'messages'] as const;
export type PatientTab = (typeof PATIENT_TABS)[number];

function ViewFallback() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 24 }}>
      <Skeleton width={160} height={19} />
      <Skeleton count={4} height={48} radius={12} />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={<ViewFallback />}>
      <Outlet />
    </Suspense>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: Dashboard,
});

const patientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patients',
  component: PatientList,
  validateSearch: (search: Record<string, unknown>): { invite?: boolean } => ({
    invite: search.invite === true || search.invite === '1' ? true : undefined,
  }),
});

const patientOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patients/$patientId',
  component: PatientOverview,
  // session: a session date (YYYY-MM-DD) or 'latest' — the History tab opens
  // with that session's exercise feedback expanded (pain alert deep link).
  validateSearch: (search: Record<string, unknown>): { tab?: PatientTab; session?: string } => ({
    tab: PATIENT_TABS.includes(search.tab as PatientTab) ? (search.tab as PatientTab) : undefined,
    session:
      search.session === 'latest' || (typeof search.session === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.session))
        ? (search.session as string)
        : undefined,
  }),
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: Messages,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages/$patientId',
  component: Chat,
});

const protocolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/protocols',
  component: Protocols,
});

const exercisesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/exercises',
  component: ExerciseLibrary,
  validateSearch: (search: Record<string, unknown>): { id?: string } => ({
    id: typeof search.id === 'string' && /^[0-9a-f-]{36}$/i.test(search.id) ? search.id : undefined,
  }),
});

const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  component: Calendar,
  // date: the clinic-local day to show (YYYY-MM-DD, default today);
  // view: day / week / month (default: week on desktop, day on a phone).
  validateSearch: (search: Record<string, unknown>): { date?: string; view?: 'day' | 'week' | 'month' } => ({
    date: typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : undefined,
    view: search.view === 'day' || search.view === 'week' || search.view === 'month' ? search.view : undefined,
  }),
});

const calendarSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar/setup',
  component: CalendarSetup,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  patientsRoute,
  patientOverviewRoute,
  messagesRoute,
  chatRoute,
  protocolsRoute,
  exercisesRoute,
  calendarRoute,
  calendarSetupRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, basepath: '/app' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
