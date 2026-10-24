import { useEffect, useMemo, useState } from 'react';
import type { Range } from '../lib/queries';
import { Input, Tabs } from './ui';

export type Preset = '1h' | '24h' | '7d' | '30d' | '90d' | 'custom';
const MS: Record<Exclude<Preset, 'custom'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

const toLocalInput = (ts: number) => {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Range state that rolls forward every minute for presets, so live pages keep showing "now". */
export function useRange(initial: Preset = '24h') {
  const [preset, setPreset] = useState<Preset>(initial);
  const [custom, setCustom] = useState<Range>(() => ({ from: Date.now() - MS['24h'], to: Date.now() }));
  const [tickMin, setTickMin] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setTickMin(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(t);
  }, []);
  const range = useMemo<Range>(() => {
    if (preset === 'custom') return custom;
    const to = (tickMin + 1) * 60_000;
    return { from: to - MS[preset], to };
  }, [preset, custom, tickMin]);
  return { preset, setPreset, range, custom, setCustom };
}

export function TimeRangePicker({ state }: { state: ReturnType<typeof useRange> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        value={state.preset}
        onChange={(p) => {
          if (p === 'custom') state.setCustom(state.range);
          state.setPreset(p);
        }}
        options={(['1h', '24h', '7d', '30d', '90d', 'custom'] as const).map((p) => ({ value: p, label: p === 'custom' ? 'Custom' : p }))}
      />
      {state.preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input type="datetime-local" className="h-8 w-auto text-xs" value={toLocalInput(state.custom.from)} onChange={(e) => e.target.value && state.setCustom({ ...state.custom, from: new Date(e.target.value).getTime() })} />
          <span className="text-muted">→</span>
          <Input type="datetime-local" className="h-8 w-auto text-xs" value={toLocalInput(state.custom.to)} onChange={(e) => e.target.value && state.setCustom({ ...state.custom, to: new Date(e.target.value).getTime() })} />
        </div>
      )}
    </div>
  );
}
