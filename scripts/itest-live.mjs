/**
 * server-deck 文件传输 + PTY 桥(host 半区)联机自测:
 *   起一个独立回环 HTTP 服务挂 createApiRouter / createPtyRoute,对台账里的
 *   真实主机跑 列目录 → 上传 → 下载校验 → 建目录 → 递归删除 → 404 → WS 终端回显。
 * 只读 ~/.dsh/server-deck*.json(不写台账),测试文件跑完自清理。
 * 用法:pnpm exec node --experimental-transform-types scripts/itest-live.mjs
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const SRC = new URL('../src/', import.meta.url).href;
const { HostStore } = await import(`${SRC}/server/store.ts`);
const { HostPool } = await import(`${SRC}/server/pool.ts`);
const { createApiRouter } = await import(`${SRC}/server/router.ts`);
const { createPtyRoute } = await import(`${SRC}/server/pty.ts`);

const store = new HostStore();
await store.load();
const hosts = store.list();
if (hosts.length === 0) {
  console.log('台账为空,跳过联机自测');
  process.exit(0);
}
const host = hosts[0];
console.log(`目标主机: ${host.name} (${host.username}@host:${host.port}) id=${host.id}`);

const pool = new HostPool((id) => store.get(id), (id) => store.getSecret(id));
const recorderStub = { latestStatuses: () => [], tick: async () => [], arm() {}, forget() {} };
const metricsStub = {
  getSettings: () => ({ collectIntervalSec: 10, recording: true, pausedHostIds: [] }),
  saveSettings: async (s) => ({ ok: true, settings: s }),
  query: async () => [],
  removeHost: async () => {},
};
const handler = createApiRouter(store, pool, /** @type {any} */ (metricsStub), /** @type {any} */ (recorderStub));
const server = createServer((req, res) => {
  handler(req, res).catch((error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/server-deck/api`;

// 模拟 dsh-host-webserver 的 upgrade 分发:精确路径匹配,未命中直接断开
const ptyRoute = createPtyRoute(pool, (id) => store.get(id) !== undefined);
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  if (pathname !== ptyRoute.path) { socket.destroy(); return; }
  ptyRoute.handler(req, socket, head);
});

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

async function call(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { res, body };
}

try {
  // 1. 台账
  {
    const { res, body } = await call('/hosts');
    check('GET /hosts', res.ok && Array.isArray(body.hosts), `status=${res.status} hosts=${body.hosts?.length}`);
  }

  // 2. 列目录(path 空 = 登录目录)
  let home;
  {
    const { res, body } = await call(`/hosts/${host.id}/files?path=`);
    home = body.path;
    check('GET /files (登录目录)', res.ok && typeof home === 'string' && home.length > 0,
      `status=${res.status} path=${home} entries=${body.entries?.length}`);
    check('目录含 . 或 .. 过滤', !(body.entries ?? []).some((e) => e.name === '.' || e.name === '..'));
    check('目录条目含类型与大小', (body.entries ?? []).every((e) => typeof e.name === 'string' && typeof e.type === 'string' && typeof e.size === 'number'));
  }

  const remoteFile = `${home}/.sd-itest-upload.txt`;
  const payload = Buffer.from(`server-deck itest ${new Date().toISOString()}\n中文内容 ✓\n`, 'utf8');
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');

  // 3. 上传(原始字节流)
  {
    const { res, body } = await call(`/hosts/${host.id}/files/upload?path=${encodeURIComponent(remoteFile)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    check('POST /files/upload', res.ok && body.bytes === payload.length, `status=${res.status} bytes=${body.bytes}`);
  }

  // 4. 下载并逐字节比对
  {
    const res = await fetch(`${base}/hosts/${host.id}/files/content?path=${encodeURIComponent(remoteFile)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const disp = res.headers.get('content-disposition') ?? '';
    check('GET /files/content', res.ok && sha(buf) === sha(payload),
      `status=${res.status} bytes=${buf.length} sha=${sha(buf).slice(0, 12)}`);
    check('content-disposition 附件名', disp.includes('filename*=') && disp.includes('.sd-itest-upload.txt'), disp);
    check('content-length 正确', res.headers.get('content-length') === String(payload.length),
      String(res.headers.get('content-length')));
  }

  // 5. 中文文件名往返
  const cnFile = `${home}/中文文件-测试.txt`;
  {
    const up = await call(`/hosts/${host.id}/files/upload?path=${encodeURIComponent(cnFile)}`, {
      method: 'POST', body: '中文名 ✓',
    });
    const dl = await fetch(`${base}/hosts/${host.id}/files/content?path=${encodeURIComponent(cnFile)}`);
    const text = await dl.text();
    const disp = dl.headers.get('content-disposition') ?? '';
    const star = /filename\*=UTF-8''([^;]+)/.exec(disp);
    const decoded = star ? decodeURIComponent(star[1]) : '';
    check('中文文件名上传/下载/附件名', up.res.ok && dl.ok && text === '中文名 ✓' && decoded === '中文文件-测试.txt',
      `decoded=${decoded} text=${text}`);
    await call(`/hosts/${host.id}/files/rm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: cnFile }),
    });
  }

  // 6. 建目录 + 递归删除
  const dir = `${home}/.sd-itest-dir`;
  {
    const mk = await call(`/hosts/${host.id}/files/mkdir`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    check('POST /files/mkdir', mk.res.ok, `status=${mk.res.status}`);

    const mkAgain = await call(`/hosts/${host.id}/files/mkdir`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    check('重复建目录返回 409', mkAgain.res.status === 409, `status=${mkAgain.res.status}`);

    const inner = `${dir}/nested.txt`;
    await call(`/hosts/${host.id}/files/upload?path=${encodeURIComponent(inner)}`, { method: 'POST', body: 'x' });

    const nonEmpty = await call(`/hosts/${host.id}/files/rm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir, recursive: false }),
    });
    check('非空目录非递归删除返回 409', nonEmpty.res.status === 409, `status=${nonEmpty.res.status}`);

    const rm = await call(`/hosts/${host.id}/files/rm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir, recursive: true }),
    });
    check('递归删除目录', rm.res.ok && rm.body.removed === 2, `removed=${rm.body?.removed}`);

    const list = await call(`/hosts/${host.id}/files?path=${encodeURIComponent(home)}`);
    const names = (list.body.entries ?? []).map((e) => e.name);
    check('目录已清理', !names.includes('.sd-itest-dir'), names.slice(0, 8).join(','));
  }

  // 7. 404 与错误码
  {
    const miss = await fetch(`${base}/hosts/${host.id}/files/content?path=${encodeURIComponent(`${home}/definitely-missing-${Date.now()}.bin`)}`);
    check('不存在的文件返回 404', miss.status === 404, `status=${miss.status}`);
    const noHost = await call('/hosts/srv_not_exists/files?path=');
    check('不存在的主机返回 404', noHost.res.status === 404, `status=${noHost.res.status}`);
    const emptyPath = await call(`/hosts/${host.id}/files/content?path=`);
    check('空 path 返回 400', emptyPath.res.status === 400, `status=${emptyPath.res.status}`);
  }

  // 8. WS PTY 桥(卡片终端)
  {
    const { WebSocket } = await import('ws');
    const url = `ws://127.0.0.1:${port}/server-deck/ws/pty?host=${encodeURIComponent(host.id)}&cols=80&rows=24`;
    const ws = new WebSocket(url);
    let received = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PTY 超时,已收 ${received.length} 字节`)), 20_000);
      ws.on('open', () => { setTimeout(() => ws.send('echo SDH_ITEST_OK\n'), 400); });
      ws.on('message', (data) => {
        received += data.toString();
        if (received.includes('SDH_ITEST_OK')) { clearTimeout(timer); resolve(); }
      });
      ws.on('error', (error) => { clearTimeout(timer); reject(error); });
      ws.on('close', () => { clearTimeout(timer); reject(new Error(`PTY 提前关闭:${received.slice(0, 200)}`)); });
    }).catch((error) => { check('WS PTY 桥回显', false, String(error?.message ?? error)); });
    if (received.includes('SDH_ITEST_OK')) {
      check('WS PTY 桥回显', true, `收到 ${received.length} 字节`);
      ws.close();
    }

    // 未注册的升级路径:模拟 webserver「未命中即断开」
    const bogus = new WebSocket(`ws://127.0.0.1:${port}/server-deck/ws/nope?host=${host.id}`);
    const failedHandshake = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      bogus.on('error', () => { clearTimeout(timer); resolve(true); });
      bogus.on('open', () => { clearTimeout(timer); resolve(false); });
    });
    check('未注册升级路径被拒绝', failedHandshake);
  }

  // 9. 对话工具:server_deck_upload / server_deck_download
  {
    const { registerTransferTools } = await import(`${SRC}/server/transfer-tools.ts`);
    const tools = new Map();
    registerTransferTools(
      { tools: { register: (tool) => { tools.set(tool.name, tool); return tool; } } },
      store,
      pool,
    );
    check(
      '传输工具已注册',
      tools.has('server_deck_upload') && tools.has('server_deck_download'),
      [...tools.keys()].join(','),
    );

    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const tmp = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'sd-itest-'));
    try {
      const content = `tool transfer ✓\n${'x'.repeat(1000)}`;
      const localUp = pathMod.join(tmp, 'up.txt');
      await fsp.writeFile(localUp, content, 'utf8');
      const remoteToolPath = `${home}/.sd-itest-tool.txt`;

      const up = await tools.get('server_deck_upload')
        .execute({ host: host.id, local_path: localUp, remote_path: remoteToolPath });
      check('server_deck_upload', up.bytes === Buffer.byteLength(content), `bytes=${up.bytes}`);

      const localDown = pathMod.join(tmp, 'down.txt');
      const down = await tools.get('server_deck_download')
        .execute({ host: host.id, remote_path: remoteToolPath, local_path: localDown });
      const readBack = await fsp.readFile(localDown, 'utf8');
      check('server_deck_download', down.bytes > 0 && readBack === content, `bytes=${down.bytes}`);

      const miss = await tools.get('server_deck_download')
        .execute({ host: host.id, remote_path: `${home}/nope-${Date.now()}.bin`, local_path: pathMod.join(tmp, 'x.bin') })
        .then(() => null, (error) => error);
      check('下载不存在文件报错', miss instanceof Error, String(miss?.message ?? miss));

      await call(`/hosts/${host.id}/files/rm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: remoteToolPath }),
      });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  // 10. 清理上传的测试文件
  {
    const rm = await call(`/hosts/${host.id}/files/rm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: remoteFile }),
    });
    check('清理测试文件', rm.res.ok, `status=${rm.res.status}`);
  }
} finally {
  pool.closeAll();
  server.close();
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
