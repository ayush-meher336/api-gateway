import { useQuery } from '@tanstack/react-query';
import { Component, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Button, Spinner } from './components/ui';
import { api } from './lib/api';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { ProviderDetail } from './pages/ProviderDetail';
import { UpstreamKeys } from './pages/UpstreamKeys';
import { Models } from './pages/Models';
import { Aliases } from './pages/Aliases';
import { GatewayKeys } from './pages/GatewayKeys';
import { GatewayKeyDetail } from './pages/GatewayKeyDetail';
import { Logs } from './pages/Logs';
import { Analytics } from './pages/Analytics';
import { SettingsPage } from './pages/Settings';

/** Keeps one broken page from blanking the whole dashboard. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-err/30 bg-surface p-6">
        <h2 className="font-semibold text-err">This page hit an error</h2>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded bg-surface-2 p-3 text-xs">{this.state.error.message}</pre>
        <Button className="mt-4" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}

function RequireAuth({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['auth'], queryFn: () => api<{ setupRequired: boolean; authenticated: boolean }>('auth/status') });
  if (q.isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (q.isError) return <div className="grid h-full place-items-center text-sm text-err">{(q.error as Error).message}</div>;
  if (!q.data?.authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Layout>
              <Boundary>
                <Routes>
                  <Route path="/" element={<Overview />} />
                  <Route path="/providers" element={<Providers />} />
                  <Route path="/providers/:id" element={<ProviderDetail />} />
                  <Route path="/keys" element={<UpstreamKeys />} />
                  <Route path="/models" element={<Models />} />
                  <Route path="/aliases" element={<Aliases />} />
                  <Route path="/gateway-keys" element={<GatewayKeys />} />
                  <Route path="/gateway-keys/:id" element={<GatewayKeyDetail />} />
                  <Route path="/logs" element={<Logs />} />
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Boundary>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
