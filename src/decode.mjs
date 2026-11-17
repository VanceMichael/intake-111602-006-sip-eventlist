import { createHash } from 'node:crypto';
import { attribute, children, descendants, parseXml, text } from './xml.mjs';

const RLMI = 'application/rlmi+xml';
const PIDF = 'application/pidf+xml';

function foldHeaders(source) {
  return source.replace(/\r\n[ \t]+/g, ' ');
}

function readFields(head) {
  const fields = {};
  for (const line of foldHeaders(head).split('\r\n')) {
    if (!line) continue;
    const split = line.indexOf(':');
    if (split <= 0) continue;
    const name = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (Object.hasOwn(fields, name)) fields[name] = `${fields[name]}, ${value}`;
    else fields[name] = value;
  }
  return fields;
}

export function parseMediaType(value) {
  const [type = '', ...rest] = String(value || '').split(';');
  const params = {};
  for (const item of rest) {
    const split = item.indexOf('=');
    if (split < 0) continue;
    const name = item.slice(0, split).trim().toLowerCase();
    let parameter = item.slice(split + 1).trim();
    if ((parameter.startsWith('"') && parameter.endsWith('"'))
      || (parameter.startsWith("'") && parameter.endsWith("'"))) parameter = parameter.slice(1, -1);
    params[name] = parameter;
  }
  return { type: type.trim().toLowerCase(), params };
}

function cseqNumber(value) {
  const number = Number.parseInt(String(value || '').split(/\s+/)[0], 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const segments = [];
  let start = 0;
  while (start < body.length) {
    const index = body.indexOf(marker, start);
    if (index < 0) break;
    if (index !== 0 && body.slice(index - 2, index) !== '\r\n') {
      start = index + marker.length;
      continue;
    }
    let after = index + marker.length;
    if (body.startsWith('--', after)) return { segments, closed: true, end: after + 2 };
    if (body.startsWith('\r\n', after)) after += 2;
    else if (body[after] === '\n') after += 1;
    else {
      start = index + marker.length;
      continue;
    }
    const next = body.indexOf(`\r\n${marker}`, after);
    if (next < 0) throw new Error('多部分正文没有结束边界');
    segments.push(body.slice(after, next));
    start = next + 2;
  }
  throw new Error('多部分正文缺少结束边界');
}

function parsePart(segment, index) {
  const divider = segment.indexOf('\r\n\r\n');
  if (divider < 0) throw new Error(`第 ${index + 1} 个正文段没有头部`);
  const fields = readFields(segment.slice(0, divider));
  const raw = Buffer.from(segment.slice(divider + 4), 'utf8');
  const declared = fields['content-length'];
  if (declared !== undefined && declared !== String(raw.length)) {
    throw new Error(`第 ${index + 1} 个正文段长度不符`);
  }
  const type = parseMediaType(fields['content-type']);
  const contentId = String(fields['content-id'] || '').replace(/^\s*<|>\s*$/g, '').trim() || null;
  return {
    index, contentId, contentType: fields['content-type'] || null, mediaType: type.type,
    parameters: type.params, bytes: raw.length, body: raw, text: raw.toString('utf8'),
    digest: createHash('sha256').update(raw).digest('hex')
  };
}

function parseSubscription(value) {
  if (!value) return null;
  const [state, ...rest] = String(value).split(';');
  const fields = {};
  for (const item of rest) {
    const split = item.indexOf('=');
    if (split < 0) continue;
    fields[item.slice(0, split).trim().toLowerCase()] = item.slice(split + 1).trim();
  }
  return { state: state.trim(), expires: fields.expires ? Number(fields.expires) : null,
    reason: fields.reason || null, retryAfter: fields['retry-after'] || null };
}

function parsePidf(node, part) {
  const presence = node?.name === 'presence' ? node : descendants(node, 'presence')[0];
  if (!presence) return { error: 'PIDF 正文没有 presence 元素' };
  const tuples = descendants(presence, 'tuple').map(tuple => {
    const basic = descendants(tuple, 'basic')[0];
    const note = descendants(tuple, 'note')[0];
    return { id: attribute(tuple, 'id'), basic: basic ? text(basic).toLowerCase() || null : null,
      note: note ? text(note) : null };
  });
  return { entity: attribute(presence, 'entity'), tuples,
    basic: tuples.find(tuple => tuple.basic)?.basic ?? null };
}

function parseContents(part) {
  try {
    const document = parseXml(part.text);
    if (part.mediaType === PIDF || document.name === 'presence') {
      const presence = parsePidf(document, part);
      return { kind: 'presence', ...presence, contentType: part.contentType, contentId: part.contentId };
    }
    return { kind: 'other', root: document.name, contentType: part.contentType, contentId: part.contentId };
  } catch (error) {
    return { kind: 'invalid', error: error.message, contentType: part.contentType, contentId: part.contentId };
  }
}

function parseList(part) {
  const document = parseXml(part.text);
  if (document.name !== 'list') throw new Error('RLMI 正文没有 list 元素');
  const versionText = attribute(document, 'version');
  if (!/^\d+$/.test(versionText ?? '')) throw new Error('RLMI 缺少有效的列表版本');
  const fullText = String(attribute(document, 'fullState') ?? '').toLowerCase();
  if (!['true', 'false'].includes(fullText)) throw new Error('RLMI 缺少完整状态标记');
  const resources = children(document, 'resource').map(resource => {
    const uri = attribute(resource, 'uri');
    if (!uri) throw new Error('RLMI 资源缺少 uri');
    const instances = children(resource, 'instance').map(instance => {
      const id = attribute(instance, 'id');
      if (!id) throw new Error('RLMI 实例缺少 id');
      return { id, state: attribute(instance, 'state')?.toLowerCase() ?? null,
        cid: attribute(instance, 'cid') || null, reason: attribute(instance, 'reason') || null };
    });
    const seen = new Set();
    for (const instance of instances) {
      if (seen.has(instance.id)) throw new Error(`RLMI 资源 ${uri} 的实例 ${instance.id} 重复`);
      seen.add(instance.id);
    }
    return { uri, state: attribute(resource, 'state')?.toLowerCase() ?? null, instances };
  });
  return { contentId: part.contentId, uri: attribute(document, 'uri'),
    version: Number.parseInt(versionText, 10), fullState: fullText === 'true', resources };
}

export function decode(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('通知必须是原始字节');
  const raw = bytes.toString('utf8');
  const divider = raw.indexOf('\r\n\r\n');
  if (!raw.startsWith('NOTIFY ') || divider < 0) throw new Error('不是完整通知');
  const head = raw.slice(0, divider);
  const fields = readFields(head);
  const body = raw.slice(divider + 4);
  const declared = fields['content-length'];
  if (declared !== undefined && declared !== String(Buffer.byteLength(body))) {
    throw new Error('通知正文长度不符');
  }
  const contentType = parseMediaType(fields['content-type']);
  if (contentType.type !== 'multipart/related') throw new Error('通知正文不是 multipart/related');
  const boundary = contentType.params.boundary;
  if (!boundary) throw new Error('没有多部分边界');
  const { segments } = splitMultipart(body, boundary);
  const parts = segments.map(parsePart);
  const contentIds = new Map();
  for (const part of parts) {
    if (!part.contentId) continue;
    if (contentIds.has(part.contentId)) throw new Error(`Content-ID 重复：${part.contentId}`);
    contentIds.set(part.contentId, part);
  }
  const listParts = parts.filter(part => part.mediaType === RLMI);
  if (listParts.length !== 1) throw new Error('通知必须包含且只包含一份 RLMI 列表');
  const list = parseList(listParts[0]);
  const contents = new Map();
  const orphans = [];
  for (const part of parts) {
    if (part === listParts[0]) continue;
    if (!part.contentId) { orphans.push({ index: part.index, reason: '正文段没有 Content-ID' }); continue; }
    contents.set(part.contentId, { part, parsed: parseContents(part) });
  }
  const references = [];
  for (const resource of list.resources) {
    if (resource.instances.length === 0) {
      references.push({ resource: resource.uri, resourceState: resource.state, instance: null,
        state: null, cid: null, part: null, content: null, resolved: false });
      continue;
    }
    for (const instance of resource.instances) {
      if (!instance.cid) {
        references.push({ resource: resource.uri, resourceState: resource.state,
          instance: instance.id, state: instance.state, cid: null,
          part: null, content: null, resolved: instance.state === 'terminated' });
        continue;
      }
      const entry = contents.get(instance.cid);
      references.push({ resource: resource.uri, resourceState: resource.state,
        instance: instance.id, state: instance.state, cid: instance.cid,
        part: entry?.part ?? null, content: entry?.parsed ?? null,
        resolved: Boolean(entry && entry.parsed.kind !== 'invalid') });
    }
  }
  const referenced = new Set(references.filter(item => item.cid).map(item => item.cid));
  for (const [contentId, entry] of contents) {
    if (!referenced.has(contentId)) orphans.push({ index: entry.part.index, contentId,
      reason: '正文没有被列表实例引用' });
  }
  return {
    dialog: fields['call-id'] || null,
    cseq: fields.cseq || null,
    cseqNumber: cseqNumber(fields.cseq),
    event: fields.event || null,
    subscription: fields['subscription-state'] || null,
    subscriptionState: parseSubscription(fields['subscription-state']),
    parts: parts.map(part => ({
      index: part.index, contentId: part.contentId, contentType: part.contentType,
      mediaType: part.mediaType, bytes: part.bytes, text: part.text,
      digest: part.digest
    })),
    list,
    references,
    orphans,
    digest: createHash('sha256').update(bytes).digest('hex')
  };
}
