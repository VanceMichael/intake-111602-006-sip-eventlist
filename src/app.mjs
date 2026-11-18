import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { ListTracker, summarize } from './listtracker.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks));
}

function dialogueSummary(tracker, json) {
  const dialog = json?.dialog ?? null;
  return tracker.resubscribe({ dialog, event: json?.event ?? null,
    expires: json?.expires ?? null });
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const tracker = new ListTracker();
  const client = new SourceClient(source);

  // 从来源获取订阅入口并建立/重建一轮有效订阅，返回本轮的通知位置。
  async function subscribe() {
    const result = await client.request('/subscription');
    if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
    const json = JSON.parse(result.bytes);
    const record = dialogueSummary(tracker, json);
    return { subscription: record,
      notifications: Array.isArray(json.notifications) ? json.notifications : [] };
  }

  async function pull(path) {
    const result = await client.request(path);
    if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
    const record = tracker.receive(result.bytes, { source: result.url });
    return { path: result.url, record, state: summarize(tracker) };
  }

  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');

      if (url.pathname === '/health') {
        return response.end(JSON.stringify({ ready: true, product: profile.name,
          generation: tracker.generation }));
      }

      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }

      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await readJson(request);
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }

      if (request.method === 'GET' && url.pathname === '/receipts') {
        return response.end(JSON.stringify(await catalog.list()));
      }

      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }

      // 建立或重建有效订阅；重建会换对话并丢弃旧一轮的版本链。
      if (request.method === 'POST' && url.pathname === '/subscription') {
        const result = await subscribe();
        response.statusCode = 201;
        return response.end(JSON.stringify({ ...result, state: summarize(tracker) }));
      }

      if (request.method === 'GET' && url.pathname === '/subscription') {
        return response.end(JSON.stringify({ subscription: tracker.subscription,
          state: summarize(tracker) }));
      }

      // 领取一份通知并持续接收：正文按 Content-ID 回填到对应实例。
      if (request.method === 'POST' && url.pathname === '/notifications') {
        const input = await readJson(request);
        if (!input.path) { response.statusCode = 400; return response.end(JSON.stringify({ error: '需要通知位置' })); }
        const result = await pull(input.path);
        return response.end(JSON.stringify(result));
      }

      if (request.method === 'GET' && url.pathname === '/state') {
        return response.end(JSON.stringify(summarize(tracker)));
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    catalog,
    tracker,
    subscribe,
    receive: async (bytes, opts) => tracker.receive(bytes, opts),
    state: () => summarize(tracker),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
