import { useInfiniteQuery } from '@tanstack/react-query';
import { RefreshCw, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorNote, Input, Mono, PageHeader, Select, Sheet, Spinner, T } from '../components/ui';
import { fmtDateTime, fmtMs, fmtNum, fmtUsd } from '../lib/format';
import { fetchLogs, useGatewayKeys, useLog, useModels, useProviders, useUpstreamKeys, type LogFilters } from '../lib/queries';
import type { Attempt } from '../lib/types';

function useNames() {
  const p = useProviders();
  const k = useUpstreamKeys();
  const g = useGatewayKeys();
  const m = useModels();
  return useMemo(() => {
    const pn = new Map(p.data?.map((x) => [x.id, x.name]));
    return {
      provider: (id: number | null) => (id ? (pn.get(id) ?? `#${id}`) : '—'),
      key: (id: number | null) => {
        const x = k.data?.find((y) => y.id === id);
        return x ? `${x.label} ••••${x.secretPreview}` : id ? `#${id}` : '—';
      },
      gk: (id: number | null) => (id ? (g.data?.find((y) => y.id === id)?.name ?? `#${id}`) : '—'),
      model: (id: number | null) => {
        const x = m.data?.find((y) => y.id === id);
        return x ? x.upstreamModelId : id ? `#${id}` : '—';
      },
    };
  }, [p.data, k.data, g.data, m.data]);
}

function Pretty({ text }: { text: string | null }) {
  if (!text) return <p className="text-sm text-muted">Not stored. Turn on body logging for this gateway key to capture bodies.</p>;
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* plain text */
  }
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs">{shown}</pre>;
}

function LogDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useLog(id);
  const n = useNames();
  const l = q.data;
  return (
    <Sheet open onClose={onClose} title={`Request #${id}`}>
      {!l ? (
        <div className="grid h-40 place-items-center"><Spinner /></div>
      ) : (
        <div className="space-y-6 text-sm">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
            {[
              ['Time', fmtDateTime(l.ts)],
              ['Status', <Badge tone={l.status === 'ok' ? 'ok' : 'err'}>{l.httpStatus ?? '—'} {l.status}</Badge>],
              ['Gateway key', n.gk(l.gatewayKeyId)],
              ['Requested model', <Mono>{l.requestedModel ?? '—'}</Mono>],
              ['Served by', `${n.provider(l.providerId)} / ${n.model(l.modelId)}`],
              ['Upstream key', n.key(l.upstreamKeyId)],
              ['Endpoint', `${l.endpoint}${l.stream ? ' (stream)' : ''}`],
              ['Latency', `${fmtMs(l.latencyMs)}${l.ttftMs != null ? ` · TTFT ${fmtMs(l.ttftMs)}` : ''}`],
              ['Input tokens', `${fmtNum(l.inputTokens)}${l.cachedReadTokens ? ` (${fmtNum(l.cachedReadTokens)} cached)` : ''}`],
              ['Output tokens', `${fmtNum(l.outputTokens)}${l.reasoningTokens ? ` (${fmtNum(l.reasoningTokens)} reasoning)` : ''}`],
              ['Cost', `${fmtUsd(l.costUsd)}${l.usageEstimated ? ' (estimated)' : ''}`],
              ['Client', l.clientIp ?? '—'],
            ].map(([k, v], i) => (
              <div key={i}>
                <div className="text-xs text-muted">{k}</div>
                <div className="mt-0.5">{v}</div>
              </div>
            ))}
          </div>
          {l.errorMessage && (
            <div className="rounded-lg border border-err/30 bg-err/5 p-3">
              <div className="text-xs font-medium text-err">{l.errorType}</div>
              <div className="mt-1 break-words">{l.errorMessage}</div>
            </div>
          )}
          <div>
            <h4 className="mb-2 font-medium">Routing attempts</h4>
            {(l.attempts as Attempt[]).length ? (
              <table className={T.table}>
                <thead>
                  <tr><th className={T.th}>#</th><th className={T.th}>Provider · key</th><th className={T.th}>Result</th><th className={T.th}>Time</th></tr>
                </thead>
                <tbody>
                  {(l.attempts as Attempt[]).map((a) => (
                    <tr key={a.n}>
                      <td className={T.td}>{a.n}</td>
                      <td className={T.td}>{n.provider(a.providerId)} · {n.key(a.upstreamKeyId)}</td>
                      <td className={T.td}>
                        {a.errorType ? <span title={a.errorMessage ?? ''}><Badge tone="err">{a.httpStatus ?? ''} {a.errorType}</Badge></span> : <Badge tone="ok">{a.httpStatus} ok</Badge>}
                        {a.errorMessage && <div className="mt-1 max-w-xs truncate text-xs text-muted" title={a.errorMessage}>{a.errorMessage}</div>}
                      </td>
                      <td className={`${T.td} tabular`}>{fmtMs(a.latencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-muted">Rejected before reaching any provider.</p>
            )}
          </div>
          <div>
            <h4 className="mb-2 font-medium">Request body</h4>
            <Pretty text={l.requestBody} />
          </div>
          <div>
            <h4 className="mb-2 font-medium">Response</h4>
            <Pretty text={l.responseBody} />
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function Logs() {
  const [params, setParams] = useSearchParams();
  const num = (k: string) => (params.get(k) ? Number(params.get(k)) : undefined);
  const filters: LogFilters = {
    gatewayKeyId: num('gatewayKeyId'),
    providerId: num('providerId'),
    upstreamKeyId: num('upstreamKeyId'),
    status: (params.get('status') as 'ok' | 'error') || undefined,
    q: params.get('q') || undefined,
    from: num('from'),
    to: num('to'),
  };
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const [qText, setQText] = useState(filters.q ?? '');
  useEffect(() => {
    const t = setTimeout(() => qText !== (filters.q ?? '') && setFilter('q', qText), 350);
    return () => clearTimeout(t);
  });

  const q = useInfiniteQuery({
    queryKey: ['logs', filters],
    queryFn: ({ pageParam }) => fetchLogs(filters, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const n = useNames();
  const providers = useProviders();
  const gks = useGatewayKeys();

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage());
    io.observe(el);
    return () => io.disconnect();
  }, [q]);

  return (
    <>
      <PageHeader title="Request logs" subtitle="Every call through the gateway, newest first. Click a row for the routing details." actions={<Button icon={<RefreshCw className="size-4" />} loading={q.isRefetching && !q.isFetchingNextPage} onClick={() => q.refetch()}>Refresh</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-auto" value={filters.gatewayKeyId ?? ''} onChange={(e) => setFilter('gatewayKeyId', e.target.value)}>
          <option value="">All gateway keys</option>
          {gks.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </Select>
        <Select className="w-auto" value={filters.providerId ?? ''} onChange={(e) => setFilter('providerId', e.target.value)}>
          <option value="">All providers</option>
          {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select className="w-auto" value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Any status</option>
          <option value="ok">Success</option>
          <option value="error">Errors</option>
        </Select>
        <Input className="w-64" placeholder="Search model or error…" value={qText} onChange={(e) => setQText(e.target.value)} />
        {[...params.keys()].length > 0 && <Button variant="ghost" onClick={() => (setParams({}, { replace: true }), setQText(''))}>Clear filters</Button>}
      </div>
      <ErrorNote error={q.error} />
      <Card pad={false}>
        {q.isLoading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : !rows.length ? (
          <Empty icon={<ScrollText className="size-8" />} title="No requests yet">Requests appear here a second after they finish.</Empty>
        ) : (
          <div className={T.wrap}>
            <table className={T.table}>
              <thead>
                <tr>
                  <th className={T.th}>Time</th>
                  <th className={T.th}>Status</th>
                  <th className={T.th}>Gateway key</th>
                  <th className={T.th}>Model</th>
                  <th className={T.th}>Served by</th>
                  <th className={`${T.th} text-right`}>In</th>
                  <th className={`${T.th} text-right`}>Out</th>
                  <th className={`${T.th} text-right`}>Cached</th>
                  <th className={`${T.th} text-right`}>Cost</th>
                  <th className={`${T.th} text-right`}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className={`${T.row} cursor-pointer`} onClick={() => setOpen(l.id)}>
                    <td className={`${T.td} whitespace-nowrap text-muted`}>{new Date(l.ts).toLocaleTimeString()}<div className="text-[11px]">{new Date(l.ts).toLocaleDateString()}</div></td>
                    <td className={T.td}>
                      <Badge tone={l.status === 'ok' ? 'ok' : 'err'}>{l.httpStatus ?? '—'}</Badge>
                      {l.attempts > 1 && <Badge tone="warn" className="ml-1">{l.attempts} tries</Badge>}
                      {l.status === 'error' && <div className="mt-1 max-w-[200px] truncate text-xs text-err" title={l.errorMessage ?? ''}>{l.errorType}</div>}
                    </td>
                    <td className={T.td}>{n.gk(l.gatewayKeyId)}</td>
                    <td className={T.td}><Mono>{l.requestedModel ?? '—'}</Mono>{l.stream && <Badge className="ml-1">stream</Badge>}</td>
                    <td className={T.td}>
                      <div>{n.provider(l.providerId)}</div>
                      <div className="text-xs text-muted">{n.key(l.upstreamKeyId)}</div>
                    </td>
                    <td className={`${T.td} tabular text-right`}>{fmtNum(l.inputTokens)}</td>
                    <td className={`${T.td} tabular text-right`}>{fmtNum(l.outputTokens)}</td>
                    <td className={`${T.td} tabular text-right text-muted`}>{l.cachedReadTokens ? fmtNum(l.cachedReadTokens) : '—'}</td>
                    <td className={`${T.td} tabular text-right`}>{fmtUsd(l.costUsd)}{l.usageEstimated && <span className="text-muted" title="estimated">*</span>}</td>
                    <td className={`${T.td} tabular text-right`}>{fmtMs(l.latencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div ref={sentinel} className="grid h-14 place-items-center text-sm text-muted">
              {q.isFetchingNextPage ? <Spinner /> : q.hasNextPage ? 'Scroll for more' : `${rows.length} requests`}
            </div>
          </div>
        )}
      </Card>
      {open != null && <LogDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
