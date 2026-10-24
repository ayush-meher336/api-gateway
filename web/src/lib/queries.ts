import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, qs } from './api';
import type {
  Alert, Alias, GatewayKey, GroupBy, LogDetail, LogRow, Metric, Model, Provider, Settings, Summary, Timeseries, TopRow, UpstreamKey,
} from './types';

export interface Range {
  from: number;
  to: number;
}
export type DimFilter = Partial<Record<'gatewayKeyId' | 'upstreamKeyId' | 'providerId' | 'modelId', number>>;

const LIVE = { refetchInterval: 15_000 };

export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('providers'), ...LIVE });
export const useUpstreamKeys = (providerId?: number) =>
  useQuery({ queryKey: ['upstream-keys', providerId ?? 'all'], queryFn: () => api<UpstreamKey[]>(`upstream-keys${qs({ providerId })}`), ...LIVE });
export const useModels = (providerId?: number) =>
  useQuery({ queryKey: ['models', providerId ?? 'all'], queryFn: () => api<Model[]>(`models${qs({ providerId })}`) });
export const useAliases = () => useQuery({ queryKey: ['aliases'], queryFn: () => api<Alias[]>('aliases') });
export const useGatewayKeys = () => useQuery({ queryKey: ['gateway-keys'], queryFn: () => api<GatewayKey[]>('gateway-keys'), ...LIVE });
export const useGatewayKey = (id: number) => useQuery({ queryKey: ['gateway-keys', id], queryFn: () => api<GatewayKey>(`gateway-keys/${id}`), ...LIVE });
export const useAlerts = () => useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('alerts'), ...LIVE });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('settings') });

export const useSummary = (r: Range, f: DimFilter = {}) =>
  useQuery({ queryKey: ['summary', r, f], queryFn: () => api<Summary>(`analytics/summary${qs({ ...r, ...f })}`), ...LIVE, placeholderData: (p) => p });
export const useTimeseries = (r: Range, metric: Metric, groupBy: GroupBy, f: DimFilter = {}) =>
  useQuery({
    queryKey: ['timeseries', r, metric, groupBy, f],
    queryFn: () => api<Timeseries>(`analytics/timeseries${qs({ ...r, metric, groupBy, ...f })}`),
    ...LIVE,
    placeholderData: (p) => p,
  });
export const useTop = (r: Range, dimension: Exclude<GroupBy, 'none'>, metric: Metric, limit = 5) =>
  useQuery({ queryKey: ['top', r, dimension, metric, limit], queryFn: () => api<TopRow[]>(`analytics/top${qs({ ...r, dimension, metric, limit })}`), ...LIVE });

export interface LogFilters {
  from?: number;
  to?: number;
  gatewayKeyId?: number;
  providerId?: number;
  modelId?: number;
  upstreamKeyId?: number;
  status?: 'ok' | 'error';
  q?: string;
}
export const fetchLogs = (f: LogFilters, cursor?: number) => api<{ items: LogRow[]; nextCursor: number | null }>(`logs${qs({ ...f, cursor, limit: 50 })}`);
export const useLog = (id: number | null) => useQuery({ queryKey: ['log', id], queryFn: () => api<LogDetail>(`logs/${id}`), enabled: id != null });

/** A mutation that invalidates the given query keys on success. */
export function useMut<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of invalidate) qc.invalidateQueries({ queryKey: k });
      qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

export const CONFIG_KEYS: QueryKey[] = [['providers'], ['upstream-keys'], ['models'], ['aliases'], ['gateway-keys']];
