import {
  Activity, BarChart3, Boxes, KeyRound, LayoutDashboard, LogOut, Menu, Moon, ScrollText, Server, Settings as SettingsIcon, Sun, Waypoints, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useAlerts } from '../lib/queries';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/keys', label: 'Upstream keys', icon: KeyRound },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/aliases', label: 'Aliases', icon: Waypoints },
  { to: '/gateway-keys', label: 'Gateway keys', icon: Activity },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* storage unavailable */
    }
  };
  return { dark, toggle };
}

export function Layout({ children }: { children: ReactNode }) {
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const alerts = useAlerts();
  const errorCount = alerts.data?.filter((a) => a.severity === 'error').length ?? 0;

  const nav = (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition',
              isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )
          }
        >
          <Icon className="size-4" />
          <span className="flex-1">{label}</span>
          {to === '/' && errorCount > 0 && <span className="rounded-full bg-err px-1.5 text-[10px] font-semibold leading-4 text-white">{errorCount}</span>}
        </NavLink>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <div className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg shadow-sm">
        <Waypoints className="size-4.5" />
      </div>
      <div>
        <div className="text-[15px] font-semibold leading-tight">AI Gateway</div>
        <div className="text-[11px] text-muted">127.0.0.1 · {location.port || '80'}</div>
      </div>
    </div>
  );

  const footer = (
    <div className="mt-auto flex items-center gap-1 border-t border-border px-3 py-3">
      <button onClick={toggle} className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        {dark ? 'Light mode' : 'Dark mode'}
      </button>
      <button
        title="Log out"
        aria-label="Log out"
        onClick={async () => {
          await api('auth/logout', { method: 'POST' }).catch(() => {});
          location.href = '/login';
        }}
        className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
      >
        <LogOut className="size-4" />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        {brand}
        {nav}
        {footer}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="flex h-full w-64 flex-col bg-surface" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pr-3">
              {brand}
              <button onClick={() => setOpen(false)} className="p-2 text-muted" aria-label="Close menu">
                <X className="size-5" />
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="p-1 text-muted" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="font-semibold">{NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.label ?? 'AI Gateway'}</span>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
