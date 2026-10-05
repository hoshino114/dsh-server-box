/**
 * 浏览器端 API 封装:/server-deck/api/*。
 */

import type {
  HostEntry,
  HostInput,
  HostMetricSeries,
  HostStatus,
  MetricBucket,
  MetricRangeKind,
  MetricsSettings,
} from '../types.ts';

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/server-deck/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export function listHosts(): Promise<{ hosts: HostEntry[] }> {
  return jfetch('/hosts');
}

export function createHost(input: HostInput): Promise<{ host: HostEntry }> {
  return jfetch('/hosts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateHost(id: string, input: HostInput): Promise<{ host: HostEntry }> {
  return jfetch(`/hosts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteHost(id: string): Promise<void> {
  return jfetch(`/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testHost(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return jfetch(`/hosts/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' });
}

/** 最新快照;force=true 让主机侧立即探测一轮(工具栏「刷新」)。 */
export function getStatuses(force = false): Promise<{ statuses: HostStatus[] }> {
  return jfetch(`/status${force ? '?force=1' : ''}`);
}

export interface MetricSeriesQuery {
  range: MetricRangeKind;
  bucket?: MetricBucket | 'auto';
  /** range='custom' 时必填(unix ms)。 */
  from?: number;
  to?: number;
}

export interface MetricSeriesResponse {
  ok: true;
  from: number;
  to: number;
  range: MetricRangeKind;
  bucket: MetricBucket | 'auto';
  bucketUsed: MetricBucket;
  allowedBuckets: MetricBucket[];
  series: HostMetricSeries[];
}

export function getMetricSeries(q: MetricSeriesQuery): Promise<MetricSeriesResponse> {
  const params = new URLSearchParams({ range: q.range, bucket: q.bucket ?? 'auto' });
  if (q.from !== undefined) params.set('from', String(q.from));
  if (q.to !== undefined) params.set('to', String(q.to));
  return jfetch(`/metrics?${params}`);
}

export function getMetricsSettings(): Promise<{ ok: true; settings: MetricsSettings }> {
  return jfetch('/metrics/settings');
}

export function patchMetricsSettings(patch: Partial<MetricsSettings>): Promise<{ ok: true; settings: MetricsSettings }> {
  return jfetch('/metrics/settings', { method: 'PATCH', body: JSON.stringify(patch) });
}

export function importSshConfig(dryRun = false): Promise<{
  found: number;
  importedCount: number;
  skipped: number;
}> {
  return jfetch('/import-ssh-config', { method: 'POST', body: JSON.stringify({ dryRun }) });
}

/**
 * Host 的 HTTP origin——WebSocket 必须显式给出绝对地址,不能靠 location 推。
 *
 * 桌面端页面跑在自定义协议 `dsh-app://app` 上(REST 由 Electron
 * `protocol.handle` 代理回 Host),`location.host` 是 `app`,拼出来的
 * `ws://app/...` 会直接连不上——这正是桌面端的 WebSocket 报错来源。
 * 桌面端在启动时把 Host 的回环 origin 写进 `__DSH_TRANSPORT__.streamBaseUrl`,
 * 且 Electron 只对 `ws://127.0.0.1:<port>/*` 改写 Origin/Cookie,所以这里
 * 必须用它;Web 端页面就是 Host 自己,退回 location。
 */
export function hostOrigin(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__;
  const base = transport?.streamBaseUrl;
  if (typeof base === 'string' && base.length > 0) {
    try { return new URL(base).origin; } catch { /* 落到 location 分支 */ }
  }
  if (typeof location !== 'undefined'
    && (location.protocol === 'http:' || location.protocol === 'https:')) {
    return location.origin;
  }
  throw new Error('无法确定 Host 地址(页面非 http(s) 且缺少 __DSH_TRANSPORT__.streamBaseUrl)');
}

/** 由 Host origin 派生同路径的 WebSocket 地址(http→ws、https→wss)。 */
export function wsUrlFrom(origin: string, pathWithQuery: string): string {
  const url = new URL(pathWithQuery, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** PTY WebSocket 地址(绝对地址,桌面端 / Web 端通用)。 */
export function ptyUrl(hostId: string, cols: number, rows: number): string {
  const q = new URLSearchParams({ host: hostId, cols: String(cols), rows: String(rows) });
  return wsUrlFrom(hostOrigin(), `/server-deck/ws/pty?${q}`);
}

// ---------- 文件传输(SFTP 桥) ----------

/** 远端目录项。 */
export interface RemoteFileEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** 远端 mtime(unix 秒)。 */
  mtime?: number;
  mode?: number;
}

export interface FileListResult {
  ok: true;
  /** 规范化后的绝对路径。 */
  path: string;
  /** 上级目录(根为 null)。 */
  parent: string | null;
  entries: RemoteFileEntry[];
}

/** 列目录;path 为空表示从登录目录(realpath '.')开始。 */
export function listFiles(hostId: string, path: string): Promise<FileListResult> {
  const q = new URLSearchParams({ path });
  return jfetch(`/hosts/${encodeURIComponent(hostId)}/files?${q}`);
}

export function makeDirectory(hostId: string, path: string): Promise<{ ok: true; path: string }> {
  return jfetch(`/hosts/${encodeURIComponent(hostId)}/files/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export function removeRemote(hostId: string, path: string, recursive: boolean): Promise<{ ok: true; removed: number }> {
  return jfetch(`/hosts/${encodeURIComponent(hostId)}/files/rm`, {
    method: 'POST',
    body: JSON.stringify({ path, recursive }),
  });
}

function errorFromBody(res: Response, body: unknown, fallback: string): Error {
  const msg = (body as { error?: string } | null)?.error;
  return new Error(msg !== undefined && msg.length > 0 ? msg : `${fallback} HTTP ${String(res.status)}`);
}

/** 下载远端文件为 Blob(桌面端经 Electron 代理,同源读取无 CORS 限制)。 */
export async function downloadRemoteFile(hostId: string, path: string): Promise<{ blob: Blob; filename: string }> {
  const q = new URLSearchParams({ path });
  const res = await fetch(`/server-deck/api/hosts/${encodeURIComponent(hostId)}/files/content?${q}`);
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    throw errorFromBody(res, body, '下载失败');
  }
  const blob = await res.blob();
  return { blob, filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? basename(path) };
}

/** 上传到远端(path 为目标完整路径)。 */
export async function uploadRemoteFile(hostId: string, path: string, data: Blob): Promise<{ ok: true; path: string; bytes: number }> {
  const q = new URLSearchParams({ path });
  const res = await fetch(`/server-deck/api/hosts/${encodeURIComponent(hostId)}/files/upload?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: data,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw errorFromBody(res, body, '上传失败');
  return { ...(body as { ok: true; path: string }), bytes: data.size };
}

function basename(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/** `attachment; filename="a.txt"; filename*=UTF-8''a.txt` → a.txt。 */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star !== null) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* 退化到 filename */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain !== null ? plain[1].trim() : null;
}

/** Blob 触发浏览器下载(桌面端同样走 Electron 的下载管线)。 */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export { type HostEntry, type HostInput, type HostStatus };
