/**
 * SFTP 文件传输:台账主机的列目录 / 读写 / 建删,走池内长连接的独立 SFTP 通道。
 *
 * 与 REST(仅回环)一致,访问面只在 /server-deck/api 暴露;秘密仍来自
 * HostStore 的 secrets,不进台账也不回传。路径同时兼容 POSIX 与
 * Windows OpenSSH(反斜杠),由 realpath 结果判定分隔符。
 */

import type { SFTPWrapper } from 'ssh2';
import type { HostPool } from './pool.ts';

/** 远端目录项(与 client 的 RemoteFileEntry 同构)。 */
export interface RemoteEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** 远端 mtime(unix 秒)。 */
  mtime?: number;
  mode?: number;
}

/** 带 HTTP 状态的错误(router 的 catch 会读 `.status`)。 */
export class SftpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SftpError';
    this.status = status;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** ssh2 / Node 错误 → HTTP 状态(404 不存在、403 无权限、409 已存在)。 */
export function toSftpError(error: unknown): SftpError {
  if (error instanceof SftpError) return error;
  const code = (error as { code?: unknown }).code;
  const msg = messageOf(error);
  if (code === 2 || /no such file|not found|ENOENT/i.test(msg)) {
    return new SftpError(`路径不存在:${msg}`, 404);
  }
  if (code === 3 || /permission denied|EACCES|EPERM/i.test(msg)) {
    return new SftpError(`权限不足:${msg}`, 403);
  }
  if (code === 11 || /already exists/i.test(msg)) {
    return new SftpError(`目标已存在:${msg}`, 409);
  }
  return new SftpError(msg, 500);
}

function wrap<T>(run: (done: (error: unknown, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((error, value) => {
      if (error !== undefined && error !== null) reject(toSftpError(error));
      else resolve(value as T);
    });
  });
}

/**
 * 取(或建立)SFTP 通道执行操作,通道在 finally 里关闭——
 * 一条 SFTP 通道对应连接上一个 channel,泄漏会随传输次数累积。
 */
export async function withSftp<T>(pool: HostPool, hostId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await pool.sftp(hostId);
  try {
    return await fn(sftp);
  } finally {
    try { sftp.end(); } catch { /* 已关 */ }
  }
}

/** 路径分隔符:Windows OpenSSH 的 realpath 全是反斜杠。 */
function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

/** 拼接远端路径(兼容 POSIX / Windows)。 */
export function joinPath(dir: string, name: string): string {
  if (dir.length === 0) return name;
  const last = dir[dir.length - 1];
  if (last === '/' || last === '\\') return dir + name;
  return dir + sepOf(dir) + name;
}

/** 上级目录;已是根返回 null。 */
export function parentPath(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/u, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return null;
  if (idx === 0) return trimmed[0] === '\\' ? '\\' : '/';
  if (trimmed[idx - 1] === ':') return trimmed.slice(0, idx + 1); // C:\ → C:\
  const parent = trimmed.slice(0, idx);
  return parent.length === 0 ? trimmed[0] : parent;
}

/** 规范化目录(空 / '.' → 登录目录)。 */
export async function realpathOf(sftp: SFTPWrapper, path: string): Promise<string> {
  const target = path.trim().length === 0 ? '.' : path;
  try {
    return await wrap<string>((done) => { sftp.realpath(target, done); });
  } catch {
    return target; // 服务器不支持 realpath 时按原样用
  }
}

function typeOfMode(mode: number): RemoteEntry['type'] {
  const kind = mode & 0o170000;
  if (kind === 0o040000) return 'dir';
  if (kind === 0o120000) return 'link';
  if (kind === 0o100000) return 'file';
  return 'other';
}

export async function statOf(sftp: SFTPWrapper, path: string): Promise<RemoteEntry> {
  const attrs = await wrap<{ mode?: number; size?: number; mtime?: number }>((done) => { sftp.stat(path, done); });
  const mode = attrs.mode ?? 0;
  return {
    name: path,
    type: typeOfMode(mode),
    size: Number(attrs.size ?? 0),
    ...(attrs.mtime === undefined ? {} : { mtime: attrs.mtime }),
    mode,
  };
}

export async function statOrNull(sftp: SFTPWrapper, path: string): Promise<RemoteEntry | null> {
  try {
    return await statOf(sftp, path);
  } catch (error) {
    const sftpError = toSftpError(error);
    if (sftpError.status === 404) return null;
    throw sftpError;
  }
}

/** 列目录:返回规范化绝对路径、上级目录与排序后的条目(目录优先)。 */
export async function listRemote(
  sftp: SFTPWrapper,
  path: string,
): Promise<{ path: string; parent: string | null; entries: RemoteEntry[] }> {
  const abs = await realpathOf(sftp, path);
  const raw = await wrap<{ filename: string; attrs: { mode?: number; size?: number; mtime?: number } }[]>(
    (done) => { sftp.readdir(abs, done); },
  );
  const entries: RemoteEntry[] = [];
  for (const item of raw) {
    if (item.filename === '.' || item.filename === '..') continue;
    const mode = item.attrs.mode ?? 0;
    entries.push({
      name: item.filename,
      type: typeOfMode(mode),
      size: Number(item.attrs.size ?? 0),
      ...(item.attrs.mtime === undefined ? {} : { mtime: item.attrs.mtime }),
      mode,
    });
  }
  const order: Record<RemoteEntry['type'], number> = { dir: 0, link: 1, file: 2, other: 3 };
  entries.sort((a, b) => (order[a.type] - order[b.type]) || a.name.localeCompare(b.name));
  return { path: abs, parent: parentPath(abs), entries };
}

/** 建目录(不递归)。 */
export async function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<string> {
  const target = path.trim();
  if (target.length === 0) throw new SftpError('目录路径不能为空', 400);
  try {
    await wrap<void>((done) => { sftp.mkdir(target, done); });
  } catch (error) {
    const sftpError = toSftpError(error);
    if (sftpError.status === 409) throw new SftpError(`目录已存在:${target}`, 409);
    // OpenSSH 对已存在目录回 SSH_FX_FAILURE(4) 而不是 11——stat 复核再定状态
    try {
      const existing = await statOrNull(sftp, target);
      if (existing !== null && existing.type === 'dir') throw new SftpError(`目录已存在:${target}`, 409);
    } catch (statError) {
      if (statError instanceof SftpError && statError.status === 409) throw statError;
      // stat 失败就沿用 mkdir 的原始错误
    }
    throw sftpError;
  }
  return target;
}

/** 删除文件或目录;recursive=false 且目录非空时返回 409,由调用方提示。 */
export async function removeRemote(sftp: SFTPWrapper, path: string, recursive: boolean): Promise<number> {
  const target = path.trim();
  if (target.length === 0) throw new SftpError('删除路径不能为空', 400);
  const info = await statOrNull(sftp, target);
  if (info === null) throw new SftpError(`路径不存在:${target}`, 404);
  if (info.type !== 'dir') {
    await wrap<void>((done) => { sftp.unlink(target, done); });
    return 1;
  }
  const children = await wrap<{ filename: string }[]>((done) => { sftp.readdir(target, done); });
  const rest = children.filter((c) => c.filename !== '.' && c.filename !== '..');
  if (rest.length > 0 && !recursive) {
    throw new SftpError(`目录非空(含 ${String(rest.length)} 项),需要 recursive 才能删除`, 409);
  }
  let removed = 0;
  for (const child of rest) {
    removed += await removeRemote(sftp, joinPath(target, child.filename), true);
  }
  await wrap<void>((done) => { sftp.rmdir(target, done); });
  return removed + 1;
}
