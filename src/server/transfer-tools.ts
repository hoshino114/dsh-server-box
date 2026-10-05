/**
 * 对话侧文件传输工具:本机 ⇄ 台账主机的 SFTP 上传 / 下载。
 *
 * 与 server_deck_exec 同一条池内 SSH 连接,只是另开 SFTP 通道;
 * 本机侧走 Node fs(工作区路径由调用方给出),远端路径同时兼容
 * POSIX 与 Windows OpenSSH。不经过卡片 xterm,也不暴露成浏览器 REST。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { HostEntry } from '../types.ts';
import type { HostPool } from './pool.ts';
import type { HostStore } from './store.ts';
import { realpathOf, statOf, withSftp } from './sftp.ts';
import { resolveHost, type HostPick } from './resolve-host.ts';

function toPick(h: HostEntry): HostPick {
  return { id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, tags: h.tags };
}

const HOST_PARAM = {
  type: 'string',
  required: true,
  description: 'Host id, display name, IP, user@host, or unique substring.',
} as const;

export function registerTransferTools(
  ctx: { tools: { register: (tool: unknown) => unknown } },
  store: HostStore,
  pool: HostPool,
): void {
  ctx.tools.register(
    defineTool({
      name: 'server_deck_upload',
      description:
        'Copy one local file to a Server Deck host over SFTP (local path → remote path). Creates missing parent directories on the local side only; remote parent must exist. Returns bytes written.',
      parameters: {
        host: HOST_PARAM,
        local_path: {
          type: 'string',
          required: true,
          description: 'Local file to send (absolute, or relative to the working directory).',
        },
        remote_path: {
          type: 'string',
          required: true,
          description: 'Destination path on the remote host, including the file name.',
        },
      },
      timeoutMs: 600_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hostId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            localPath: { type: 'string', required: true },
            remotePath: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `uploaded ${value.localPath} → ${value.name} (${value.remotePath}), ${String(value.bytes)} bytes`,
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const localPath = resolve(args.local_path.trim());
        const remotePath = args.remote_path.trim();
        if (remotePath.length === 0) throw new Error('remote_path 不能为空');
        const info = await stat(localPath).catch((error: unknown) => {
          throw new Error(`本地文件不可读 ${localPath}:${error instanceof Error ? error.message : String(error)}`);
        });
        if (info.isDirectory()) throw new Error(`${localPath} 是目录,请先打包成单个文件`);
        const resolved = resolveHost(store.list().map(toPick), args.host);
        if (!resolved.ok) throw new Error(resolved.error);
        await withSftp(pool, resolved.host.id, async (sftp) => {
          await pipeline(createReadStream(localPath), sftp.createWriteStream(remotePath, { flags: 'w' }));
        });
        return {
          hostId: resolved.host.id,
          name: resolved.host.name,
          localPath,
          remotePath,
          bytes: info.size,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'server_deck_download',
      description:
        'Copy one remote file from a Server Deck host over SFTP (remote path → local path). Missing local parent directories are created. Directories are refused — download files one by one.',
      parameters: {
        host: HOST_PARAM,
        remote_path: {
          type: 'string',
          required: true,
          description: 'Path of the file on the remote host.',
        },
        local_path: {
          type: 'string',
          required: true,
          description: 'Local destination file path (absolute, or relative to the working directory).',
        },
      },
      timeoutMs: 600_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hostId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            localPath: { type: 'string', required: true },
            remotePath: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `downloaded ${value.name} (${value.remotePath}) → ${value.localPath}, ${String(value.bytes)} bytes`,
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const remotePath = args.remote_path.trim();
        const localPath = resolve(args.local_path.trim());
        if (remotePath.length === 0) throw new Error('remote_path 不能为空');
        const resolved = resolveHost(store.list().map(toPick), args.host);
        if (!resolved.ok) throw new Error(resolved.error);
        await mkdir(dirname(localPath), { recursive: true });
        const bytes = await withSftp(pool, resolved.host.id, async (sftp) => {
          const abs = await realpathOf(sftp, remotePath);
          const info = await statOf(sftp, abs);
          if (info.type === 'dir') throw new Error(`${remotePath} 是目录,请逐个文件下载`);
          await pipeline(sftp.createReadStream(abs), createWriteStream(localPath));
          return info.size;
        });
        return {
          hostId: resolved.host.id,
          name: resolved.host.name,
          localPath,
          remotePath,
          bytes,
        };
      },
    }),
  );
}
