import { lazy, Suspense } from 'react';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { Skeleton } from 'ui';
import Dashboard from './pages/Dashboard';

// Dashboard loads with the shell; the rest split into their own chunks so
// first paint doesn't carry the whole app (mirrors patient app, T-24).
const PatientList = lazy(() => import('./pages/PatientList'));
const PatientOverview = lazy(() => import('./pages/PatientOverview'));
const ExerciseLibrary = lazy(() => import('./pages/ExerciseLibrary'));
const Protocols = lazy(() => import('./pages/Protocols'));
const Settings = lazy(() => import('./pages/Settings'));

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
  protocolsRoute,
  exercisesRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, basepath: '/app' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
