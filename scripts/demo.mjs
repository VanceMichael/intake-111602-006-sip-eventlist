import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource({ scenario: 'transition' });
const app = await startApplication({ source: source.base, root: directory,
  waitMs: 20, settleMs: 200 });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  const settle = async predicate => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await fetch(`${app.base}/seats/status`).then(response => response.json());
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('等待席位状态超时');
  };
  let status = await settle(value => value.version !== null);
  process.stdout.write(`第一轮订阅：对话 ${status.dialog}，版本 ${status.version}，`
    + `可信完整=${status.complete}，说明=${status.staleReason ?? '无'}\n`);
  await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });
  status = await settle(value => value.dialog !== 'dlg-1' && value.complete);
  process.stdout.write(`重建订阅：对话 ${status.dialog}，版本 ${status.version}，`
    + `可信完整=${status.complete}，可接待实例=${status.resources
      .flatMap(resource => resource.instances).filter(item => item.available).length}\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
