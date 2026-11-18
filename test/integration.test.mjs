import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

async function withApplication(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eventlist-test-'));
  const source = await startSource({ scenario: 'transition' });
  const app = await startApplication({ source: source.base, root: directory });
  try { await fn({ app, source, directory }); }
  finally { await app.close(); await source.close(); await rm(directory, { recursive: true, force: true }); }
}

async function pull(app, path) {
  const response = await fetch(`${app.base}/notifications`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('通过本地来源持续接收：完整名单、缺口、重建对话与迟到通知', async () => {
  await withApplication(async ({ app, source }) => {
    const subscription = await fetch(`${app.base}/subscription`, { method: 'POST' }).then(r => r.json());
    assert.equal(subscription.subscription.dialog, 'dlg-1');
    assert.deepEqual(subscription.notifications, ['/notify/1', '/notify/gap']);

    const first = await pull(app, '/notify/1');
    assert.equal(first.record.status, 'applied');
    assert.equal(first.state.trust.rosterComplete, true);
    assert.equal(first.state.list.version, 0);
    assert.equal(first.state.members[0].basic, 'open');
    assert.equal(first.state.members[0].contentId, 'desk-a@cid');

    // 增量跳过版本 1、2：旧名单保留，但标记过期且成员不能确定。
    const gap = await pull(app, '/notify/gap');
    assert.equal(gap.record.status, 'not-applied');
    assert.equal(gap.record.reason, 'version-gap');
    assert.equal(gap.state.trust.rosterComplete, false);
    assert.equal(gap.state.trust.listStatus, 'stale-after-gap');
    assert.equal(gap.state.list.version, 0);
    assert.equal(gap.state.members[0].basic, 'open');
    assert.equal(gap.state.members[0].uncertainty, 'version-gap');

    // 推进来源并重建订阅：对话换成 dlg-2，重新从完整版 0 开始。
    await fetch(`${source.base}/control`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'advance' }) });
    const rebuiltSubscription = await fetch(`${app.base}/subscription`, { method: 'POST' }).then(r => r.json());
    assert.equal(rebuiltSubscription.subscription.dialog, 'dlg-2');

    const rebuilt = await pull(app, '/notify/rebuilt');
    assert.equal(rebuilt.record.status, 'applied');
    assert.equal(rebuilt.state.trust.rosterComplete, true);
    assert.equal(rebuilt.state.list.dialog, 'dlg-2');
    assert.equal(rebuilt.state.list.version, 0);
    assert.equal(rebuilt.state.members[0].basic, 'open');

    // 旧对话的通知晚到，版本和 CSeq 看起来都更大，也不能覆盖新名单。
    const late = await pull(app, '/notify/1');
    assert.equal(late.record.status, 'rejected');
    assert.equal(late.record.reason, 'stale-dialog');
    assert.equal(late.state.list.dialog, 'dlg-2');
    assert.equal(late.state.list.version, 0);
    assert.equal(late.state.members[0].basic, 'open');
    assert.equal(late.state.trust.rosterComplete, true);

    // 每个成员和列表都带出所属的订阅轮次。
    assert.equal(late.state.list.generation, rebuiltSubscription.subscription.generation);
    assert.equal(late.state.members[0].generation, rebuiltSubscription.subscription.generation);
  });
});

test('状态查询区分已收到报文与可信完整名单', async () => {
  await withApplication(async ({ app }) => {
    await fetch(`${app.base}/subscription`, { method: 'POST' });
    await pull(app, '/notify/1');
    await pull(app, '/notify/gap');
    const state = await fetch(`${app.base}/state`).then(r => r.json());
    assert.equal(state.receivedNoticeCount, 2);
    assert.equal(state.appliedNoticeCount, 1);
    assert.equal(state.trust.rosterComplete, false);
    assert.equal(state.trust.gap.received, 3);
    assert.equal(state.uncertain.length, 1);
    assert.equal(state.summary.includes('缺口'), true);
  });
});
