import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyForContentId, parseNotification, parseRlmi } from '../src/eventlist.mjs';
import { ListTracker, summarize } from '../src/listtracker.mjs';

const BOUNDARY = 'notice';

function message({ dialog = 'dlg-1', cseq = 1, subscription = 'active;expires=120', body }) {
  const bytes = Buffer.from(body, 'utf8');
  return Buffer.from([
    `NOTIFY sip:collector@local.invalid SIP/2.0`,
    `Call-ID: ${dialog}`,
    `CSeq: ${cseq} NOTIFY`,
    `Event: presence`,
    `Subscription-State: ${subscription}`,
    `Content-Type: multipart/related;boundary=${BOUNDARY};type="application/rlmi+xml"`,
    `Content-Length: ${bytes.length}`,
    '',
    body,
  ].join('\r\n'), 'utf8');
}

function part(contentId, contentType, payload) {
  return `--${BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-ID: <${contentId}>\r\n\r\n${payload}\r\n`;
}

function rlmi({ uri = 'sip:desks@local.invalid', version = 0, full = true, resources }) {
  const body = Object.entries(resources).map(([resourceUri, instances]) => {
    const entries = instances.map(instance =>
      `<instance id="${instance.id}" state="${instance.state ?? 'active'}"` +
      `${instance.cid === undefined ? '' : ` cid="${instance.cid}"`}/>`).join('');
    return `<resource uri="${resourceUri}">${entries}</resource>`;
  }).join('');
  return `<list xmlns="urn:ietf:params:xml:ns:rlmi" uri="${uri}" version="${version}"` +
    ` fullState="${full}">${body}</list>`;
}

function pidf(entity, basic) {
  return `<?xml version="1.0"?><presence xmlns="urn:ietf:params:xml:ns:pidf" entity="${entity}">` +
    `<tuple id="t1"><status><basic>${basic}</basic></status></tuple></presence>`;
}

function notice({ dialog, cseq, subscription, list, bodies }) {
  const sections = [part('list@cid', 'application/rlmi+xml', list)];
  for (const [contentId, { entity, basic }] of Object.entries(bodies)) {
    sections.push(part(contentId, 'application/pidf+xml', pidf(entity, basic)));
  }
  sections.push(`--${BOUNDARY}--\r\n`);
  return message({ dialog, cseq, subscription, body: sections.join('') });
}

const DESK_A = 'sip:desk-a@local.invalid';
const DESK_B = 'sip:desk-b@local.invalid';

test('列表正文按 Content-ID 回填，不依赖 multipart 排列次序', () => {
  const list = rlmi({ version: 0, resources: {
    [DESK_A]: [{ id: 'i1', cid: 'a@cid' }],
    [DESK_B]: [{ id: 'i1', cid: 'b@cid' }],
  } });
  // 正文顺序与列表实例顺序相反。
  const body = [
    part('list@cid', 'application/rlmi+xml', list),
    part('b@cid', 'application/pidf+xml', pidf(DESK_B, 'closed')),
    part('a@cid', 'application/pidf+xml', pidf(DESK_A, 'open')),
    `--${BOUNDARY}--\r\n`,
  ].join('');
  const parsed = parseNotification(message({ body }));
  assert.equal(parsed.lists[0].resources[0].instances[0].contentId, 'a@cid');
  assert.equal(bodyForContentId(parsed, 'a@cid').body.basic, 'open');
  assert.equal(bodyForContentId(parsed, 'b@cid').body.basic, 'closed');
  assert.equal(parsed.parts[1].contentId, 'b@cid');
});

test('缺少正文或 Content-ID 的实例标为不能确定，而不是沿用次序配对', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  const record = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ resources: {
      [DESK_A]: [{ id: 'i1', cid: 'missing@cid' }],
      [DESK_B]: [{ id: 'i1' }],
    } }),
    bodies: {},
  }), { source: 'local:1' });
  assert.equal(record.status, 'applied');
  const state = summarize(tracker);
  assert.deepEqual(state.uncertain.map(item => [item.resourceUri, item.instanceId, item.reason]), [
    [DESK_A, 'i1', 'missing-body'],
    [DESK_B, 'i1', 'missing-content-id'],
  ]);
  assert.equal(state.trust.rosterComplete, true);
});

test('重复 Content-ID 不随便挑一份正文', () => {
  const list = rlmi({ resources: { [DESK_A]: [{ id: 'i1', cid: 'dup@cid' }] } });
  const body = [
    part('list@cid', 'application/rlmi+xml', list),
    part('dup@cid', 'application/pidf+xml', pidf(DESK_A, 'open')),
    part('dup@cid', 'application/pidf+xml', pidf(DESK_B, 'closed')),
    `--${BOUNDARY}--\r\n`,
  ].join('');
  const parsed = parseNotification(message({ body }));
  assert.equal(bodyForContentId(parsed, 'dup@cid').issue, 'ambiguous-content-id');
});

test('完整状态与增量状态含义不同，增量不能让旧名单变成最新', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, full: true, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  const first = summarize(tracker);
  assert.equal(first.trust.rosterComplete, true);
  assert.equal(first.list.version, 0);

  const incremental = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 2,
    list: rlmi({ version: 1, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(incremental.status, 'applied');
  const second = summarize(tracker);
  // 版本连续且已有完整基线，增量可以更新成员。
  assert.equal(second.list.version, 1);
  assert.equal(second.members[0].basic, 'closed');
  assert.equal(second.trust.rosterComplete, true);
  assert.equal(second.receivedNoticeCount, 2);
});

test('第一份通知就是增量时不能当作可信名单', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  const record = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 3, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  assert.equal(record.status, 'not-applied');
  assert.equal(record.reason, 'missing-full-state');
  assert.equal(summarize(tracker).trust.rosterComplete, false);
});

test('漏掉一版后旧列表标为过期，后续增量不能恢复最新', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  const gap = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 4,
    list: rlmi({ version: 3, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(gap.status, 'not-applied');
  assert.equal(gap.reason, 'version-gap');
  const afterGap = summarize(tracker);
  assert.equal(afterGap.trust.rosterComplete, false);
  assert.equal(afterGap.trust.listStatus, 'stale-after-gap');
  assert.equal(afterGap.list.version, 0, '旧名单版本保留');
  assert.equal(afterGap.members[0].basic, 'open', '旧值保留');
  assert.equal(afterGap.members[0].uncertainty, 'version-gap');

  const later = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 5,
    list: rlmi({ version: 4, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(later.status, 'not-applied');
  assert.equal(later.reason, 'untrusted-list');
  assert.equal(summarize(tracker).trust.rosterComplete, false);
});

test('缺口后的完整名单可以重建可信状态', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 4,
    list: rlmi({ version: 3, full: false, resources: {} }),
    bodies: {},
  }));
  const rebuilt = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 6,
    list: rlmi({ version: 5, full: true, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(rebuilt.status, 'applied');
  const state = summarize(tracker);
  assert.equal(state.trust.rosterComplete, true);
  assert.equal(state.trust.gap, null);
  assert.equal(state.list.version, 5);
  assert.equal(state.members[0].basic, 'closed');
});

test('某个实例终止不代表整个场馆离线', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: {
      [DESK_A]: [{ id: 'i1', cid: 'a@cid' }],
      [DESK_B]: [{ id: 'i1', cid: 'b@cid' }],
    } }),
    bodies: {
      'a@cid': { entity: DESK_A, basic: 'open' },
      'b@cid': { entity: DESK_B, basic: 'open' },
    },
  }));
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 2,
    list: rlmi({ version: 1, full: false, resources: {
      [DESK_A]: [{ id: 'i1', state: 'terminated' }],
    } }),
    bodies: {},
  }));
  const state = summarize(tracker);
  const byUri = Object.fromEntries(state.members.map(member => [member.resourceUri, member]));
  assert.equal(byUri[DESK_A].terminated, true);
  assert.equal(byUri[DESK_A].available, false);
  assert.equal(byUri[DESK_B].available, true, '其他实例继续可接待');
  assert.equal(state.trust.rosterComplete, true);
});

test('订阅重建换对话后，旧对话的迟到通知不覆盖新名单', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));

  tracker.resubscribe({ dialog: 'dlg-2' });
  tracker.receive(notice({
    dialog: 'dlg-2', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  const current = summarize(tracker);
  assert.equal(current.list.dialog, 'dlg-2');
  assert.equal(current.members[0].basic, 'closed');

  // 旧对话稍后到达，版本和 CSeq 看起来都“更新”，仍须拒绝。
  const late = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 9,
    list: rlmi({ version: 8, full: true, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  assert.equal(late.status, 'rejected');
  assert.equal(late.reason, 'stale-dialog');
  const after = summarize(tracker);
  assert.equal(after.list.dialog, 'dlg-2');
  assert.equal(after.list.version, 0);
  assert.equal(after.members[0].basic, 'closed');
  assert.equal(after.rejectedNoticeCount, 1);
});

test('同一对话内 CSeq 回退或重复不推进状态', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 5,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  const replay = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 5,
    list: rlmi({ version: 1, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(replay.reason, 'stale-cseq');
  assert.equal(summarize(tracker).members[0].basic, 'open');
});

test('每个成员记录来自哪一轮有效订阅', () => {
  const tracker = new ListTracker();
  const subscription = tracker.resubscribe({ dialog: 'dlg-1', expires: 120 });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  const state = summarize(tracker);
  assert.equal(state.list.generation, subscription.generation);
  assert.equal(state.list.subscription.dialog, 'dlg-1');
  assert.equal(state.members[0].generation, subscription.generation);
});

test('列表版本与 fullState 的解析拒绝无效值', () => {
  assert.throws(() => parseRlmi('<list uri="sip:x" version="a" fullState="true"/>'), /版本/);
  assert.throws(() => parseRlmi('<list uri="sip:x" version="0" fullState="maybe"/>'), /fullState/);
  const parsed = parseRlmi(rlmi({ version: 2, full: false, resources: {} }));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.fullState, false);
});

test('正常收到报文与已得到可信完整名单分开报告', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 4,
    list: rlmi({ version: 3, full: false, resources: {} }),
    bodies: {},
  }));
  const state = summarize(tracker);
  // 报文确实收到了，但名单不再可信，两者分别可见。
  assert.equal(state.receivedNoticeCount, 2);
  assert.equal(state.trust.rosterComplete, false);
  assert.equal(state.trust.gap.received, 3);
});

test('比已观测版本更旧的完整名单也不回退状态', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ version: 0, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 4,
    list: rlmi({ version: 3, full: false, resources: {} }),
    bodies: {},
  }));
  const older = tracker.receive(notice({
    dialog: 'dlg-1', cseq: 5,
    list: rlmi({ version: 2, full: true, resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'closed' } },
  }));
  assert.equal(older.reason, 'stale-version');
  const state = summarize(tracker);
  assert.equal(state.list.version, 0);
  assert.equal(state.members[0].basic, 'open');
});

test('成员不能确定时不给出可接待结论', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 1,
    list: rlmi({ resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } }),
    bodies: { 'a@cid': { entity: DESK_A, basic: 'open' } },
  }));
  assert.equal(summarize(tracker).members[0].available, true);

  tracker.receive(notice({
    dialog: 'dlg-1', cseq: 2,
    list: rlmi({ version: 1, full: false, resources: { [DESK_A]: [{ id: 'i1', cid: 'missing@cid' }] } }),
    bodies: {},
  }));
  const member = summarize(tracker).members[0];
  assert.equal(member.basic, null);
  assert.equal(member.uncertainty, 'missing-body');
  assert.equal(member.available, null);
});

test('一份通知里多份列表按各自 uri 与版本分别应用', () => {
  const other = 'sip:desks-b@local.invalid';
  const build = ({ cseq, aVersion, aFull, bVersion, bFull }) => {
    const first = rlmi({ uri: 'sip:desks-a@local.invalid', version: aVersion, full: aFull,
      resources: { [DESK_A]: [{ id: 'i1', cid: 'a@cid' }] } });
    const second = rlmi({ uri: other, version: bVersion, full: bFull,
      resources: { [DESK_A]: [{ id: 'i2', cid: 'a2@cid' }] } });
    const body = [
      part('list-a@cid', 'application/rlmi+xml', first),
      part('list-b@cid', 'application/rlmi+xml', second),
      part('a@cid', 'application/pidf+xml', pidf(DESK_A, 'open')),
      part('a2@cid', 'application/pidf+xml', pidf(DESK_A, 'closed')),
      `--${BOUNDARY}--\r\n`,
    ].join('');
    return message({ dialog: 'dlg-1', cseq, body });
  };
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  const first = tracker.receive(build({ cseq: 1, aVersion: 0, aFull: true, bVersion: 0, bFull: true }));
  assert.equal(first.status, 'applied');
  assert.equal(first.lists.length, 2);
  assert.equal(summarize(tracker).lists.length, 2);

  // 只有 B 列表缺一版，A 列表仍应正常应用。
  const mixed = tracker.receive(build({ cseq: 2, aVersion: 1, aFull: false, bVersion: 3, bFull: false }));
  assert.equal(mixed.status, 'partial');
  const state = summarize(tracker);
  const byUri = Object.fromEntries(state.lists.map(item => [item.uri, item]));
  assert.equal(byUri['sip:desks-a@local.invalid'].version, 1);
  assert.equal(byUri['sip:desks-a@local.invalid'].rosterComplete, true);
  assert.equal(byUri[other].version, 0);
  assert.equal(byUri[other].rosterComplete, false);
  assert.equal(byUri[other].gap.received, 3);
});

test('无法解析的报文单独计数，不影响名单', () => {
  const tracker = new ListTracker();
  tracker.resubscribe({ dialog: 'dlg-1' });
  const bad = tracker.receive(Buffer.from('这不是通知'));
  assert.equal(bad.reason, 'invalid-notification');
  const state = summarize(tracker);
  assert.equal(state.malformedNoticeCount, 1);
  assert.equal(state.receivedNoticeCount, 0);
  assert.equal(state.trust.rosterComplete, false);
});

