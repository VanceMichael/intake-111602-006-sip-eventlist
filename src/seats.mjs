import { createHash } from 'node:crypto';
import { decode } from './decode.mjs';

const MAX_EVENTS = 200;
const MAX_DIALOGS = 8;

function key(resource, instance) {
  return `${resource}\u0000${instance}`;
}

function memberFrom(reference, { dialog, generation, version, cseq, now }) {
  const { resource, instance, cid, content } = reference;
  const state = reference.state ?? null;
  const presence = content?.kind === 'presence' ? content : null;
  let uncertain = false;
  let reason = null;
  if (!state) {
    uncertain = true;
    reason = '缺少实例状态';
  } else if (state !== 'active') {
    uncertain = true;
    reason = `未知的实例状态：${state}`;
  } else if (!cid) {
    uncertain = true;
    reason = '实例没有 Content-ID，无法对应正文';
  } else if (!content) {
    uncertain = true;
    reason = `正文缺失：${cid}`;
  } else if (content.kind === 'invalid') {
    uncertain = true;
    reason = `正文无法解析：${content.error}`;
  } else if (!presence || !presence.basic) {
    uncertain = true;
    reason = 'PIDF 正文没有可用的接待状态';
  } else if (presence.entity && presence.entity !== resource) {
    uncertain = true;
    reason = `正文实体 ${presence.entity} 与资源 ${resource} 不一致`;
  }
  return {
    resource,
    instance,
    state,
    cid,
    presence: presence ? {
      entity: presence.entity,
      basic: presence.basic,
      tuples: presence.tuples.map(tuple => ({ ...tuple }))
    } : null,
    available: !uncertain && presence?.basic ? presence.basic === 'open' : null,
    uncertain,
    reason,
    source: { dialog, generation, version, cseq },
    updatedAt: now
  };
}

function emptyList(uri) {
  return {
    uri: uri ?? null,
    version: null,
    lastFullVersion: null,
    fullState: false,
    updatedAt: null,
    stale: true,
    staleReason: '尚未收到完整名单',
    incompleteReason: null,
    membershipTrusted: false,
    missingVersions: [],
    resources: new Map(),
    unknowns: new Map(),
    awaitingBaselineVersion: null
  };
}

function summaryMember(member) {
  return {
    resource: member.resource,
    instance: member.instance,
    state: member.state,
    cid: member.cid,
    presence: member.presence,
    available: member.available,
    uncertain: member.uncertain,
    reason: member.reason,
    source: { ...member.source },
    updatedAt: member.updatedAt
  };
}

function copyPresence(presence) {
  return presence ? { entity: presence.entity, basic: presence.basic,
    tuples: presence.tuples.map(tuple => ({ ...tuple })) } : null;
}

export class SeatTracker {
  constructor({ maxEvents = MAX_EVENTS, maxDialogs = MAX_DIALOGS, clock = () => new Date() } = {}) {
    this.streams = new Map();
    this.current = null;
    this.generation = 0;
    this.events = [];
    this.maxEvents = maxEvents;
    this.maxDialogs = maxDialogs;
    this.clock = clock;
    this.announced = null;
  }

  record(kind, dialog, detail = {}) {
    this.events.push({ at: this.now(), kind, dialog, ...detail });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  now() {
    return this.clock().toISOString();
  }

  hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  createStream(dialog, { announced = false } = {}) {
    if (!dialog) throw new Error('通知缺少 Call-ID，无法归属订阅');
    if (this.streams.has(dialog)) return this.streams.get(dialog);
    this.generation += 1;
    const stream = {
      dialog,
      generation: this.generation,
      createdAt: this.now(),
      lastReceivedAt: null,
      notifications: 0,
      lastCseq: null,
      lastAppliedCseq: null,
      cseqFloor: null,
      lastDigest: null,
      digests: new Set(),
      valid: false,
      subscription: null,
      list: null
    };
    this.streams.set(dialog, stream);
    this.record(announced ? 'dialog-announced' : 'dialog-established', dialog,
      { generation: stream.generation });
    this.prune();
    return stream;
  }

  prune() {
    if (this.streams.size <= this.maxDialogs) return;
    const removable = [...this.streams.values()]
      .filter(stream => stream.dialog !== this.current)
      .sort((a, b) => a.generation - b.generation);
    for (const stream of removable) {
      if (this.streams.size <= this.maxDialogs) break;
      this.streams.delete(stream.dialog);
    }
  }

  promote(stream, { announced = false } = {}) {
    if (this.current === stream.dialog) return;
    const previous = this.current;
    this.current = stream.dialog;
    if (previous && previous !== stream.dialog) {
      const old = this.streams.get(previous);
      if (old) old.supersededBy = stream.dialog;
      this.record('dialog-superseded', previous, { by: stream.dialog,
        generation: stream.generation });
    }
    this.record(announced ? 'dialog-activated' : 'dialog-rebuilt', stream.dialog,
      { generation: stream.generation, previous });
    this.prune();
  }

  announce(subscription) {
    if (!subscription || typeof subscription.dialog !== 'string' || !subscription.dialog) {
      throw new Error('订阅信息缺少对话标识');
    }
    const previousAnnouncement = this.announced;
    this.announced = {
      dialog: subscription.dialog,
      event: subscription.event ?? null,
      expires: subscription.expires ?? null,
      notifications: Array.isArray(subscription.notifications) ? [...subscription.notifications] : [],
      announcedAt: this.now()
    };
    let stream = this.streams.get(subscription.dialog);
    if (!stream) stream = this.createStream(subscription.dialog, { announced: true });
    else {
      const sameView = previousAnnouncement?.dialog === stream.dialog
        && JSON.stringify(previousAnnouncement.notifications)
          === JSON.stringify(this.announced.notifications);
      if (!sameView) {
        this.record('subscription-refreshed', stream.dialog, { generation: stream.generation,
          notifications: this.announced.notifications });
      }
    }
    stream.valid = true;
    stream.subscription = {
      state: 'active',
      expires: Number.isFinite(Number(subscription.expires)) ? Number(subscription.expires) : null,
      expiresAt: Number.isFinite(Number(subscription.expires))
        ? new Date(this.clock().getTime() + Number(subscription.expires) * 1000).toISOString()
        : null,
      announcedAt: this.announced.announcedAt
    };
    if (previousAnnouncement?.dialog && previousAnnouncement.dialog !== stream.dialog) {
      this.record('subscription-replaced', previousAnnouncement.dialog, {
        by: stream.dialog, generation: stream.generation });
    }
    this.promote(stream, { announced: true });
    return this.subscriptionSummary();
  }

  subscriptionSummary() {
    const summary = { announced: this.announced, current: this.current,
      generation: this.streams.get(this.current)?.generation ?? null };
    return summary;
  }

  receive(input) {
    const notification = Buffer.isBuffer(input) ? decode(input) : input;
    if (!notification?.list || !Array.isArray(notification.references)) {
      throw new TypeError('需要已解码的列表通知');
    }
    if (!notification.dialog) throw new Error('通知缺少 Call-ID，无法归属订阅');
    if (!Number.isSafeInteger(notification.cseqNumber)) throw new Error('通知缺少有效的 CSeq 序号');
    const now = this.now();
    let stream = this.streams.get(notification.dialog);
    if (!stream) {
      stream = this.createStream(notification.dialog, { unannounced: true });
      if (this.current === null || !this.announced || this.announced.dialog === notification.dialog) {
        this.promote(stream);
      } else {
        stream.supersededBy = this.current;
        this.record('dialog-unannounced', stream.dialog, { current: this.current,
          reason: '该对话未出现在当前订阅中，可能是已替换的旧对话' });
      }
    }
    const isCurrent = stream.dialog === this.current;
    if (!isCurrent) {
      if (!stream.digests.has(notification.digest)) {
        this.record('notification-superseded', stream.dialog, { cseq: notification.cseq,
          current: this.current });
        this.touch(stream, notification, now, false);
        this.remember(stream, notification.digest);
      }
      return this.result(notification, {
        outcome: 'superseded', applied: false, current: false,
        reason: '该通知属于已被替换的旧订阅，未写入当前名单'
      });
    }

    this.touch(stream, notification, now, true);
    this.updateSubscription(stream, notification, now);
    if (stream.digests.has(notification.digest)) {
      this.record('notification-duplicate', stream.dialog, { cseq: notification.cseq,
        digest: notification.digest });
      return this.result(notification, { outcome: 'duplicate', applied: false,
        reason: '该报文此前已经接收' });
    }
    this.remember(stream, notification.digest);

    if (stream.lastCseq !== null && notification.cseqNumber <= stream.lastCseq) {
      this.record('notification-out-of-order', stream.dialog, { cseq: notification.cseq,
        expectedAfter: stream.lastCseq });
      return this.result(notification, { outcome: 'out-of-order', applied: false,
        reason: `迟到的报文序号不高于已处理的 ${stream.lastCseq}` });
    }
    if (stream.cseqFloor !== null && notification.cseqNumber > stream.cseqFloor + 1) {
      this.record('cseq-gap', stream.dialog, { expected: stream.cseqFloor + 1,
        received: notification.cseqNumber });
    }
    stream.cseqFloor = notification.cseqNumber;
    stream.lastCseq = notification.cseqNumber;

    const applied = this.apply(stream, notification, now);
    return this.result(notification, applied);
  }

  remember(stream, digest) {
    stream.digests.add(digest);
    if (stream.digests.size > 128) stream.digests.delete(stream.digests.values().next().value);
  }

  touch(stream, notification, now, current) {
    stream.notifications += 1;
    stream.lastReceivedAt = now;
    stream.lastDigest = notification.digest;
    this.record('notification-received', stream.dialog, { cseq: notification.cseq,
      digest: notification.digest, current });
  }

  updateSubscription(stream, notification, now) {
    const state = notification.subscriptionState;
    if (!state) return;
    const expiresAt = Number.isFinite(state.expires)
      ? new Date(this.clock().getTime() + state.expires * 1000).toISOString() : null;
    stream.subscription = { ...state, expiresAt };
    stream.valid = state.state === 'active';
    if (!stream.valid) {
      if (stream.list) {
        stream.list.stale = true;
        stream.list.staleReason = `订阅状态为 ${state.state}`;
        stream.list.complete = false;
      }
      this.record('subscription-inactive', stream.dialog, { state: state.state,
        reason: state.reason });
    }
    if (stream.list) stream.list.updatedAt = now;
  }

  apply(stream, notification, now) {
    const incoming = notification.list;
    let list = stream.list;
    if (!list) {
      if (!incoming.fullState) {
        list = emptyList(incoming.uri);
        list.awaitingBaselineVersion = incoming.version;
        stream.list = list;
        this.record('baseline-missing', stream.dialog, { version: incoming.version });
        return { outcome: 'awaiting-baseline', applied: false, current: true,
          reason: `收到增量版本 ${incoming.version}，但还没有可出的完整基线` };
      }
      list = emptyList(incoming.uri);
      stream.list = list;
    }

    let result;
    if (incoming.fullState) result = this.applyFull(stream, notification, now);
    else result = this.applyIncrement(stream, notification, now);
    if (result.applied) {
      stream.lastAppliedCseq = notification.cseqNumber;
      this.record('notification-applied', stream.dialog, { cseq: notification.cseq,
        version: incoming.version, fullState: incoming.fullState, outcome: result.outcome });
    }
    return result;
  }

  applyFull(stream, notification, now) {
    const incoming = notification.list;
    const list = emptyList(incoming.uri);
    list.uri = incoming.uri ?? list.uri;
    list.version = incoming.version;
    list.lastFullVersion = incoming.version;
    list.fullState = true;
    list.updatedAt = now;
    list.stale = false;
    list.staleReason = null;
    list.incompleteReason = null;
    list.membershipTrusted = true;
    list.missingVersions = [];
    list.awaitingBaselineVersion = null;
    list.resources = new Map();
    list.unknowns = new Map();

    for (const reference of notification.references) {
      if ((reference.resourceState ?? 'active') === 'terminated') {
        this.record('resource-terminated', stream.dialog, { resource: reference.resource,
          version: incoming.version });
        continue;
      }
      if (reference.state === 'terminated') {
        this.record('instance-terminated', stream.dialog, { resource: reference.resource,
          instance: reference.instance, version: incoming.version });
        continue;
      }
      this.putMember(stream, list, reference, {
        dialog: stream.dialog, generation: stream.generation, version: incoming.version,
        cseq: notification.cseq, now
      });
    }

    list.complete = list.unknowns.size === 0;
    list.incompleteReason = list.complete ? null : '完整名单中仍有成员无法对应状态';
    stream.list = list;
    return { outcome: 'applied', applied: true, current: true,
      version: incoming.version, fullState: true };
  }

  applyIncrement(stream, notification, now) {
    const incoming = notification.list;
    const list = stream.list;
    if (list.version === null) {
      list.awaitingBaselineVersion = incoming.version;
      return { outcome: 'awaiting-baseline', applied: false, current: true,
        reason: '没有可更新的完整基线' };
    }
    if (incoming.version === list.version) {
      this.record('version-conflict', stream.dialog, { version: incoming.version });
      return { outcome: 'conflict', applied: false, current: true,
        reason: `版本 ${incoming.version} 已有不同内容，未覆盖现有名单` };
    }
    if (incoming.version < list.version) {
      this.record('version-out-of-order', stream.dialog, { version: incoming.version,
        currentVersion: list.version });
      return { outcome: 'out-of-order', applied: false, current: true,
        reason: `版本 ${incoming.version} 低于已应用的 ${list.version}` };
    }

    const expected = list.version + 1;
    let gap = false;
    if (incoming.version > expected) {
      gap = true;
      list.stale = true;
      list.membershipTrusted = false;
      list.missingVersions = [...new Set([...list.missingVersions,
        ...Array.from({ length: incoming.version - expected }, (_, index) => expected + index)])];
      list.staleReason = `缺少版本 ${list.missingVersions.join('、')}，现有名单不是最新的`;
      list.complete = false;
      this.record('version-gap', stream.dialog, { expected, received: incoming.version,
        missing: list.missingVersions });
      for (const resource of list.resources.values()) {
        for (const instance of resource.instances.values()) {
          if (!instance.uncertain) {
            instance.uncertain = true;
            instance.reason = `漏收版本 ${expected} 至 ${incoming.version - 1}，更新前的成员状态可能已过期`;
          }
        }
      }
    }

    for (const reference of notification.references) {
      if ((reference.resourceState ?? 'active') === 'terminated') {
        list.resources.delete(reference.resource);
        for (const unknownKey of [...list.unknowns.keys()]) {
          if (unknownKey.startsWith(`${reference.resource}\u0000`)) list.unknowns.delete(unknownKey);
        }
        this.record('resource-terminated', stream.dialog, { resource: reference.resource,
          version: incoming.version });
        continue;
      }
      let resource = list.resources.get(reference.resource);
      if (reference.state === 'terminated') {
        if (resource) resource.instances.delete(reference.instance);
        list.unknowns.delete(key(reference.resource, reference.instance));
        this.record('instance-terminated', stream.dialog, { resource: reference.resource,
          instance: reference.instance, version: incoming.version });
        continue;
      }
      if (!resource) {
        resource = { uri: reference.resource, instances: new Map() };
        list.resources.set(reference.resource, resource);
      }
      this.putMember(stream, list, reference, {
        dialog: stream.dialog, generation: stream.generation, version: incoming.version,
        cseq: notification.cseq, now
      });
    }

    list.version = incoming.version;
    list.fullState = false;
    list.updatedAt = now;
    list.complete = !list.stale && list.unknowns.size === 0;
    list.incompleteReason = list.unknowns.size === 0 ? null : '仍有成员无法对应状态';
    return { outcome: 'applied', applied: true, current: true, version: incoming.version,
      fullState: false, gap, missingVersions: gap ? [...list.missingVersions] : [] };
  }

  putMember(stream, list, reference, source) {
    if (!reference.instance) return null;
    const member = memberFrom(reference, source);
    let resource = list.resources.get(reference.resource);
    if (!resource) {
      resource = { uri: reference.resource, instances: new Map() };
      list.resources.set(reference.resource, resource);
    }
    resource.instances.set(reference.instance, member);
    if (member.uncertain) {
      list.unknowns.set(key(reference.resource, reference.instance),
        { resource: reference.resource, instance: reference.instance, reason: member.reason });
    } else {
      list.unknowns.delete(key(reference.resource, reference.instance));
    }
    return member;
  }

  result(notification, applied) {
    return {
      outcome: applied.outcome,
      received: true,
      applied: applied.applied,
      current: applied.current !== false,
      reason: applied.reason ?? null,
      dialog: notification.dialog,
      cseq: notification.cseq,
      cseqNumber: notification.cseqNumber,
      notificationDigest: notification.digest,
      version: applied.version ?? notification.list.version,
      fullState: notification.list.fullState,
      gap: applied.gap ?? false,
      missingVersions: applied.missingVersions ?? [],
      complete: this.isComplete(),
      uncertain: this.uncertain(),
      snapshot: this.snapshot()
    };
  }

  isComplete() {
    const stream = this.streams.get(this.current);
    return Boolean(stream?.valid && stream.list?.complete && !stream.list.stale);
  }

  uncertain() {
    const stream = this.streams.get(this.current);
    const list = stream?.list;
    if (!list) return [];
    const found = new Map();
    for (const resource of list.resources.values()) {
      for (const instance of resource.instances.values()) {
        if (instance.uncertain) {
          found.set(key(instance.resource, instance.instance),
            { resource: instance.resource, instance: instance.instance,
              reason: instance.reason, lastKnown: copyPresence(instance.presence),
              source: { ...instance.source } });
        }
      }
    }
    for (const [unknownKey, unknown] of list.unknowns) {
      if (!found.has(unknownKey)) found.set(unknownKey, { ...unknown });
    }
    return [...found.values()];
  }

  snapshot() {
    const stream = this.streams.get(this.current);
    if (!stream) {
      return { received: false, complete: false, valid: false, current: null,
        dialog: null, generation: null, version: null, fullState: false,
        stale: true, staleReason: '还没有收到任何通知', missingVersions: [],
        updatedAt: null, resources: [], uncertain: [], subscription: null };
    }
    const list = stream.list;
    const resources = list ? [...list.resources.values()].map(resource => {
      const instances = [...resource.instances.values()].map(summaryMember)
        .sort((a, b) => a.instance.localeCompare(b.instance));
      return {
        uri: resource.uri,
        instances,
        activeInstances: instances.filter(instance => instance.state === 'active').length,
        availableInstances: instances.filter(instance => instance.available === true).length,
        uncertainInstances: instances.filter(instance => instance.uncertain).length
      };
    }).sort((a, b) => a.uri.localeCompare(b.uri)) : [];
    const expiry = stream.subscription?.expiresAt;
    const expired = expiry ? Date.parse(expiry) <= this.clock().getTime() : false;
    const valid = Boolean(stream.valid && !expired);
    let stale = list ? list.stale : true;
    let staleReason = list ? list.staleReason : (stream.valid ? '尚未收到完整名单' : '订阅尚未激活');
    if (expired && !stale) {
      stale = true;
      staleReason = '订阅已过期';
    }
    const incompleteReason = list?.incompleteReason ?? null;
    return {
      received: stream.notifications > 0,
      complete: Boolean(valid && list?.complete && !stale && list?.version !== null),
      valid,
      current: stream.dialog,
      dialog: stream.dialog,
      generation: stream.generation,
      version: list?.version ?? null,
      lastFullVersion: list?.lastFullVersion ?? null,
      fullState: list?.fullState ?? false,
      stale,
      staleReason,
      incompleteReason,
      membershipTrusted: Boolean(list?.membershipTrusted && !stale),
      missingVersions: list?.missingVersions ? [...list.missingVersions] : [],
      awaitingBaselineVersion: list?.awaitingBaselineVersion ?? null,
      updatedAt: list?.updatedAt ?? null,
      resources,
      uncertain: this.uncertain(),
      subscription: stream.subscription ? { ...stream.subscription } : null,
      lastCseq: stream.lastCseq,
      lastAppliedCseq: stream.lastAppliedCseq,
      notifications: stream.notifications
    };
  }

  dialogs() {
    return [...this.streams.values()].sort((a, b) => a.generation - b.generation).map(stream => ({
      dialog: stream.dialog,
      generation: stream.generation,
      current: stream.dialog === this.current,
      valid: stream.valid,
      version: stream.list?.version ?? null,
      complete: Boolean(stream.list?.complete && !stream.list?.stale),
      notifications: stream.notifications,
      lastCseq: stream.lastCseq,
      lastReceivedAt: stream.lastReceivedAt,
      supersededBy: stream.supersededBy ?? null,
      createdAt: stream.createdAt
    }));
  }

  state() {
    return { current: this.snapshot(), dialogs: this.dialogs(), events: [...this.events],
      announced: this.announced };
  }
}
