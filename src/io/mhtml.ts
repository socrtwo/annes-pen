/**
 * MHTML / MHT web archive import (RFC 2557 MIME multipart/related: Internet Explorer and
 * Word "Single File Web Page", Chrome "Save as MHTML", Opera, Outlook-saved pages).
 *
 * The MIME structure is parsed (nested multiparts, base64 / quoted-printable / 7bit / 8bit
 * bodies, charsets), the root HTML part is chosen (the "start" parameter, else the first
 * text/html part), and every reference to another part (by Content-Location — absolute or
 * relative — or cid:) is replaced with a data: URL before the page goes through the normal HTML
 * importer. Word-generated archives therefore keep their pictures, lists and footnotes.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { importHtml } from './html';
import { base64ToBytes, bytesToBase64 } from './serialize';
import { decodeAuto } from './encoding';

export interface MimePart { headers: Map<string, string>; body: Uint8Array; type: string; params: Record<string, string> }

const latin1 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000))); return s; };
const fromLatin1 = (s: string) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };

/** Parse "type/subtype; a=b; c="d"" into a type and parameters. */
export function parseContentType(v: string | undefined): { type: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  if (!v) return { type: 'text/plain', params };
  // Split on semicolons outside quotes (a linear scan; absurdly long headers are cut).
  const parts: string[] = [];
  let cur = '', quoted = false;
  for (const c of v.slice(0, 65536)) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const type = parts.shift()!.trim().toLowerCase();
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { type, params };
}

/** Decode RFC 2047 encoded words in a header value. */
function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? base64ToBytes(text) : fromLatin1(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))));
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch { return text; }
  });
}

function decodeQP(s: string): Uint8Array {
  const t = s.replace(/=[ \t]*\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Parse a MIME entity (headers + body) from latin-1 text; multiparts are flattened into leaf parts. */
export function parseMime(raw: string, out: MimePart[] = [], depth = 0): MimePart[] {
  const split = /\r?\n\r?\n/.exec(raw);
  const headText = split ? raw.slice(0, split.index) : raw;
  const bodyText = split ? raw.slice(split.index + split[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), decodeWords(line.slice(i + 1).trim()));
  }
  const { type, params } = parseContentType(headers.get('content-type'));
  if (type.startsWith('multipart/') && params.boundary) {
    if (depth > 12) return out;
    const b = '--' + params.boundary;
    const chunks = bodyText.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
    for (const ch of chunks.slice(1)) {
      const c = ch.replace(/^\r?\n/, '');
      if (!c.trim() || c.trim() === '--') continue;
      parseMime(c, out, depth + 1);
    }
    if (out.length && params.start) (out as any).start = params.start;
    return out;
  }
  const enc = (headers.get('content-transfer-encoding') || '').toLowerCase();
  let body: Uint8Array;
  if (enc === 'base64') body = base64ToBytes(bodyText.replace(/\s+/g, ''));
  else if (enc === 'quoted-printable') body = decodeQP(bodyText);
  else body = fromLatin1(bodyText);
  out.push({ headers, body, type, params });
  return out;
}

function decodeText(p: MimePart): string {
  const cs = (p.params.charset || '').toLowerCase();
  const u8 = p.body;
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (cs) { try { return new TextDecoder(cs).decode(u8); } catch { /* unknown label */ } }
  const head = latin1(u8.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head);
  if (m) { try { return new TextDecoder(m[1].toLowerCase()).decode(u8); } catch { /* ignore */ } }
  return decodeAuto(u8);
}

/** Resolve the archive into one self-contained HTML string. */
export function mhtmlToHtml(data: ArrayBuffer | Uint8Array): string {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const parts = parseMime(latin1(u8));
  if (!parts.length) throw new Error('No MIME parts found: not a web archive');
  const start = ((parts as any).start || '').replace(/^<|>$/g, '');
  const root = (start && parts.find((p) => (p.headers.get('content-id') || '').replace(/^<|>$/g, '') === start))
    || parts.find((p) => p.type === 'text/html' || p.type === 'application/xhtml+xml')
    || parts.find((p) => p.type.startsWith('text/'));
  if (!root) throw new Error('The web archive has no HTML page');
  const rootLoc = root.headers.get('content-location') || '';
  const byRef = new Map<string, MimePart>();
  for (const p of parts) {
    if (p === root) continue;
    const loc = p.headers.get('content-location');
    if (loc) {
      byRef.set(loc, p);
      try { if (rootLoc) byRef.set(new URL(loc, rootLoc).href, p); } catch { /* relative without base */ }
      byRef.set(loc.split('/').pop() || loc, p);
    }
    const cid = (p.headers.get('content-id') || '').replace(/^<|>$/g, '');
    if (cid) byRef.set('cid:' + cid, p);
  }
  const dataUrls = new Map<MimePart, string>();
  const asData = (p: MimePart): string => {
    let d = dataUrls.get(p);
    if (!d) {
      if (p.type === 'text/css') d = `data:text/css;base64,${bytesToBase64(new TextEncoder().encode(resolveCss(decodeText(p))))}`;
      else d = `data:${p.type};base64,${bytesToBase64(p.body)}`;
      dataUrls.set(p, d);
    }
    return d;
  };
  const lookup = (ref: string): MimePart | undefined => {
    const r = ref.trim().replace(/&amp;/g, '&');
    if (byRef.has(r)) return byRef.get(r);
    try { if (rootLoc) { const abs = new URL(r, rootLoc).href; if (byRef.has(abs)) return byRef.get(abs); } } catch { /* ignore */ }
    const last = r.split('/').pop() || r;
    try { return byRef.get(decodeURIComponent(last)); } catch { return byRef.get(last); }
  };
  const resolveCss = (css: string) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => { const p = lookup(ref); return p ? `url(${q}${asData(p)}${q})` : m; });
  let html = decodeText(root);
  html = html.replace(/\b(src|href|background|data|poster|lowsrc)\s*=\s*(["'])([^"']*)\2/gi, (m, a: string, q: string, ref: string) => {
    if (/^(data:|#|mailto:|javascript:)/i.test(ref)) return m;
    const p = lookup(ref);
    if (!p) return m;
    if (a.toLowerCase() === 'href' && !/^(image\/|text\/css)/.test(p.type)) return m;
    return `${a}=${q}${asData(p)}${q}`;
  });
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, css, b) => a + resolveCss(css) + b);
  // Inline linked style sheets so the HTML importer sees their rules.
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const h = /href=["']data:text\/css;base64,([^"']+)["']/i.exec(tag);
    if (!h) return tag;
    try { return `<style>${new TextDecoder().decode(base64ToBytes(h[1]))}</style>`; } catch { return tag; }
  });
  return html;
}

export async function importMhtml(data: ArrayBuffer, name: string): Promise<PMNode> {
  const html = mhtmlToHtml(data);
  const bytes = new TextEncoder().encode(html);
  return importHtml(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, name);
}
