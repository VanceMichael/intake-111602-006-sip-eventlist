// 一个只覆盖本协议所需子集的 XML 读取器。它保留元素层级和属性，
// 不参与命名空间校验；调用方按元素的本地名查找。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function localName(name) {
  const index = name.indexOf(':');
  return index < 0 ? name : name.slice(index + 1);
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1]] = decodeEntities(value);
  }
  return attributes;
}

export function parseXml(source) {
  const document = { name: '#document', rawName: '#document', attributes: {}, children: [], text: '' };
  const stack = [document];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open < 0) {
      stack.at(-1).text += decodeEntities(source.slice(index));
      break;
    }
    if (open > index) stack.at(-1).text += decodeEntities(source.slice(index, open));
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end < 0) throw new Error('XML 注释未结束');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end < 0) throw new Error('XML CDATA 未结束');
      stack.at(-1).text += source.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end < 0) throw new Error('XML 处理指令未结束');
      index = end + 2;
      continue;
    }
    if (source.startsWith('<!', open)) {
      const end = source.indexOf('>', open + 2);
      if (end < 0) throw new Error('XML 声明未结束');
      index = end + 1;
      continue;
    }
    if (source.startsWith('</', open)) {
      const end = source.indexOf('>', open + 2);
      if (end < 0) throw new Error('XML 结束标签未结束');
      const rawName = source.slice(open + 2, end).trim();
      const node = stack.pop();
      if (!node || node.name === '#document' || node.rawName !== rawName) throw new Error('XML 结束标签不匹配');
      index = end + 1;
      continue;
    }
    let end = open + 1;
    let quote = null;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= source.length) throw new Error('XML 开始标签未结束');
    let tag = source.slice(open + 1, end);
    const selfClosing = /\/\s*$/.test(tag);
    if (selfClosing) tag = tag.replace(/\/\s*$/, '');
    const nameMatch = /^([^\s/>]+)/.exec(tag);
    if (!nameMatch) throw new Error('XML 标签没有名称');
    const rawName = nameMatch[1];
    const node = {
      name: localName(rawName), rawName, attributes: parseAttributes(tag.slice(rawName.length)),
      children: [], text: ''
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
    index = end + 1;
  }
  if (stack.length !== 1) throw new Error('XML 标签未闭合');
  if (document.children.length === 0) throw new Error('XML 没有根元素');
  return document.children.length === 1 ? document.children[0] : document;
}

export function children(node, name) {
  return (node?.children ?? []).filter(child => child.name === name);
}

export function descendants(node, name) {
  const found = [];
  const visit = current => {
    for (const child of current.children ?? []) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(node ?? { children: [] });
  return found;
}

export function attribute(node, name) {
  if (!node?.attributes) return null;
  if (Object.hasOwn(node.attributes, name)) return node.attributes[name];
  for (const [key, value] of Object.entries(node.attributes)) {
    if (localName(key) === name) return value;
  }
  return null;
}

export function text(node) {
  return (node?.text ?? '').trim();
}
