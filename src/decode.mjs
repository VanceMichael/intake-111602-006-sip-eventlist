export function decode(bytes) {
  const text = bytes.toString('utf8');
  const divider = text.indexOf('\r\n\r\n');
  if (!text.startsWith('NOTIFY ') || divider < 0) throw new Error('不是完整通知');
  const head = text.slice(0, divider);
  const field = name => new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(head)?.[1].trim() || null;
  const body = text.slice(divider + 4);
  if (Number(field('Content-Length')) !== Buffer.byteLength(body)) throw new Error('通知正文长度不符');
  const boundary = /boundary="?([^";\r\n]+)/i.exec(field('Content-Type') || '')?.[1];
  if (!boundary) throw new Error('没有多部分边界');
  const parts = body.split(`--${boundary}`).slice(1, -1).map(part => {
    const split = part.indexOf('\r\n\r\n');
    const headers = part.slice(0, split);
    return { contentId: /Content-ID:\s*<([^>]+)>/i.exec(headers)?.[1], contentType: /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1], bytes: Buffer.byteLength(part.slice(split + 4).replace(/\r\n$/, '')) };
  });
  return { dialog: field('Call-ID'), cseq: field('CSeq'), subscription: field('Subscription-State'), parts };
}
