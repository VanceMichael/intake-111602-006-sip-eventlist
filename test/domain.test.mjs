import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('列表版本缺口与重建对话的通知身份可以分别核对', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const first = decode((await client.request('/notify/1')).bytes);
    const gap = decode((await client.request('/notify/gap')).bytes);
    assert.equal(first.dialog, gap.dialog);
    assert.notEqual(first.cseq, gap.cseq);
    assert.deepEqual(first.parts.map(part => part.contentId), ['list@cid', 'desk-a@cid']);
    await client.control({ action: 'advance' });
    const subscription = JSON.parse((await client.request('/subscription')).bytes);
    const rebuilt = decode((await client.request(subscription.notifications[0])).bytes);
    assert.equal(subscription.dialog, rebuilt.dialog);
    assert.notEqual(rebuilt.dialog, first.dialog);
  } finally { await source.close(); }
});
