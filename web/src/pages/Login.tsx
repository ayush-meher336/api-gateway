import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, ErrorNote, Field, Input, Spinner } from '../components/ui';
import { api } from '../lib/api';

export function Login() {
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api<{ setupRequired: boolean; authenticated: boolean }>('auth/status') });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  if (status.isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (status.data?.authenticated) return <Navigate to="/" replace />;
  const setup = status.data?.setupRequired ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && pw !== pw2) return setError(new Error('Passwords do not match'));
    setBusy(true);
    try {
      await api(setup ? 'auth/setup' : 'auth/login', { method: 'POST', json: { password: pw } });
      await qc.invalidateQueries();
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface p-7 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent text-accent-fg">
            <Waypoints className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">AI Gateway</h1>
            <p className="text-sm text-muted">{setup ? 'Create your admin password' : 'Sign in to the dashboard'}</p>
          </div>
        </div>
        <Field label="Password" hint={setup ? 'At least 8 characters.' : undefined}>
          <Input type="password" autoFocus autoComplete={setup ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        {setup && (
          <Field label="Confirm password">
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
        )}
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={pw.length < (setup ? 8 : 1)}>
          {setup ? 'Create password & continue' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
