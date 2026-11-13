/**
 * Email into documents: a header block (Subject as the title, then From, To, Cc and Date), the
 * body (HTML through the HTML importer, with inline images from related parts; or plain text),
 * and a list of attachments with their types and sizes.
 *
 *   - Internet messages (RFC 5322 / MIME, RFC 2045-2047): .eml, Apple Mail .emlx, mbox mailboxes
 *     (each message in its own section) and MHTML web archives (.mht: the page only).
 *   - Outlook .msg (MS-OXMSG, a compound file of MAPI properties).
 *   - TNEF "winmail.dat" bundles (MS-OXTNEF): subject, sender, date, body and attachment names.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { openCfb, le, type Cfb } from '../cfb';
import { DocBuilder } from '../legacy/builder';
import { decodeCodepage } from '../legacy/codepage';
import { bytesToBase64 } from '../serialize';

const u8a = (d: ArrayBuffer | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(d));
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const bytes = (s: string) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };

export interface Attachment { name: string; type: string; size: number; data?: Uint8Array; cid?: string }
export interface Message { subject: string; from: string; to: string; cc: string; date: string; html: string | null; text: string | null; attachments: Attachment[]; inline: Map<string, string>; rtf?: Uint8Array }

// ---------------------------------------------------------------------------------------
// MIME

function charsetDecode(b: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^(x-|cp-?)/, (m) => (m.startsWith('cp') ? 'windows-' : '')).replace(/^us-ascii$/, 'windows-1252');
  try { return new TextDecoder(cs).decode(b); } catch { try { return new TextDecoder('utf-8').decode(b); } catch { return latin1(b); } }
}

/** RFC 2047 encoded words in header values. */
export function decodeWords(v: string): string {
  return v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    const raw = enc.toUpperCase() === 'B' ? b64(text) : bytes(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))));
    return charsetDecode(raw, cs.replace(/\*.*$/, ''));
  });
}

function b64(s: string): Uint8Array {
  let clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const rem = clean.length % 4;
  if (rem === 1) clean = clean.slice(0, -1);
  else if (rem) clean += rem === 2 ? '==' : '=';
  try { return bytes(atob(clean)); } catch { return new Uint8Array(0); }
}
function qp(s: string): Uint8Array {
  return bytes(s.replace(/=[ \t]*\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

interface Part { headers: Map<string, string>; body: string }

function splitHeaders(raw: string): Part {
  if (/^\r?\n/.test(raw)) return { headers: new Map(), body: raw.replace(/^\r?\n/, '') };
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!headers.has(k)) headers.set(k, rawHeader(line.slice(i + 1).trim())); }
  }
  return { headers, body };
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
/** Header text was read as Latin-1; raw 8-bit headers are nearly always UTF-8, so decode them as such when they are valid. */
function rawHeader(v: string): string {
  if (!/[\x80-\xff]/.test(v)) return v;
  try { return utf8Strict.decode(bytes(v)); } catch { return v; }
}

/** RFC 2231 extended value: charset'language'percent-encoded bytes. */
function extValue(v: string): string {
  const m = /^([\w.:-]*)'[^']*'(.*)$/.exec(v);
  if (!m) return v;
  const raw = bytes(m[2].replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))));
  return charsetDecode(raw, m[1] || 'utf-8');
}

/** Body pieces of a multipart: delimiters are whole lines "--boundary" (or "--boundary--" to close). */
function multipartPieces(body: string, boundary: string): string[] {
  const re = new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*\\r?$`, 'gm');
  const pieces: string[] = [];
  let from = -1;
  for (let m; (m = re.exec(body)); ) {
    // The line break before a delimiter belongs to it.
    if (from >= 0) pieces.push(body.slice(from, m.index).replace(/\r?\n$/, ''));
    if (m[1]) { from = -1; break; }
    from = m.index + m[0].length;
    if (body[from] === '\n') from++;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (from >= 0) pieces.push(body.slice(from));
  return pieces;
}

const param = (v: string, name: string) => {
  const m = new RegExp(`(?:^|;)\\s*${name}(\\*?)=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(v.slice(0, 65536));
  const r = m ? m[2] ?? m[3] : '';
  return m?.[1] || /^[\w-]+'[^']*'/.test(r) ? extValue(r) : decodeWords(r);
};

function partBytes(p: Part): Uint8Array {
  const enc = (p.headers.get('content-transfer-encoding') || '').toLowerCase();
  if (enc === 'base64') return b64(p.body);
  if (enc === 'quoted-printable') return qp(p.body);
  return bytes(p.body);
}

export function parseMime(raw: string, depth = 0): Message {
  const top = splitHeaders(raw);
  const h = top.headers;
  const msg: Message = {
    subject: decodeWords(h.get('subject') || ''), from: decodeWords(h.get('from') || ''), to: decodeWords(h.get('to') || ''),
    cc: decodeWords(h.get('cc') || ''), date: h.get('date') || '', html: null, text: null, attachments: [], inline: new Map(),
  };
  const walk = (p: Part, depth: number) => {
    if (depth > 12) return;
    const ct = p.headers.get('content-type') || 'text/plain';
    const type = ct.split(';')[0].trim().toLowerCase();
    const disp = (p.headers.get('content-disposition') || '').toLowerCase();
    const fname = param(p.headers.get('content-disposition') || '', 'filename') || param(ct, 'name');
    if (type.startsWith('multipart/')) {
      const boundary = param(ct, 'boundary');
      if (!boundary) return;
      for (const piece of multipartPieces(p.body, boundary)) if (piece.trim()) walk(splitHeaders(piece), depth + 1);
      return;
    }
    if (type === 'message/rfc822' && !disp.startsWith('attachment')) { const inner = parseMime(latin1(partBytes(p)), depth + 1); if (!msg.text && !msg.html) { msg.text = inner.text; msg.html = inner.html; } msg.attachments.push(...inner.attachments); return; }
    const data = partBytes(p);
    const cid = (p.headers.get('content-id') || '').replace(/[<>]/g, '');
    const loc = p.headers.get('content-location') || '';
    if (type.startsWith('image/') && (cid || loc)) {
      const url = `data:${type};base64,${bytesToBase64(data)}`;
      if (cid) msg.inline.set('cid:' + cid, url);
      if (loc) msg.inline.set(loc, url);
      if (!disp.startsWith('attachment')) return;
    }
    if (!disp.startsWith('attachment') && !fname && (type === 'text/html' || type === 'text/plain')) {
      const s = charsetDecode(data, param(ct, 'charset'));
      if (type === 'text/html' && msg.html == null) msg.html = s;
      else if (type === 'text/plain' && msg.text == null) msg.text = s;
      return;
    }
    msg.attachments.push({ name: fname || `(unnamed ${type})`, type, size: data.length, data, cid });
  };
  walk(top, depth);
  return msg;
}

// ---------------------------------------------------------------------------------------
// Compressed RTF (MS-OXRTFCP), the body format Outlook stores most often

const RTF_PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

export function decompressRtf(b: Uint8Array): Uint8Array | null {
  if (b.length < 16) return null;
  const rawSize = le.u32(b, 4), type = le.u32(b, 8);
  if (type === 0x414c454d) return b.subarray(16, 16 + rawSize); // "MELA": stored
  if (type !== 0x75465a4c) return null; // "LZFu"
  const dict = new Uint8Array(4096);
  for (let i = 0; i < RTF_PREBUF.length; i++) dict[i] = RTF_PREBUF.charCodeAt(i);
  let w = RTF_PREBUF.length;
  const out: number[] = [];
  let p = 16;
  while (p < b.length && out.length < rawSize + 16) {
    const ctl = b[p++];
    for (let bit = 0; bit < 8 && p < b.length; bit++) {
      if (ctl & (1 << bit)) {
        const ref = (b[p] << 8) | b[p + 1];
        p += 2;
        const off = ref >> 4, len = (ref & 15) + 2;
        if (off === w) return new Uint8Array(out);
        for (let k = 0; k < len; k++) { const c = dict[(off + k) & 4095]; out.push(c); dict[w] = c; w = (w + 1) & 4095; }
      } else { const c = b[p++]; out.push(c); dict[w] = c; w = (w + 1) & 4095; }
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------------------
// Outlook .msg

function msgProp(c: Cfb, base: string, id: number): string | null {
  const hexId = id.toString(16).toUpperCase().padStart(4, '0');
  const w = c.read(`${base}__substg1.0_${hexId}001F`);
  if (w) { let s = ''; for (let i = 0; i + 1 < w.length; i += 2) s += String.fromCharCode(le.u16(w, i)); return s.replace(/\0+$/, ''); }
  const a = c.read(`${base}__substg1.0_${hexId}001E`);
  if (a) return decodeCodepage(a, 1252).replace(/\0+$/, '');
  return null;
}
const msgBin = (c: Cfb, base: string, id: number) => c.read(`${base}__substg1.0_${id.toString(16).toUpperCase().padStart(4, '0')}0102`);

export function parseMsg(u8: Uint8Array): Message {
  const c = openCfb(u8);
  if (!c) throw new Error('Not an Outlook message');
  const html = msgBin(c, '', 0x1013);
  const cpid = 65001;
  const msg: Message = {
    subject: msgProp(c, '', 0x0037) || '', from: '', to: msgProp(c, '', 0x0e04) || '', cc: msgProp(c, '', 0x0e03) || '',
    date: '', html: html ? charsetDecode(html, cpid === 65001 ? 'utf-8' : 'windows-1252') : msgProp(c, '', 0x1013), text: msgProp(c, '', 0x1000), attachments: [], inline: new Map(),
  };
  const rtf = msgBin(c, '', 0x1009);
  if (rtf && !msg.html) msg.rtf = decompressRtf(rtf) || undefined;
  const name = msgProp(c, '', 0x0c1a) || msgProp(c, '', 0x0042) || '';
  const addr = msgProp(c, '', 0x0c1f) || msgProp(c, '', 0x5d01) || msgProp(c, '', 0x0065) || '';
  msg.from = name && addr && name !== addr ? `${name} <${addr}>` : name || addr;
  const headers = msgProp(c, '', 0x007d);
  if (headers) { const d = /^Date:\s*(.+)$/im.exec(headers); if (d) msg.date = d[1].trim(); }
  if (!msg.date) {
    // Fixed-size properties: 32-byte header, then 16-byte entries (tag, flags, value).
    const props = c.read('__properties_version1.0');
    if (props) for (let p = 32; p + 16 <= props.length; p += 16) {
      const tag = le.u32(props, p);
      if (tag === 0x00390040 || tag === 0x0e060040) {
        const lo = le.u32(props, p + 8), hi = le.u32(props, p + 12);
        const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
        if (ms > 0) { msg.date = new Date(ms).toUTCString(); break; }
      }
    }
  }
  for (const e of c.root.children) {
    if (!e.name.startsWith('__attach_version1.0_')) continue;
    const base = e.name + '/';
    const data = msgBin(c, base, 0x3701);
    const aname = msgProp(c, base, 0x3707) || msgProp(c, base, 0x3704) || msgProp(c, base, 0x3001) || 'attachment';
    const type = msgProp(c, base, 0x370e) || 'application/octet-stream';
    const cid = msgProp(c, base, 0x3712) || '';
    if (data && cid && type.startsWith('image/')) msg.inline.set('cid:' + cid, `data:${type};base64,${bytesToBase64(data)}`);
    msg.attachments.push({ name: aname, type, size: data?.length || 0, data: data || undefined, cid });
  }
  return msg;
}

// ---------------------------------------------------------------------------------------
// TNEF (winmail.dat)

export function parseTnef(u8: Uint8Array): Message {
  if (le.u32(u8, 0) !== 0x223e9f78) throw new Error('Not a TNEF file');
  const msg: Message = { subject: '', from: '', to: '', cc: '', date: '', html: null, text: null, attachments: [], inline: new Map() };
  let att: Attachment | null = null;
  for (let p = 6; p + 9 <= u8.length; ) {
    const level = u8[p], id = le.u32(u8, p + 1), len = le.u32(u8, p + 5);
    const d = u8.subarray(p + 9, Math.min(u8.length, p + 9 + len));
    p += 9 + len + 2;
    const str = () => decodeCodepage(d, 1252).replace(/\0+$/, '');
    const code = id & 0xffff;
    if (level === 1) {
      if (code === 0x8004) msg.subject = str();
      else if (code === 0x800c) msg.text = str();
      else if (code === 0x8000) msg.from = str().replace(/[\x00-\x1f]+/g, ' ').trim();
      else if (code === 0x8005 && d.length >= 12) msg.date = new Date(Date.UTC(le.u16(d, 0), le.u16(d, 2) - 1, le.u16(d, 4), le.u16(d, 6), le.u16(d, 8), le.u16(d, 10))).toUTCString();
      else if (code === 0x9003) {
        const props = tnefProps(d);
        const str = (id: number) => props.get(id);
        if (!msg.subject && typeof str(0x0037) === 'string') msg.subject = str(0x0037) as string;
        if (!msg.text && typeof str(0x1000) === 'string') msg.text = str(0x1000) as string;
        const html = str(0x1013);
        if (html instanceof Uint8Array) msg.html = charsetDecode(html, 'utf-8'); else if (typeof html === 'string') msg.html = html;
        const rtf = str(0x1009);
        if (rtf instanceof Uint8Array) msg.rtf = decompressRtf(rtf) || undefined;
        if (!msg.from && typeof str(0x0c1a) === 'string') msg.from = str(0x0c1a) as string;
      }
    } else if (level === 2) {
      if (code === 0x9002) { att = { name: 'attachment', type: 'application/octet-stream', size: 0 }; msg.attachments.push(att); }
      else if (att && code === 0x8010) att.name = str();
      else if (att && code === 0x800f) { att.data = d; att.size = d.length; }
    }
  }
  return msg;
}

/** MAPI property block inside TNEF (attMsgProps): id → string or bytes (first value). */
function tnefProps(d: Uint8Array): Map<number, string | Uint8Array | number> {
  const out = new Map<number, string | Uint8Array | number>();
  let p = 4;
  const n = le.u32(d, 0);
  const pad = (x: number) => (x + 3) & ~3;
  for (let k = 0; k < Math.min(n, 4096) && p + 4 <= d.length; k++) {
    const type = le.u16(d, p), id = le.u16(d, p + 2);
    p += 4;
    if (id >= 0x8000) { p += 16; const kind = le.u32(d, p); p += 4; if (kind === 0) p += 4; else { const len = le.u32(d, p); p += 4 + pad(len); } }
    const base = type & 0x0fff, multi = !!(type & 0x1000);
    const count = multi || base === 0x1e || base === 0x1f || base === 0x102 || base === 0x0d ? le.u32(d, p) : 1;
    if (multi || base === 0x1e || base === 0x1f || base === 0x102 || base === 0x0d) p += 4;
    for (let v = 0; v < Math.min(count, 1024) && p <= d.length; v++) {
      if (base === 0x1e || base === 0x1f || base === 0x102 || base === 0x0d) {
        const len = le.u32(d, p); p += 4;
        const raw = d.subarray(p, p + len);
        p += pad(len);
        if (!v) out.set(id, base === 0x1f ? new TextDecoder('utf-16le').decode(raw).replace(/\0+$/, '') : base === 0x1e ? decodeCodepage(raw, 1252).replace(/\0+$/, '') : raw);
      } else {
        const size = base === 0x14 || base === 0x05 || base === 0x07 || base === 0x40 || base === 0x06 ? 8 : base === 0x48 ? 16 : 4;
        if (!v) out.set(id, le.u32(d, p));
        p += size;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Into a document

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** Remove <script> and <style> elements (a linear scan; an unclosed one keeps the rest). */
function stripScripts(html: string): string {
  const open = /<(script|style)\b/gi;
  let out = '', last = 0;
  for (let m; (m = open.exec(html)); ) {
    const close = new RegExp(`</${m[1]}\\s*>`, 'gi');
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(html);
    if (!c) break;
    out += html.slice(last, m.index);
    last = open.lastIndex = c.index + c[0].length;
  }
  return out + html.slice(last);
}

async function bodyBlocks(b: DocBuilder, m: Message): Promise<void> {
  if (m.html) {
    const { htmlToBlocks } = await import('../html');
    let html = m.html.replace(/(src|background)\s*=\s*(["'])(cid:[^"']+|[^"']+)\2/gi, (all, attr, q, url) => { const d = m.inline.get(url) || m.inline.get(url.replace(/^cid:/, 'cid:')); return d ? `${attr}=${q}${d}${q}` : all; });
    html = stripScripts(html);
    try { for (const node of htmlToBlocks(html)) b.block(node); return; } catch { /* fall back to text */ }
  }
  if (m.rtf && !m.text?.trim()) {
    try {
      const { importRtf } = await import('../rtf');
      const ab = m.rtf.buffer.slice(m.rtf.byteOffset, m.rtf.byteOffset + m.rtf.byteLength) as ArrayBuffer;
      (await importRtf(ab, 'body.rtf')).forEach((node) => b.block(node));
      return;
    } catch { /* plain text below */ }
  }
  const text = (m.text || '').replace(/\r\n?/g, '\n');
  for (const para of text.split(/\n/)) { b.text(para); b.endParagraph(); }
}

async function messageInto(b: DocBuilder, m: Message, withHeader: boolean): Promise<void> {
  if (withHeader) {
    b.text(m.subject || '(no subject)');
    b.endParagraph({ style: 'Title' });
    b.startTable({ style: 'Plain Table', banded: false });
    for (const [k, v] of [['From', m.from], ['To', m.to], ['Cc', m.cc], ['Date', m.date]] as const) {
      if (!v) continue;
      b.startRow();
      b.startCell({ width: 60 }); b.text(k + ':', { bold: true }); b.endParagraph(); b.endCell();
      b.startCell({ width: 400 }); b.text(v); b.endParagraph(); b.endCell();
      b.endRow();
    }
    b.endTable();
    b.rule();
  }
  await bodyBlocks(b, m);
  const files = m.attachments.filter((a) => !(a.cid && m.inline.has('cid:' + a.cid) && a.type.startsWith('image/')));
  if (files.length) {
    b.text('Attachments');
    b.endParagraph({ style: 'Heading 3' });
    for (const a of files) {
      b.text(a.name, { bold: true });
      b.text(` (${a.type}${a.size ? ', ' + fmtSize(a.size) : ''})`);
      b.endParagraph({ list: { ordered: false } });
      if (a.data && a.type.startsWith('image/') && a.size < 5e6) { b.image(`data:${a.type};base64,${bytesToBase64(a.data)}`, { width: null }); b.endParagraph(); }
    }
  }
}

/** Apple Mail .emlx: a byte count line, that many bytes of message, then a property list. */
function emlxMessage(raw: string): string {
  const m = /^(\d+)[ \t]*\r?\n/.exec(raw);
  if (!m) return raw;
  const n = parseInt(m[1], 10), body = raw.slice(m[0].length);
  if (n > 0 && n <= body.length) return body.slice(0, n);
  // A wrong count: drop a trailing property list only.
  const plist = /\r?\n<\?xml[^\n]*\r?\n(?:<!DOCTYPE plist[^\n]*\r?\n)?<plist\b[\s\S]*$/.exec(body);
  return plist ? body.slice(0, plist.index) : body;
}

/** "From " separator lines: at the start or after a blank line, "From sender date". */
const FROM_LINE = /^From \S+ +(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\d{4}-\d\d-\d\d|\S.*\d\d:\d\d)/;

/** Split an mbox mailbox into messages (unescaping ">From " lines). */
export function mboxMessages(raw: string): string[] {
  const lines = raw.split('\n');
  const msgs: string[] = [];
  let cur: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('From ') && (i === 0 || (!lines[i - 1].replace(/\r$/, '') && FROM_LINE.test(l)))) {
      if (cur) msgs.push(cur.join('\n'));
      cur = [];
      continue;
    }
    (cur ??= []).push(l);
  }
  if (cur) msgs.push(cur.join('\n'));
  return msgs.map((s) => s.replace(/^>(>*From )/gm, '$1')).filter((s) => s.trim());
}

export async function importEmail(data: ArrayBuffer, name: string, kind: string): Promise<PMNode> {
  const u8 = u8a(data);
  const b = new DocBuilder();
  b.page({ width: 612, height: 792, top: 72, bottom: 72, left: 72, right: 72 });
  if (kind === 'msg') { const m = parseMsg(u8); b.property('title', m.subject); await messageInto(b, m, true); return b.build(); }
  if (kind === 'tnef') { const m = parseTnef(u8); b.property('title', m.subject); await messageInto(b, m, true); return b.build(); }
  let raw = latin1(u8);
  if (kind === 'emlx') raw = emlxMessage(raw);
  if (kind === 'mbox') {
    const msgs = mboxMessages(raw);
    for (let i = 0; i < Math.min(msgs.length, 500); i++) {
      if (i) b.sectionBreak('nextPage');
      await messageInto(b, parseMime(msgs[i]), true);
    }
    if (msgs.length > 500) { b.text(`Only the first 500 of ${msgs.length} messages were imported.`, { italic: true }); b.endParagraph(); }
    b.property('title', name.replace(/\.[^.]+$/, ''));
    return b.build();
  }
  const m = parseMime(raw);
  if (kind === 'mhtml') {
    // A web archive: the page itself, its pictures from the related parts.
    b.property('title', m.subject || name.replace(/\.[^.]+$/, ''));
    await bodyBlocks(b, m);
    return b.build();
  }
  b.property('title', m.subject);
  await messageInto(b, m, true);
  return b.build();
}
