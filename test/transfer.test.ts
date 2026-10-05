/**
 * 文件传输与 WebSocket 地址的纯逻辑测试:
 *   - sftp 路径拼接 / 上级目录(POSIX 与 Windows OpenSSH 两种分隔符)
 *   - 错误 → HTTP 状态映射
 *   - pty WebSocket 地址:桌面端(dsh-app:// + streamBaseUrl)与 Web 端同源
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { joinPath, parentPath, toSftpError, SftpError } from '../src/server/sftp.ts';
import { hostOrigin, wsUrlFrom, ptyUrl } from '../src/client/api.ts';

test('joinPath 兼容 POSIX 分隔符', () => {
  assert.equal(joinPath('/var/log', 'syslog'), '/var/log/syslog');
  assert.equal(joinPath('/var/log/', 'syslog'), '/var/log/syslog');
  assert.equal(joinPath('/', 'etc'), '/etc');
});

test('joinPath 兼容 Windows OpenSSH 分隔符', () => {
  assert.equal(joinPath('C:\\Users', 'a.txt'), 'C:\\Users\\a.txt');
  assert.equal(joinPath('C:\\Users\\', 'a.txt'), 'C:\\Users\\a.txt');
});

test('parentPath 返回上级,根返回 null', () => {
  assert.equal(parentPath('/var/log'), '/var');
  assert.equal(parentPath('/var/log/'), '/var');
  assert.equal(parentPath('/'), null);
  assert.equal(parentPath('C:\\Users\\me'), 'C:\\Users');
  assert.equal(parentPath('C:\\Users'), 'C:\\'); // 盘符根
  assert.equal(parentPath('relative'), null);
});

test('错误映射:不存在 404 / 无权限 403 / 已存在 409', () => {
  assert.equal(toSftpError(Object.assign(new Error('No such file'), { code: 2 })).status, 404);
  assert.equal(toSftpError(new Error('Permission denied')).status, 403);
  assert.equal(toSftpError(Object.assign(new Error('x'), { code: 11 })).status, 409);
  assert.equal(toSftpError(new Error('连接被重置')).status, 500);
  const keep = new SftpError('自定义', 418);
  assert.equal(toSftpError(keep).status, 418);
});

test('wsUrlFrom:http→ws、https→wss,路径与查询保留', () => {
  assert.equal(
    wsUrlFrom('http://127.0.0.1:19387', '/server-box/ws/pty?host=a'),
    'ws://127.0.0.1:19387/server-box/ws/pty?host=a',
  );
  assert.equal(
    wsUrlFrom('https://example.test:8443', '/server-box/ws/pty?host=a'),
    'wss://example.test:8443/server-box/ws/pty?host=a',
  );
});

test('桌面端 hostOrigin 取 __DSH_TRANSPORT__.streamBaseUrl', () => {
  const g = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } };
  const saved = g.__DSH_TRANSPORT__;
  try {
    g.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:19387' };
    assert.equal(hostOrigin(), 'http://127.0.0.1:19387');
    // 桌面端页面是 dsh-app://app,location.host 为 'app'——ptyUrl 必须落到回环 origin
    assert.equal(
      ptyUrl('srv_1', 80, 24),
      'ws://127.0.0.1:19387/server-box/ws/pty?host=srv_1&cols=80&rows=24',
    );
    g.__DSH_TRANSPORT__ = { streamBaseUrl: 'not-a-url' };
    assert.throws(() => hostOrigin(), /无法确定 Host 地址/);
  } finally {
    if (saved === undefined) delete g.__DSH_TRANSPORT__;
    else g.__DSH_TRANSPORT__ = saved;
  }
});

test('缺 streamBaseUrl 且页面非 http(s) 时抛出可读错误', () => {
  const g = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } };
  const saved = g.__DSH_TRANSPORT__;
  try {
    delete g.__DSH_TRANSPORT__;
    assert.throws(() => hostOrigin(), /无法确定 Host 地址/);
  } finally {
    if (saved !== undefined) g.__DSH_TRANSPORT__ = saved;
  }
});
