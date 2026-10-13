import type { Permission } from '@picc/contracts';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Empty, Loading } from './components/ui';
import { AdminPage } from './pages/Admin';
import { AlertsPage } from './pages/Alerts';
import { CostsPage } from './pages/Costs';
import { DataQualityPage } from './pages/DataQuality';
import { LoginPage } from './pages/Login';
import { OrphansPage } from './pages/Orphans';
import { OverviewPage } from './pages/Overview';
import { ReportDetailPage } from './pages/ReportDetail';
import { ReportsPage } from './pages/Reports';

/** Hides a page the role cannot use. This is a convenience only: the API enforces the same
 *  permission on every request, so removing this check would expose nothing. */
function Guard({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <Empty
        title="Not available for your role"
        hint={`This page needs the "${permission}" permission.`}
      />
    );
  }
  return <>{children}</>;
}

export function App() {
  const { user, restoring } = useAuth();
  if (restoring) return <Loading label="Restoring session" />;
  if (!user) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reports/:reportId" element={<ReportDetailPage />} />
        <Route
          path="orphans"
          element={
            <Guard permission="orphans:read">
              <OrphansPage />
            </Guard>
          }
        />
        <Route path="alerts" element={<AlertsPage />} />
        <Route
          path="costs"
          element={
            <Guard permission="costs:read">
              <CostsPage />
            </Guard>
          }
        />
        <Route
          path="data-quality"
          element={
            <Guard permission="dq:read">
              <DataQualityPage />
            </Guard>
          }
        />
        <Route
          path="admin"
          element={
            <Guard permission="users:read">
              <AdminPage />
            </Guard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
