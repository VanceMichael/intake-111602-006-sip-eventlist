import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

async function post(base, path, body = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return response.json();
}

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource({ scenario: 'transition' });
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await post(app.base, '/receipts');
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n\n`);

  const subscription = await post(app.base, '/subscription');
  process.stdout.write(`订阅已建立：对话 ${subscription.subscription.dialog}`
    + `（第 ${subscription.subscription.generation} 轮）\n`);

  const first = await post(app.base, '/notifications', { path: '/notify/1' });
  process.stdout.write(`完整名单：版本 ${first.state.list.version}，`
    + `可信完整名单 ${first.state.trust.rosterComplete}\n`);
  for (const member of first.state.members) {
    process.stdout.write(`  ${member.resourceUri} 实例 ${member.instanceId}`
      + ` 可接待=${member.available}（正文 ${member.contentId}）\n`);
  }

  const gap = await post(app.base, '/notifications', { path: '/notify/gap' });
  process.stdout.write(`版本缺口：${gap.record.message}\n`);
  process.stdout.write(`  当前名单：${gap.state.summary}\n`);
  process.stdout.write(`  不能确定的成员：${gap.state.uncertain.length}\n\n`);

  await post(source.base, '/control', { action: 'advance' });
  const rebuilt = await post(app.base, '/subscription');
  process.stdout.write(`订阅已重建：对话 ${rebuilt.subscription.dialog}`
    + `（第 ${rebuilt.subscription.generation} 轮）\n`);
  const fresh = await post(app.base, '/notifications', { path: '/notify/rebuilt' });
  process.stdout.write(`新对话完整名单：版本 ${fresh.state.list.version}，`
    + `可信完整名单 ${fresh.state.trust.rosterComplete}\n`);

  const late = await post(app.base, '/notifications', { path: '/notify/1' });
  process.stdout.write(`旧对话迟到通知：${late.record.status}（${late.record.reason}），`
    + `当前对话仍为 ${late.state.list.dialog}\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
