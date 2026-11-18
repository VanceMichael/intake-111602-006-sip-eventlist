// 解析 SIP NOTIFY + multipart/related 中的 RLMI 列表和状态正文。
// 正文只按 Content-ID 关联，multipart 中各部分的先后次序不参与配对。

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x'
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : match; } catch { return match; }
    }
    return Object.hasOwn(XML_ENTITIES, name.toLowerCase()) ? XML_ENTITIES[name.toLowerCase()] : match;
  });
}

export function parseAttributes(text) {
  const attributes = Object.create(null);
  const pattern = /([a-zA-Z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

export function normalizeContentId(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  const wrapped = /^<\s*([^>]*?)\s*>$/.exec(text);
  const inner = (wrapped ? wrapped[1] : text).trim();
  return inner || null;
}

/**
 * 解析 RLMI 列表文档。返回的 resources 保留资源与实例的层级关系。
 * version 必须是非负整数，否则整份通知不可用于版本推进。
 */
export function parseRlmi(xml) {
  const listTag = /<list\b([^>]*)>/i.exec(xml);
  if (!listTag) throw new Error('列表正文缺少 list 元素');
  const list = parseAttributes(listTag[1]);
  if (!list.uri) throw new Error('列表正文缺少 uri');
  if (!/^\d+$/.test(list.version || '')) throw new Error('列表正文的版本无效');
  const version = Number.parseInt(list.version, 10);
  if (!Number.isSafeInteger(version)) throw new Error('列表正文的版本无效');
  if (list.fullstate !== undefined && !['true', 'false'].includes(list.fullstate.toLowerCase())) {
    throw new Error('列表正文的 fullState 无效');
  }
  const fullState = (list.fullstate || '').toLowerCase() === 'true';

  const resources = [];
  const resourcePattern = /<resource\b([^>]*?)(?:\/>|>([\s\S]*?)<\/resource>)/gi;
  for (const match of xml.matchAll(resourcePattern)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.uri) throw new Error('资源缺少 uri');
    const instances = [];
    const seen = new Set();
    const instancePattern = /<instance\b([^>]*?)\/?>/gi;
    for (const instanceMatch of (match[2] || '').matchAll(instancePattern)) {
      const instance = parseAttributes(instanceMatch[1]);
      if (!instance.id) throw new Error('实例缺少 id');
      if (seen.has(instance.id)) throw new Error(`资源 ${attributes.uri} 的实例 id 重复`);
      seen.add(instance.id);
      const state = (instance.state ?? 'active').toLowerCase();
      instances.push({ id: instance.id, state,
        contentId: normalizeContentId(instance.cid), rawState: instance.state ?? 'active' });
    }
    resources.push({ uri: attributes.uri, instances });
  }
  return { uri: list.uri, version, fullState, resources };
}

/** 解析 PIDF 正文中的 presence entity 和 basic 状态。 */
export function parsePidf(xml) {
  const presenceTag = /<presence\b([^>]*)>/i.exec(xml);
  if (!presenceTag) throw new Error('状态正文缺少 presence 元素');
  const attributes = parseAttributes(presenceTag[1]);
  const values = [...xml.matchAll(/<basic>\s*([^<\s]+)\s*<\/basic>/gi)]
    .map(match => match[1].toLowerCase());
  let basic = null;
  if (values.includes('open')) basic = 'open';
  else if (values.length > 0 && values.every(value => value === 'closed')) basic = 'closed';
  return { entity: attributes.entity ?? null, basic };
}

function parseHeaders(head) {
  const headers = Object.create(null);
  let current = null;
  for (const line of head.split(/\r?\n/)) {
    // 首行是请求行（含 sip: 中的冒号），不能当作头字段。
    if (/^NOTIFY\s+\S+\s+SIP\/2\.0$/i.test(line.trim())) { current = null; continue; }
    if (current && /^[ \t]/.test(line)) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) { current = null; continue; }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!Object.hasOwn(headers, name)) headers[name] = value;
    current = name;
  }
  return headers;
}

function parseSubscriptionState(value) {
  if (!value) return { value: null, parameters: Object.create(null), terminated: false };
  const [rawValue, ...rest] = value.split(';');
  const parameters = Object.create(null);
  for (const item of rest) {
    const colon = item.indexOf('=');
    if (colon < 0) continue;
    parameters[item.slice(0, colon).trim().toLowerCase()] = item.slice(colon + 1).trim().replace(/^"|"$/g, '');
  }
  const state = rawValue.trim().toLowerCase();
  return { value: state || null, parameters, terminated: state === 'terminated' };
}

function boundaryOf(contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  return match ? (match[1] ?? match[2]) : null;
}

function decodeTransfer(body, encoding) {
  const kind = (encoding || '').trim().toLowerCase();
  if (!kind || kind === 'identity' || kind === '7bit' || kind === '8bit' || kind === 'binary') return body;
  if (kind === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

function kindOf(contentType, text) {
  const type = (contentType || '').toLowerCase();
  if (type.includes('application/rlmi+xml')) return 'list';
  if (type.includes('application/pidf+xml')) return 'presence';
  if (type.includes('xml') && /<list\b/i.test(text)) return 'list';
  if (/<presence\b/i.test(text)) return 'presence';
  return 'other';
}

function parsePart(raw) {
  let text = raw;
  if (text.startsWith('\r\n')) text = text.slice(2);
  else if (text.startsWith('\n')) text = text.slice(1);
  text = text.replace(/\r\n$/, '').replace(/\n$/, '');
  const divider = text.indexOf('\r\n\r\n');
  if (divider < 0) throw new Error('多部分正文缺少段头');
  const headers = parseHeaders(text.slice(0, divider));
  const body = decodeTransfer(text.slice(divider + 4), headers['content-transfer-encoding']);
  const contentType = headers['content-type'] || null;
  const contentId = normalizeContentId(headers['content-id']);
  const kind = kindOf(contentType, body);
  const part = { contentId, contentType, kind, text: body,
    bytes: Buffer.byteLength(body, 'utf8'), pidf: null, error: null };
  if (kind === 'presence') {
    try { part.pidf = parsePidf(body); } catch (error) { part.error = error.message; }
  }
  return part;
}

function parseMultipart(body, boundary) {
  const separator = `--${boundary}`;
  const segments = body.split(separator);
  if (segments.length < 3) throw new Error('多部分正文不完整');
  const parts = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.startsWith('--')) break;
    parts.push(parsePart(segment));
  }
  if (parts.length === 0) throw new Error('多部分正文没有有效段');
  return parts;
}

/**
 * 解析一份完整通知。返回：
 * - lists：按正文内容解析出的 RLMI 列表，与 multipart 次序无关；
 * - parts：全部 MIME 段；
 * - partsByContentId：Content-ID -> 段数组，用于把实例 cid 对回正文；
 * - ambiguousContentIds：同一 Content-ID 出现多次的集合。
 */
export function parseNotification(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let divider = text.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (divider < 0) {
    divider = text.indexOf('\n\n');
    separatorLength = 2;
  }
  if (divider < 0) throw new Error('不是完整通知');
  const head = text.slice(0, divider);
  const body = text.slice(divider + separatorLength);
  const requestLine = head.split(/\r?\n/, 1)[0];
  if (!/^NOTIFY\s+\S+\s+SIP\/2\.0$/i.test(requestLine.trim())) throw new Error('不是完整通知');

  const headers = parseHeaders(head);
  if (headers['content-length'] !== undefined) {
    const declared = Number(headers['content-length']);
    if (!Number.isInteger(declared) || declared !== Buffer.byteLength(body, 'utf8')) {
      throw new Error('通知正文长度不符');
    }
  }
  const boundary = boundaryOf(headers['content-type']);
  if (!boundary) throw new Error('没有多部分边界');
  const parts = parseMultipart(body, boundary);

  const partsByContentId = new Map();
  const ambiguousContentIds = new Set();
  for (const part of parts) {
    if (!part.contentId) continue;
    if (partsByContentId.has(part.contentId)) ambiguousContentIds.add(part.contentId);
    const collection = partsByContentId.get(part.contentId) || [];
    collection.push(part);
    partsByContentId.set(part.contentId, collection);
  }

  const lists = parts.filter(part => part.kind === 'list').map(part => parseRlmi(part.text));
  if (lists.length === 0) throw new Error('通知中没有列表正文');

  const cseqValue = headers['cseq'] || null;
  const cseqNumber = cseqValue ? Number.parseInt(cseqValue.split(/\s+/)[0], 10) : null;
  return {
    requestLine: requestLine.trim(),
    dialog: headers['call-id'] || null,
    cseq: cseqValue,
    cseqNumber: Number.isSafeInteger(cseqNumber) ? cseqNumber : null,
    event: headers['event'] || null,
    subscriptionState: parseSubscriptionState(headers['subscription-state']),
    contentType: headers['content-type'] || null,
    parts,
    partsByContentId,
    ambiguousContentIds,
    lists,
  };
}

/**
 * 按 Content-ID 查找某个实例的状态正文。
 * 返回的 issue 非空时表示该实例当前不能确定，而不是实例终止。
 */
export function bodyForContentId(notification, contentId) {
  if (!contentId) return { body: null, issue: 'missing-content-id' };
  if (notification.ambiguousContentIds?.has(contentId)) {
    return { body: null, issue: 'ambiguous-content-id' };
  }
  const matches = notification.partsByContentId?.get(contentId);
  if (!matches || matches.length === 0) return { body: null, issue: 'missing-body' };
  const part = matches[0];
  if (part.kind !== 'presence') return { body: null, issue: 'not-presence-body' };
  if (part.error) return { body: null, issue: 'invalid-body', detail: part.error };
  if (!part.pidf) return { body: null, issue: 'invalid-body' };
  return { body: part.pidf, issue: null };
}
