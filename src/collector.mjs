import { setTimeout as delay } from 'node:timers/promises';
import { SourceClient } from './transport.mjs';
import { SeatTracker } from './seats.mjs';

export class SeatCollector {
  constructor({ source, tracker = new SeatTracker(), client, waitMs = 100, settleMs = 2000,
    poll = true } = {}) {
    if (!source) throw new TypeError('需要资料来源地址');
    this.source = source;
    this.tracker = tracker;
    this.client = client ?? new SourceClient(source);
    this.waitMs = waitMs;
    this.settleMs = settleMs;
    this.poll = poll;
    this.operation = Promise.resolve();
    this.seen = new Set();
    this.accepting = true;
    this.polling = false;
    this.idle = null;
    this.exit = null;
  }

  static async start(options) {
    const collector = new SeatCollector(options);
    await collector.establish();
    if (collector.poll) {
      await collector.pollOnce();
      collector.begin();
    }
    return collector;
  }

  enqueue(task) {
    const operation = this.operation.then(task);
    this.operation = operation.catch(() => {});
    return operation;
  }

  async establish() {
    const result = await this.client.request('/subscription');
    if (result.status !== 200) throw new Error(`订阅查询失败：${result.status}`);
    const info = JSON.parse(result.bytes.toString('utf8'));
    this.tracker.announce(info);
    if (info.dialog) this.tracker.createStream(info.dialog);
    return info;
  }

  ingest(bytes) {
    return this.enqueue(async () => {
      this.wake();
      if (!this.accepting) return null;
      const digest = this.tracker.hash(bytes);
      if (this.seen.has(digest)) return null;
      const result = this.tracker.receive(bytes);
      if (result.applied || result.outcome === 'awaiting-baseline') this.seen.add(digest);
      return result;
    });
  }

  async request(path) {
    if (!path.startsWith('/')) throw new Error('通知位置必须是来源内的绝对路径');
    const result = await this.client.request(path);
    if (result.status !== 200) throw new Error(`通知领取失败：${result.status}`);
    return result.bytes;
  }

  wake() {
    if (this.idle) {
      const resolve = this.idle;
      this.idle = null;
      resolve();
    }
  }

  begin() {
    if (this.polling) return;
    this.polling = true;
    this.loop()
      .catch(error => this.tracker.record('poll-error', null, { message: error.message }))
      .finally(() => { this.polling = false; this.exit?.resolve(); });
  }

  async loop() {
    while (this.accepting) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.tracker.record('poll-error', null, { message: error.message });
      }
      const until = Date.now() + this.settleMs;
      while (this.accepting && Date.now() < until) {
        await Promise.race([
          delay(Math.min(this.waitMs, Math.max(1, until - Date.now()))),
          new Promise(resolve => { this.idle = resolve; })
        ]);
      }
    }
  }

  async pollOnce() {
    const info = await this.enqueue(() => this.establish());
    const dialog = info.dialog ?? this.tracker.current;
    const results = [];
    for (const path of info.notifications ?? []) {
      if (!this.accepting) break;
      try {
        const bytes = await this.request(path);
        results.push(await this.ingest(bytes));
      } catch (error) {
        this.tracker.record('notification-fetch-failed', dialog, { path, message: error.message });
      }
    }
    return results.filter(Boolean);
  }

  async close() {
    if (!this.accepting) return;
    this.accepting = false;
    this.exit = {};
    this.exit.promise = new Promise(resolve => { this.exit.resolve = resolve; });
    this.wake();
    await this.operation;
    if (!this.polling) this.exit.resolve();
    await this.exit.promise;
  }

  state() {
    return this.tracker.state();
  }

  snapshot() {
    return this.tracker.snapshot();
  }
}
