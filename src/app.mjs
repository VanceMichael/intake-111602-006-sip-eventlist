import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { SeatCollector } from './collector.mjs';
import { profile } from './profile.mjs';

async function readBody(request, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('请求正文超过本地上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function previewOf(notification) {
  return {
    dialog: notification.dialog,
    cseq: notification.cseq,
    cseqNumber: notification.cseqNumber,
    event: notification.event,
    subscription: notification.subscription,
    subscriptionState: notification.subscriptionState,
    parts: notification.parts,
    list: notification.list,
    references: notification.references.map(reference => ({
      resource: reference.resource,
      resourceState: reference.resourceState,
      instance: reference.instance,
      state: reference.state,
      cid: reference.cid,
      resolved: reference.resolved,
      content: reference.content
    })),
    orphans: notification.orphans,
    digest: notification.digest
  };
}

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

export async function startApplication({ source, root, port = 0, collector: supplied,
  waitMs = 100, settleMs = 2000 } = {}) {
  const catalog = await new Catalog(root).initialize();
  const collector = supplied ?? await SeatCollector.start({ source, waitMs, settleMs });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = url.pathname;
      if (route === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && route === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: previewOf(result.preview) }));
      }
      if (request.method === 'POST' && route === '/receipts') {
        const input = JSON.parse(await readBody(request) || Buffer.from('{}'));
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: previewOf(result.preview) });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'GET' && route === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'GET' && route.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(route.split('/').at(-1)));
      }
      if (request.method === 'GET' && route === '/seats') {
        const state = collector.state();
        return response.end(JSON.stringify({ status: collector.snapshot(),
          dialogs: state.dialogs, announced: state.announced, events: state.events }));
      }
      if (request.method === 'GET' && route === '/seats/status') {
        return response.end(JSON.stringify(collector.snapshot()));
      }
      if (request.method === 'GET' && route === '/seats/events') {
        return response.end(JSON.stringify(collector.state().events));
      }
      if (request.method === 'POST' && route === '/seats/notifications') {
        const bytes = await readBody(request);
        if (bytes.length === 0) throw new Error('通知正文不能为空');
        const result = await collector.ingest(bytes);
        if (result === null) return response.end(JSON.stringify({ outcome: 'duplicate',
          received: false, applied: false, reason: '该报文此前已经接收' }));
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'POST' && route === '/seats/refresh') {
        const info = await collector.enqueue(() => collector.establish());
        return response.end(JSON.stringify({ ...collector.tracker.subscriptionSummary(),
          notifications: info.notifications ?? [] }));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, collector,
    close: async () => {
      await collector.close();
      await new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
