import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import Dashboard from './pages/Dashboard';
import PatientList from './pages/PatientList';
import PatientOverview from './pages/PatientOverview';
import ExerciseLibrary from './pages/ExerciseLibrary';
import Protocols from './pages/Protocols';
import Settings from './pages/Settings';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
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
