// 维护一组席位列表在当前有效订阅下的连续接收状态。
// 关键语义：
// - fullState=true 才构成可信的完整名单；增量只代表相对上一版的局部变化。
// - 版本必须连续推进；出现缺口后旧名单不能继续标为最新，直到新的完整名单。
// - 实例 state=terminated 只结束该实例，不推导整个场馆离线。
// - 订阅重建（Call-ID 可能变化）后，旧对话或旧 CSeq 的迟到通知不覆盖新名单。
// - “正常收到报文”和“已经得到可信完整名单”是两件事，分别记录。

import { bodyForContentId, parseNotification } from './eventlist.mjs';

export class ListTracker {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.generation = 0;
    this.subscription = null;
    this.states = new Map();
    this.primaryUri = null;
    this.dialogCseq = new Map();
    this.notices = [];
  }

  /** 建立新一轮有效订阅；调用后旧一轮的版本链和成员不再作为当前裁定依据。 */
  resubscribe({ dialog, event = null, expires = null, listUri = null } = {}) {
    this.generation += 1;
    this.states = new Map();
    this.primaryUri = listUri ?? null;
    this.subscription = {
      generation: this.generation,
      dialog: dialog ?? null,
      event,
      expires,
      effectiveFrom: this.clock().toISOString(),
    };
    // 只有当前对话保留 CSeq 水位；旧对话的迟到报文由对话裁定拒绝。
    for (const known of this.dialogCseq.keys()) {
      if (known !== this.subscription.dialog) this.dialogCseq.delete(known);
    }
    return this.subscription;
  }

  get state() {
    return this.primaryUri ? this.states.get(this.primaryUri) ?? null : null;
  }

  get list() { return this.state; }

  get uncertain() {
    return this.state?.members.filter(member => member.uncertainty !== null) ?? [];
  }

  /**
   * 接收一份通知字节。opts.source 记录来源位置；opts.dialog 在通知缺少
   * Call-ID 时提供外部已知的对话标识。
   */
  receive(bytes, opts = {}) {
    let notification;
    try { notification = parseNotification(bytes); }
    catch (error) { return this.#reject('invalid-notification', error.message, opts); }

    if (!notification.dialog) {
      if (opts.dialog) notification.dialog = opts.dialog;
      else return this.#reject('missing-dialog', '通知缺少 Call-ID', opts);
    }
    if (!notification.cseqNumber) {
      return this.#reject('invalid-cseq', '通知缺少有效的 CSeq', opts, notification);
    }
    return this.#accept(notification, opts);
  }

  #stamp(opts) {
    return { source: opts.source ?? null, receivedAt: this.clock().toISOString() };
  }

  #reject(code, message, opts, notification = null) {
    const record = {
      status: 'rejected', reason: code, message,
      dialog: notification?.dialog ?? opts.dialog ?? null,
      cseq: notification?.cseq ?? null,
      generation: this.generation,
      ...this.#stamp(opts),
    };
    this.#record(record);
    return record;
  }

  #record(record) {
    this.notices.push(record);
    if (this.notices.length > 500) this.notices.splice(0, this.notices.length - 500);
  }

  #accept(notification, opts) {
    const base = {
      dialog: notification.dialog,
      cseq: notification.cseq,
      cseqNumber: notification.cseqNumber,
      generation: this.generation,
      ...this.#stamp(opts),
    };
    const subscriptionDialog = this.subscription?.dialog ?? null;

    // 重建订阅后换了对话：旧对话的通知属于迟到报文，不能改写新名单。
    if (subscriptionDialog && notification.dialog !== subscriptionDialog) {
      return this.#reject('stale-dialog',
        `通知来自旧对话 ${notification.dialog}，当前有效对话为 ${subscriptionDialog}`,
        opts, notification);
    }

    // 即使对话相同，CSeq 不能回退；相同 CSeq 视为重复报文。
    const lastCseq = this.dialogCseq.get(notification.dialog);
    if (lastCseq !== undefined && notification.cseqNumber <= lastCseq) {
      return this.#reject('stale-cseq',
        `CSeq ${notification.cseqNumber} 不晚于该对话已处理的最新 CSeq ${lastCseq}`,
        opts, notification);
    }
    this.dialogCseq.set(notification.dialog, notification.cseqNumber);

    const warnings = [];
    if (notification.lists.length > 1) {
      warnings.push('通知包含多份列表，按各自 uri 与版本独立核对');
    }
    if (notification.subscriptionState.terminated) {
      warnings.push('订阅进入 terminated，后续不应假定名单继续有效');
    }

    const results = notification.lists.map(list => this.#applyList(list, notification, base));
    const applied = results.filter(item => item.applied).length;
    const status = applied === results.length ? 'applied'
      : applied > 0 ? 'partial' : 'not-applied';
    const record = {
      status,
      dialog: notification.dialog,
      cseq: notification.cseq,
      cseqNumber: notification.cseqNumber,
      subscriptionState: notification.subscriptionState.value,
      terminated: notification.subscriptionState.terminated,
      lists: results.map(item => ({
        uri: item.uri, version: item.version, fullState: item.fullState,
        applied: item.applied, reason: item.reason ?? null,
      })),
      warnings,
      ...base,
    };
    const failed = results.filter(item => !item.applied);
    if (failed.length > 0) {
      record.reason = failed.length === 1 ? failed[0].reason : 'multiple-lists-not-applied';
      record.message = failed.map(item => `${item.uri}：${item.message}`).join('；');
    }
    this.#record(record);
    return record;
  }

  #primary(uri) {
    if (this.primaryUri === null) this.primaryUri = uri;
    return this.primaryUri === uri;
  }

  #applyList(list, notification, base) {
    this.#primary(list.uri);
    const previous = this.states.get(list.uri) ?? null;
    const result = {
      uri: list.uri, version: list.version, fullState: list.fullState,
      applied: false, reason: null, message: null,
    };

    if (!previous) {
      // 当前订阅下，每份列表的第一份通知必须提供完整名单。
      if (!list.fullState) {
        result.reason = 'missing-full-state';
        result.message = '当前订阅尚未获得完整名单，增量不能作为起点';
        return result;
      }
      const next = this.#buildState(list, notification, base, null);
      this.states.set(list.uri, next);
      result.applied = true;
      return result;
    }

    // 已经观测到的最新版本可能因缺口而未被应用，任何更旧的报文都不再采用。
    const seen = Math.max(previous.version, previous.observedVersion ?? 0);
    if (list.version < seen) {
      result.reason = 'stale-version';
      result.message = `列表版本 ${list.version} 早于已观测版本 ${seen}`;
      return result;
    }
    if (list.version === previous.version && !list.fullState) {
      result.reason = 'duplicate-version';
      result.message = `列表版本 ${list.version} 的增量已经处理`;
      return result;
    }

    // 增量若要采用，必须基于可信基线并严格接在上一版之后。
    if (!list.fullState) {
      if (!previous.rosterComplete) {
        previous.observedVersion = Math.max(previous.observedVersion ?? 0, list.version);
        previous.lastCseq = base.cseq;
        previous.updatedAt = base.receivedAt;
        result.reason = previous.gap ? 'untrusted-list' : 'version-gap';
        result.message = '列表尚未由完整名单重建，增量不能标记为最新';
        if (previous.gap) {
          previous.gap.received = Math.max(previous.gap.received, list.version);
        }
        return result;
      }
      if (list.version > previous.version + 1) {
        // 首次发现缺口：保留旧名单，但明确标记已过期。
        previous.gap = {
          expected: previous.version + 1,
          received: list.version,
          detectedAt: base.receivedAt,
          dialog: base.dialog,
          cseq: base.cseq,
          source: base.source,
        };
        previous.rosterComplete = false;
        previous.observedVersion = list.version;
        previous.lastCseq = base.cseq;
        previous.updatedAt = base.receivedAt;
        for (const member of previous.members) {
          if (member.uncertainty === null) {
            member.uncertainty = 'version-gap';
            member.uncertaintyDetail = `缺少版本 ${previous.gap.expected} 至 ${previous.gap.received - 1}`;
          }
        }
        result.reason = 'version-gap';
        result.message = `缺少版本 ${previous.gap.expected} 至 ${previous.gap.received - 1}，旧名单不能标为最新`;
        return result;
      }
    } else if (list.version === previous.version && previous.rosterComplete) {
      result.reason = 'duplicate-version';
      result.message = `列表版本 ${list.version} 的完整名单已经应用`;
      return result;
    }

    const next = this.#buildState(list, notification, base, previous);
    this.states.set(list.uri, next);
    result.applied = true;
    return result;
  }

  #buildState(list, notification, base, previous) {
    const warnings = [];
    const sameList = previous && previous.uri === list.uri;
    const previousMembers = new Map((sameList ? previous.members : []).map(member => [member.key, member]));
    const present = new Set();
    const members = [];

    for (const resource of list.resources) {
      for (const instance of resource.instances) {
        const key = `${resource.uri}\u0000${instance.id}`;
        if (present.has(key)) {
          warnings.push(`资源 ${resource.uri} 的实例 ${instance.id} 在列表中重复出现`);
          continue;
        }
        present.add(key);
        const prior = previousMembers.get(key);
        const lookup = bodyForContentId(notification, instance.contentId);
        const terminated = instance.state === 'terminated';
        const member = {
          key,
          resourceUri: resource.uri,
          instanceId: instance.id,
          contentId: instance.contentId,
          state: instance.rawState,
          stateKind: instance.state,
          terminated,
          basic: lookup.body?.basic ?? null,
          entity: lookup.body?.entity ?? null,
          bodyStatus: instance.contentId ? (lookup.issue ? 'unusable' : 'matched') : 'absent',
          uncertainty: null,
          uncertaintyDetail: null,
          generation: this.generation,
          dialog: base.dialog,
          cseq: base.cseq,
          firstSeen: prior?.firstSeen ?? base.receivedAt,
          updatedAt: base.receivedAt,
        };
        if (terminated) {
          // 实例终止是明确结论；缺少正文不影响该实例已结束。
        } else if (lookup.issue) {
          member.uncertainty = lookup.issue;
          member.uncertaintyDetail = lookup.detail ?? null;
        } else if (lookup.body.entity && lookup.body.entity !== resource.uri) {
          member.uncertainty = 'entity-mismatch';
          member.uncertaintyDetail = `正文 entity ${lookup.body.entity} 与资源 ${resource.uri} 不一致`;
        }
        members.push(member);
      }
    }

    // 增量未提到的成员沿用上一版内容，但只有原来可信的成员才继续可信。
    if (!list.fullState && sameList) {
      for (const prior of previousMembers.values()) {
        if (present.has(prior.key)) continue;
        members.push({
          ...prior,
          retained: true,
          generation: this.generation,
          dialog: base.dialog,
          cseq: base.cseq,
        });
      }
    }

    const gap = list.fullState ? null : (previous?.gap ?? null);
    const rosterComplete = list.fullState ? true : Boolean(previous?.rosterComplete);
    return {
      uri: list.uri,
      version: list.version,
      fullState: list.fullState,
      rosterComplete,
      gap,
      dialog: base.dialog,
      cseq: base.cseq,
      cseqNumber: base.cseqNumber,
      lastCseq: base.cseq,
      generation: this.generation,
      subscription: this.subscription,
      source: base.source,
      receivedAt: base.receivedAt,
      updatedAt: base.receivedAt,
      members,
      warnings,
    };
  }
}

function memberView(member) {
  // available 只在有明确结论时给出；成员不能确定时返回 null，不沿用旧结论。
  const available = member.terminated ? false
    : member.basic === 'open' ? true
      : member.basic === 'closed' ? false : null;
  return {
    resourceUri: member.resourceUri,
    instanceId: member.instanceId,
    contentId: member.contentId,
    state: member.state,
    basic: member.basic,
    terminated: member.terminated,
    available: member.uncertainty === null ? available : null,
    uncertainty: member.uncertainty,
    uncertaintyDetail: member.uncertaintyDetail,
    retained: Boolean(member.retained),
    generation: member.generation,
    updatedAt: member.updatedAt,
  };
}

/** 值班台只读汇总。 */
export function summarize(tracker) {
  const state = tracker.state;
  const malformed = item => item.status === 'rejected'
    && ['invalid-notification', 'missing-dialog', 'invalid-cseq'].includes(item.reason);
  const received = tracker.notices.filter(item => !malformed(item));
  const base = {
    subscription: tracker.subscription,
    generation: tracker.generation,
    // 收到并解析成功的报文数（包含迟到、重复、版本缺口等未应用的情况）。
    receivedNoticeCount: received.length,
    appliedNoticeCount: received.filter(item => item.status === 'applied').length,
    lastNoticeAt: received.at(-1)?.receivedAt ?? null,
    // 无法解释为有效 SIP NOTIFY 的报文数。
    malformedNoticeCount: tracker.notices.filter(malformed).length,
    rejectedNoticeCount: tracker.notices.filter(item => item.status === 'rejected').length,
    notices: tracker.notices.slice(-20).map(item => ({
      status: item.status,
      reason: item.reason ?? null,
      dialog: item.dialog,
      cseq: item.cseq,
      generation: item.generation,
      versions: item.lists?.map(list => ({ uri: list.uri, version: list.version,
        fullState: list.fullState, applied: list.applied, reason: list.reason })) ?? null,
      receivedAt: item.receivedAt,
      source: item.source,
    })),
  };
  if (!state) {
    return {
      ...base,
      list: null,
      lists: [],
      trust: { rosterComplete: false, listStatus: 'no-list' },
      members: [],
      uncertain: [],
      summary: '尚未收到完整名单',
    };
  }
  const listStatus = state.rosterComplete ? 'current'
    : state.gap ? 'stale-after-gap' : 'partial';
  return {
    ...base,
    // 一份通知可以带多份列表；primary 之外的列表在这里各自汇报。
    lists: [...tracker.states.values()].map(item => ({
      uri: item.uri,
      version: item.version,
      fullState: item.fullState,
      rosterComplete: Boolean(item.rosterComplete),
      gap: item.gap,
      memberCount: item.members.length,
      uncertainCount: item.members.filter(member => member.uncertainty !== null).length,
      generation: item.generation,
    })),
    list: {
      uri: state.uri,
      version: state.version,
      observedVersion: state.observedVersion ?? null,
      fullState: state.fullState,
      dialog: state.dialog,
      cseq: state.cseq,
      generation: state.generation,
      subscription: state.subscription,
      source: state.source,
      receivedAt: state.receivedAt,
    },
    trust: {
      // 正常收到报文只说明链路在动；可信完整名单需要完整状态且版本连续。
      rosterComplete: Boolean(state.rosterComplete),
      listStatus,
      gap: state.gap,
    },
    members: state.members.map(memberView),
    // 不能确定的成员按列表汇总，不只限于 primary 列表。
    uncertain: [...tracker.states.values()].flatMap(item => item.members
      .filter(member => member.uncertainty !== null)
      .map(member => ({
        uri: item.uri,
        resourceUri: member.resourceUri,
        instanceId: member.instanceId,
        reason: member.uncertainty,
        since: member.updatedAt,
      }))),
    summary: state.rosterComplete
      ? `列表版本 ${state.version} 为当前可信名单`
      : state.gap
        ? `列表存在版本缺口（缺少 ${state.gap.expected} 至 ${state.gap.received - 1}），当前名单已过期`
        : `列表版本 ${state.version} 尚未形成可信完整名单`,
  };
}
