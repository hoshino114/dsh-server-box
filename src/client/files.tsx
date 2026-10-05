/**
 * 文件传输视图:远端目录浏览 + 上传 / 下载 / 建目录 / 删除。
 *
 * 走 /server-box/api/hosts/<id>/files*(SFTP 桥),桌面端经 Electron 代理,
 * Web 端同源直连;下载用 fetch→Blob→a[download],上传把 File 直接当请求体。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes } from '../metrics.ts';
import * as api from './api.ts';
import type { RemoteFileEntry } from './api.ts';

export interface FilesPaneProps {
  hostId: string;
  /** 展示名(父级工具栏标题;这里仅作提示属性)。 */
  name: string;
  /** user@host:port(页脚副标签)。 */
  endpoint: string;
  /** 切到终端视图(可选)。 */
  onTerminal?: () => void;
}

/** 与 host 侧 sftp.joinPath 同款:按当前目录的分隔符拼接。 */
function joinRemote(dir: string, name: string): string {
  if (dir.length === 0) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const last = dir[dir.length - 1];
  return last === '/' || last === '\\' ? dir + name : dir + sep + name;
}

function typeIcon(t: RemoteFileEntry['type']): string {
  switch (t) {
    case 'dir': return '📁';
    case 'link': return '🔗';
    case 'file': return '📄';
    default: return '📦';
  }
}

function fmtTime(t: number | undefined): string {
  if (t === undefined || !Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function FilesPane(props: FilesPaneProps): React.ReactNode {
  const [cwd, setCwd] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (path: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listFiles(props.hostId, path);
      if (!aliveRef.current) return;
      setCwd(r.path);
      setParent(r.parent);
      setEntries(r.entries);
      setPathInput(r.path);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [props.hostId]);

  useEffect(() => { void load(''); }, [load]);

  /** 操作(上传/删除/建目录)后重列当前目录。 */
  const reload = useCallback(async (): Promise<void> => { await load(cwd); }, [load, cwd]);

  const goUp = useCallback((): void => {
    if (parent !== null) void load(parent);
  }, [parent, load]);

  const openEntry = useCallback((entry: RemoteFileEntry): void => {
    if (entry.type === 'dir' || entry.type === 'link') void load(joinRemote(cwd, entry.name));
  }, [cwd, load]);

  const download = useCallback(async (entry: RemoteFileEntry): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const target = joinRemote(cwd, entry.name);
      const { blob, filename } = await api.downloadRemoteFile(props.hostId, target);
      api.saveBlob(filename, blob);
      setInfo(`已下载 ${filename}(${formatBytes(blob.size)})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [cwd, props.hostId]);

  const upload = useCallback(async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const target = joinRemote(cwd, file.name);
      await api.uploadRemoteFile(props.hostId, target, file);
      setInfo(`已上传 ${file.name}(${formatBytes(file.size)})`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [cwd, props.hostId, reload]);

  const mkdir = useCallback(async (): Promise<void> => {
    const name = globalThis.prompt('新文件夹名称');
    if (name === null || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.makeDirectory(props.hostId, joinRemote(cwd, name.trim()));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [cwd, props.hostId, reload]);

  const remove = useCallback(async (entry: RemoteFileEntry, recursive = false): Promise<void> => {
    const target = joinRemote(cwd, entry.name);
    const hint = entry.type === 'dir' ? `目录「${entry.name}」及其全部内容` : `文件「${entry.name}」`;
    if (!globalThis.confirm(`确定删除${hint}?(远端不可恢复)`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.removeRemote(props.hostId, target, recursive);
      setInfo(`已删除 ${String(r.removed)} 项`);
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 目录非空(host 返回 409):再问一次是否递归删除
      if (/recursive/.test(msg) && globalThis.confirm(`「${entry.name}」不是空目录,递归删除全部内容?`)) {
        try {
          const r = await api.removeRemote(props.hostId, target, true);
          setInfo(`已删除 ${String(r.removed)} 项`);
          await reload();
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }, [cwd, props.hostId, reload]);

  const goto = useCallback((): void => {
    const target = pathInput.trim();
    if (target.length > 0) void load(target);
  }, [pathInput, load]);

  return (
    <div className="sd-files" title={`${props.name} · ${props.endpoint}`}>
      {/* 行1:路径导航(返回/标题由父级工具栏承担,这里不再重复) */}
      <div className="sd-files-path">
        <button
          className="sd-btn"
          disabled={parent === null || loading}
          onClick={goUp}
          title={parent ?? '已在根目录'}
        >
          ↑ 上级
        </button>
        <input
          value={pathInput}
          placeholder="远端路径,如 /var/log 或 C:\Users"
          title={cwd}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') goto(); }}
        />
        <button className="sd-btn" disabled={loading || pathInput.trim().length === 0} onClick={goto}>转到</button>
        <button className="sd-btn" disabled={loading} onClick={() => void load(cwd)} title="刷新当前目录">⟳</button>
      </div>

      {/* 行2:动作(主操作靠左,终端入口靠右) */}
      <div className="sd-files-bar">
        <button className="sd-btn" disabled={busy || loading} onClick={() => void mkdir()} title="在当前目录新建文件夹">
          📂 新建目录
        </button>
        <button
          className="sd-btn primary"
          disabled={busy || loading}
          onClick={() => fileRef.current?.click()}
          title="上传到当前目录"
        >
          {busy ? <><i className="sd-spin" /> 处理中</> : '⬆ 上传'}
        </button>
        <input
          ref={fileRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file !== undefined) void upload(file);
          }}
        />
        <span className="sd-flex-gap" />
        {props.onTerminal !== undefined ? (
          <button className="sd-btn" onClick={props.onTerminal} title="打开交互终端">⌨ 终端</button>
        ) : null}
      </div>

      {error !== null ? <div style={{ padding: '6px 10px 0' }}><div className="sd-msg err">{error}</div></div> : null}
      {error === null && info !== null ? <div style={{ padding: '6px 10px 0' }}><div className="sd-msg ok">{info}</div></div> : null}

      <div className="sd-filelist">
        {loading && entries.length === 0 ? (
          <div className="sd-empty"><i className="sd-spin" /> 读取远端目录…</div>
        ) : entries.length === 0 ? (
          error === null ? <div className="sd-empty">空目录</div> : null
        ) : (
          <table className="sd-ftable">
            <thead>
              <tr><th>名称</th><th className="num">大小</th><th>修改时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td className="sd-fname">
                    <button
                      className="sd-link"
                      title={entry.type === 'file' ? `下载 ${entry.name}` : `打开 ${entry.name}`}
                      onClick={() => (entry.type === 'file' ? void download(entry) : openEntry(entry))}
                    >
                      {typeIcon(entry.type)} {entry.name}
                    </button>
                  </td>
                  <td className="num">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</td>
                  <td className="num dim">{fmtTime(entry.mtime)}</td>
                  <td className="sd-fops">
                    {entry.type === 'file' ? (
                      <button className="sd-btn" disabled={busy} onClick={() => void download(entry)} title="下载">⬇</button>
                    ) : null}
                    <button
                      className="sd-btn danger"
                      disabled={busy}
                      onClick={() => void remove(entry)}
                      title={entry.type === 'dir' ? '删除目录' : '删除文件'}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="sd-files-foot">
        <span className="sd-count">{loading ? <><i className="sd-spin" /> 读取中</> : `${String(entries.length)} 项`}</span>
        <span className="sd-line" title={`${props.name} · ${props.endpoint}`}>{props.endpoint}</span>
      </div>
    </div>
  );
}
