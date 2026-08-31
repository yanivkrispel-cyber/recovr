import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import Dashboard from './pages/Dashboard';
import PatientList from './pages/PatientList';
import PatientOverview from './pages/PatientOverview';
import ExerciseLibrary from './pages/ExerciseLibrary';

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
});

const patientOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patients/$patientId',
  component: PatientOverview,
});

const exercisesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/exercises',
  component: ExerciseLibrary,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  patientsRoute,
  patientOverviewRoute,
  exercisesRoute,
]);

export const router = createRouter({ routeTree, basepath: '/app' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
