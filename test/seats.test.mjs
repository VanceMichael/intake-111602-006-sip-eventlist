import test from 'node:test';
import assert from 'node:assert/strict';
import { SeatTracker } from '../src/seats.mjs';
import { decode } from '../src/decode.mjs';
import { SeatCollector } from '../src/collector.mjs';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RLMI = 'application/rlmi+xml';
const PIDF = 'application/pidf+xml';

function presence(entity, basic) {
  return `<?xml version="1.0"?><presence xmlns="urn:ietf:params:xml:ns:pidf" entity="${entity}">`
    + `<tuple id="t1"><status><basic>${basic}</basic></status></tuple></presence>`;
}

function list(entries, { version, fullState, uri = 'sip:desks@local.invalid' }) {
  const resources = new Map();
  for (const entry of entries) {
    if (!resources.has(entry.resource)) resources.set(entry.resource, []);
    resources.get(entry.resource).push(entry);
  }
  let xml = `<list xmlns="urn:ietf:params:xml:ns:rlmi" uri="${uri}" version="${version}" `
    + `fullState="${fullState}">`;
  for (const [resource, instances] of resources) {
    xml += `<resource uri="${resource}">`;
    for (const instance of instances) {
      xml += `<instance id="${instance.id}" state="${instance.state}"`;
      if (instance.cid) xml += ` cid="${instance.cid}"`;
      xml += '/>';
    }
    xml += '</resource>';
  }
  return `${xml}</list>`;
}

function notify({ dialog = 'dlg-1', cseq = 1, version = 0, fullState = false, entries = [],
  parts = [], subscription = 'active;expires=120' } = {}) {
  const bodies = [
    { cid: 'list@cid', type: RLMI, text: list(entries, { version, fullState }) },
    ...parts
  ];
  const boundary = 'notice';
  const body = bodies.map(part => `--${boundary}\r\nContent-Type: ${part.type}\r\n`
    + `Content-ID: <${part.cid}>\r\n\r\n${part.text}\r\n`).join('') + `--${boundary}--\r\n`;
  const head = 'NOTIFY sip:collector@local.invalid SIP/2.0\r\n'
    + `Call-ID: ${dialog}\r\nCSeq: ${cseq} NOTIFY\r\nEvent: presence\r\n`
    + `Subscription-State: ${subscription}\r\n`
    + `Content-Type: multipart/related;boundary=${boundary};type="application/rlmi+xml"\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.from(head + body);
}

const desk = (overrides = {}) => ({ resource: 'sip:desk-a@local.invalid', id: 'i1',
  state: 'active', cid: 'desk-a@cid', ...overrides });
const deskPart = (basic = 'open', cid = 'desk-a@cid') => ({ cid, type: PIDF,
  text: presence('sip:desk-a@local.invalid', basic) });

function baseline(version = 0, dialog = 'dlg-1', cseq = 1, entries = [desk()], parts = [deskPart()]) {
  return notify({ dialog, cseq, version, fullState: true, entries, parts });
}

test('正文按 Content-ID 对应，不依赖 multipart 排列次序', () => {
  const bytes = notify({ version: 0, fullState: true,
    entries: [desk(), desk({ resource: 'sip:desk-b@local.invalid', id: 'i2', cid: 'desk-b@cid' })],
    parts: [deskPart('closed', 'desk-b@cid'), deskPart('open', 'desk-a@cid')] });
  const notification = decode(bytes);
  const byInstance = Object.fromEntries(notification.references.map(reference =>
    [reference.instance, reference.content.basic]));
  assert.deepEqual(byInstance, { i1: 'open', i2: 'closed' });
  assert.deepEqual(notification.parts.map(part => part.contentId),
    ['list@cid', 'desk-b@cid', 'desk-a@cid']);
  assert.equal(notification.orphans.length, 0);
});

test('完整名单可以给出可信的成员清单，接收与可信完整是两件事', () => {
  const tracker = new SeatTracker();
  assert.equal(tracker.snapshot().received, false);
  assert.equal(tracker.snapshot().complete, false);
  tracker.announce({ dialog: 'dlg-1', event: 'presence', expires: 120, notifications: [] });
  const result = tracker.receive(baseline());
  assert.equal(result.applied, true);
  assert.equal(result.complete, true);
  assert.equal(result.uncertain.length, 0);
  const status = tracker.snapshot();
  assert.equal(status.received, true);
  assert.equal(status.complete, true);
  assert.equal(status.version, 0);
  assert.equal(status.fullState, true);
  assert.equal(status.membershipTrusted, true);
  assert.deepEqual(status.resources[0].instances.map(item => item.available), [true]);
  assert.deepEqual(status.resources[0].instances[0].source,
    { dialog: 'dlg-1', generation: 1, version: 0, cseq: '1 NOTIFY' });
});

test('增量必须有完整基线，不能把收到的增量当作最新名单', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  const result = tracker.receive(notify({ cseq: 2, version: 4, fullState: false,
    entries: [desk()], parts: [deskPart()] }));
  assert.equal(result.outcome, 'awaiting-baseline');
  assert.equal(result.applied, false);
  assert.equal(result.received, true);
  assert.equal(result.complete, false);
  assert.equal(tracker.snapshot().received, true);
  assert.equal(tracker.snapshot().version, null);
  assert.equal(tracker.snapshot().awaitingBaselineVersion, 4);
});

test('漏版后不得继续把旧名单标成最新，缺的版本要能看见', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0));
  const result = tracker.receive(notify({ cseq: 4, version: 3, fullState: false,
    entries: [desk()], parts: [deskPart('closed')] }));
  assert.equal(result.applied, true);
  assert.equal(result.complete, false);
  const status = tracker.snapshot();
  assert.equal(status.version, 3);
  assert.equal(status.stale, true);
  assert.deepEqual(status.missingVersions, [1, 2]);
  assert.equal(status.membershipTrusted, false);
  assert.match(status.staleReason, /缺少版本 1、2/);
  assert.equal(status.resources[0].instances[0].available, false);
});

test('例外：晚到的同序旧版本不覆盖当前名单，重复报文也不重复应用', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  const first = baseline(0);
  tracker.receive(first);
  const increment = notify({ cseq: 2, version: 1, fullState: false,
    entries: [desk()], parts: [deskPart('closed')] });
  tracker.receive(increment);
  const duplicate = tracker.receive(increment);
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(duplicate.applied, false);
  const late = tracker.receive(notify({ cseq: 2, version: 1, fullState: false,
    entries: [desk()], parts: [deskPart('open')] }));
  assert.equal(late.outcome, 'out-of-order');
  assert.equal(late.applied, false);
  const conflict = tracker.receive(notify({ cseq: 3, version: 1, fullState: false,
    entries: [desk()], parts: [deskPart('open')] }));
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.applied, false);
  assert.equal(tracker.snapshot().version, 1);
  assert.equal(tracker.snapshot().resources[0].instances[0].available, false);
});

test('迟到旧订阅的通知不覆盖重建后的新名单', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0, 'dlg-1', 1));
  tracker.announce({ dialog: 'dlg-2', expires: 120 });
  const rebuilt = tracker.receive(baseline(0, 'dlg-2', 1));
  assert.equal(rebuilt.applied, true);
  assert.equal(tracker.snapshot().dialog, 'dlg-2');
  assert.equal(tracker.snapshot().generation, 2);
  const late = tracker.receive(notify({ dialog: 'dlg-1', cseq: 9, version: 9, fullState: true,
    entries: [desk()], parts: [deskPart('closed')] }));
  assert.equal(late.outcome, 'superseded');
  assert.equal(late.applied, false);
  assert.equal(late.received, true);
  const status = tracker.snapshot();
  assert.equal(status.dialog, 'dlg-2');
  assert.equal(status.version, 0);
  assert.equal(status.resources[0].instances[0].available, true);
  assert.equal(status.complete, true);
  assert.equal(tracker.dialogs().find(item => item.dialog === 'dlg-1').supersededBy, 'dlg-2');
});

test('未出现在当前订阅中的对话不会顶替当前名单', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0, 'dlg-1', 1));
  const stray = tracker.receive(baseline(0, 'dlg-9', 1));
  assert.equal(stray.outcome, 'superseded');
  assert.equal(tracker.snapshot().dialog, 'dlg-1');
  const unannounced = new SeatTracker();
  const first = unannounced.receive(baseline(0, 'dlg-3', 1));
  assert.equal(first.applied, true);
  assert.equal(unannounced.snapshot().dialog, 'dlg-3');
});

test('重建订阅从版本 0 的完整名单重新开始', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0, 'dlg-1', 1));
  tracker.receive(notify({ dialog: 'dlg-1', cseq: 4, version: 3, fullState: false,
    entries: [desk()], parts: [deskPart('closed')] }));
  assert.equal(tracker.snapshot().complete, false);
  tracker.announce({ dialog: 'dlg-2', expires: 120 });
  const rebuilt = tracker.receive(baseline(0, 'dlg-2', 1));
  assert.equal(rebuilt.complete, true);
  assert.equal(tracker.snapshot().stale, false);
  assert.deepEqual(tracker.snapshot().missingVersions, []);
});

test('单个实例终止不表示整个场馆离线，其他实例仍报告可接待', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0, 'dlg-1', 1, [
    desk({ resource: 'sip:desk-a@local.invalid', id: 'i1', cid: 'desk-a@cid' }),
    desk({ resource: 'sip:desk-b@local.invalid', id: 'i2', cid: 'desk-b@cid' })
  ], [deskPart('open', 'desk-a@cid'), deskPart('open', 'desk-b@cid')]));
  const result = tracker.receive(notify({ cseq: 2, version: 1, fullState: false,
    entries: [desk({ resource: 'sip:desk-b@local.invalid', id: 'i2', state: 'terminated', cid: null })],
    parts: [] }));
  assert.equal(result.applied, true);
  assert.equal(result.complete, true);
  const status = tracker.snapshot();
  const a = status.resources.find(resource => resource.uri === 'sip:desk-a@local.invalid');
  const b = status.resources.find(resource => resource.uri === 'sip:desk-b@local.invalid');
  assert.equal(a.availableInstances, 1);
  assert.deepEqual(b.instances, []);
  assert.deepEqual(status.uncertain, []);
});

test('正文缺失或无法对应时成员保持不确定，并阻止名单被标为可信', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  const result = tracker.receive(baseline(0, 'dlg-1', 1, [desk()], []));
  assert.equal(result.applied, true);
  assert.equal(result.complete, false);
  const status = tracker.snapshot();
  assert.equal(status.received, true);
  assert.equal(status.stale, false);
  assert.equal(status.complete, false);
  assert.equal(status.resources[0].instances[0].available, null);
  assert.deepEqual(status.uncertain.map(item => item.instance), ['i1']);
  assert.match(status.uncertain[0].reason, /正文缺失/);
  assert.equal(status.stale, false);
  assert.equal(status.incompleteReason, '完整名单中仍有成员无法对应状态');
});

test('同一场馆的多个实例分别计算可接待，终止整个资源才清空该资源', () => {
  const venue = 'sip:venue@local.invalid';
  const entries = [
    desk({ resource: venue, id: 'a', cid: 'a@cid' }),
    desk({ resource: venue, id: 'b', cid: 'b@cid' })
  ];
  const parts = [
    { cid: 'a@cid', type: PIDF, text: presence(venue, 'open') },
    { cid: 'b@cid', type: PIDF, text: presence(venue, 'closed') }
  ];
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0, 'dlg-1', 1, entries, parts));
  let status = tracker.snapshot();
  assert.equal(status.resources[0].activeInstances, 2);
  assert.equal(status.resources[0].availableInstances, 1);
  assert.equal(status.complete, true);
  tracker.receive(notify({ cseq: 2, version: 1, fullState: false,
    entries: [desk({ resource: venue, id: 'b', state: 'terminated', cid: null })], parts: [] }));
  status = tracker.snapshot();
  assert.equal(status.resources[0].activeInstances, 1);
  assert.equal(status.resources[0].availableInstances, 1);
  assert.equal(status.complete, true);
  tracker.receive(notify({ cseq: 3, version: 2, fullState: false,
    entries: [desk({ resource: venue, id: 'a', state: 'terminated', cid: null })], parts: [] }));
  status = tracker.snapshot();
  assert.deepEqual(status.resources[0].instances, []);
  assert.equal(status.complete, true);
});

test('正文实体与列表资源不一致时成员不确定，可接待不取自不可信正文', () => {
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  const wrong = { cid: 'desk-a@cid', type: PIDF, text: presence('sip:other@local.invalid', 'open') };
  const result = tracker.receive(baseline(0, 'dlg-1', 1, [desk()], [wrong]));
  assert.equal(result.complete, false);
  const instance = tracker.snapshot().resources[0].instances[0];
  assert.equal(instance.uncertain, true);
  assert.equal(instance.available, null);
  assert.match(instance.reason, /不一致/);
});

test('错序与无主正文分开记录', () => {
  const bytes = notify({ version: 0, fullState: true, entries: [desk()],
    parts: [deskPart(), deskPart('closed', 'stray@cid')] });
  const notification = decode(bytes);
  assert.deepEqual(notification.orphans.map(item => item.contentId), ['stray@cid']);
  const tracker = new SeatTracker();
  tracker.announce({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(baseline(0));
  const late = tracker.receive(notify({ cseq: 1, version: 1, fullState: false,
    entries: [desk()], parts: [deskPart()] }));
  assert.equal(late.outcome, 'out-of-order');
  assert.equal(tracker.snapshot().version, 0);
});

test('订阅过期后不再宣称名单有效', () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const tracker = new SeatTracker({ clock: () => now });
  tracker.announce({ dialog: 'dlg-1', expires: 10 });
  tracker.receive(notify({ version: 0, fullState: true, entries: [desk()],
    parts: [deskPart()], subscription: 'active;expires=10' }));
  assert.equal(tracker.snapshot().complete, true);
  assert.equal(tracker.snapshot().valid, true);
  now = new Date('2026-01-01T00:00:11.000Z');
  assert.equal(tracker.snapshot().complete, false);
  assert.equal(tracker.snapshot().valid, false);
  assert.equal(tracker.snapshot().received, true);
});

test('持续接收：缺口、重建对话和迟到报文在轮询中保持区分', async () => {
  const source = await startSource({ scenario: 'transition' });
  const collector = await SeatCollector.start({ source: source.base, waitMs: 5, settleMs: 100 });
  const settle = async predicate => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate(collector.snapshot())) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('等待接收状态超时');
  };
  try {
    await settle(status => status.version === 3);
    assert.equal(collector.snapshot().stale, true);
    assert.deepEqual(collector.snapshot().missingVersions, [1, 2]);
    assert.equal(collector.snapshot().dialog, 'dlg-1');
    await collector.client.control({ action: 'advance' });
    await settle(status => status.dialog === 'dlg-2' && status.complete === true);
    assert.equal(collector.snapshot().version, 0);
    assert.equal(collector.snapshot().complete, true);
    const late = await collector.ingest(notify({ dialog: 'dlg-1', cseq: 9, version: 9,
      fullState: true, entries: [desk()], parts: [deskPart('closed')] }));
    assert.equal(late.outcome, 'superseded');
    assert.equal(collector.snapshot().dialog, 'dlg-2');
    const events = collector.state().events.map(event => event.kind);
    assert.ok(events.includes('version-gap'));
    assert.ok(events.includes('notification-superseded'));
  } finally {
    await collector.close();
    await source.close();
  }
});

test('查看服务提供席位状态、事件与通知接收入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seats-app-'));
  const source = await startSource();
  const app = await startApplication({ source: source.base, root: directory,
    waitMs: 10, settleMs: 100 });
  try {
    const status = await fetch(`${app.base}/seats/status`).then(response => response.json());
    assert.equal(status.received, true);
    assert.equal(status.version, 3);
    assert.equal(status.complete, false);
    assert.equal(status.stale, true);
    assert.deepEqual(status.missingVersions, [1, 2]);
    const state = await fetch(`${app.base}/seats`).then(response => response.json());
    assert.equal(state.status.dialog, 'dlg-1');
    assert.equal(state.dialogs.length, 1);
    assert.ok(state.events.length > 0);
    const rejected = await fetch(`${app.base}/seats/notifications`, { method: 'POST',
      body: 'not-a-notify' });
    assert.equal(rejected.status, 422);
  } finally {
    await app.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
