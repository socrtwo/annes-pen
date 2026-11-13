/**
 * Content detection for the XML, archive and text-markup formats (word processors).
 *
 * Every rule is synchronous and cheap: it looks at the leading bytes, the XML root element,
 * or the names in a ZIP central directory (read without inflating anything), and returns a
 * confidence from 0 to 1. `sniffB` picks the best rule above a threshold so a file opens with
 * the right converter whatever its extension. The rules are exported individually and as
 * SNIFF_RULES_B so a general sniffer can merge them with its own.
 */

export interface SniffRule {
  /** FORMATS id the rule selects. */
  id: string;
  /** Human-readable format name. */
  label: string;
  /** Extensions the format normally uses (lower case, no dot). */
  ext: string[];
  /** Confidence 0–1 that `bytes` (the whole file or at least its first 64 KB) is this format. */
  detect(bytes: Uint8Array, name: string): number;
}

// ---------------------------------------------------------------------------------------------
// Byte helpers

const lower = (name: string) => (name || '').toLowerCase();
const extOf = (name: string) => { const n = lower(name).replace(/\.zip$/, ''); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };

/** Latin-1 view of the first `n` bytes, skipping a UTF-8 BOM and collapsing UTF-16 to ASCII. */
export function headText(u8: Uint8Array, n = 4096): string {
  let s = u8.subarray(0, n);
  if (s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) s = s.subarray(3);
  const utf16le = (s[0] === 0xff && s[1] === 0xfe) || (s[0] === 0x3c && s[1] === 0);
  const utf16be = (s[0] === 0xfe && s[1] === 0xff) || (s[0] === 0 && s[1] === 0x3c);
  if (utf16le || utf16be) {
    let out = '';
    const start = s[0] === 0xff || s[0] === 0xfe ? 2 : 0;
    for (let i = start; i + 1 < s.length; i += 2) out += String.fromCharCode(utf16le ? s[i] | (s[i + 1] << 8) : (s[i] << 8) | s[i + 1]);
    return out;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
  return out;
}

export const isZip = (u8: Uint8Array) => u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7) && (u8[3] === 4 || u8[3] === 6 || u8[3] === 8);
export const isGzip = (u8: Uint8Array) => u8.length > 3 && u8[0] === 0x1f && u8[1] === 0x8b && u8[2] === 8;

/** Entry names of a ZIP archive, read from the central directory (falls back to scanning local headers). */
export function zipNames(u8: Uint8Array): string[] {
  const names: string[] = [];
  if (!isZip(u8)) return names;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = (a: number, b: number) => { let s = ''; for (let i = a; i < b && i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
  // End of central directory record: search backwards over the maximum comment length.
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    const count = dv.getUint16(i + 10, true);
    let p = dv.getUint32(i + 16, true);
    for (let k = 0; k < count && p + 46 <= u8.length; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      names.push(dec(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
    }
    if (names.length) return names;
    break;
  }
  // Truncated or damaged archive: walk the local file headers.
  let p = 0;
  while (p + 30 <= u8.length && names.length < 5000) {
    if (dv.getUint32(p, true) !== 0x04034b50) break;
    const flags = dv.getUint16(p + 6, true);
    const csize = dv.getUint32(p + 18, true);
    const nl = dv.getUint16(p + 26, true), el = dv.getUint16(p + 28, true);
    names.push(dec(p + 30, p + 30 + nl));
    if (flags & 8 && csize === 0) break;
    p += 30 + nl + el + csize;
  }
  return names;
}

/** Contents of a stored (uncompressed) first entry named "mimetype", as ODF/EPUB/HWPX/SXW write it. */
export function zipMimetype(u8: Uint8Array): string | null {
  if (!isZip(u8) || u8.length < 38) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const nl = dv.getUint16(26, true), el = dv.getUint16(28, true), method = dv.getUint16(8, true), size = dv.getUint32(18, true);
  let name = '';
  for (let i = 30; i < 30 + nl && i < u8.length; i++) name += String.fromCharCode(u8[i]);
  if (name !== 'mimetype' || method !== 0 || size > 200) return null;
  let s = '';
  for (let i = 30 + nl + el; i < 30 + nl + el + size && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s.trim();
}

/**
 * Index of the first character after leading whitespace, a BOM, processing instructions
 * (<?xml …?>), comments and, when `doctype` is set, a doctype. Linear: an unterminated
 * construct ends the scan.
 */
export function skipProlog(t: string, doctype = true): number {
  let i = 0;
  for (;;) {
    while (i < t.length && (t.charCodeAt(i) <= 32 || t.charCodeAt(i) === 0xfeff)) i++;
    if (t.startsWith('<?', i)) { const e = t.indexOf('?>', i + 2); if (e < 0) return t.length; i = e + 2; continue; }
    if (t.startsWith('<!--', i)) { const e = t.indexOf('-->', i + 4); if (e < 0) return t.length; i = e + 3; continue; }
    if (doctype && t.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gt = t.indexOf('>', i + 9), br = t.indexOf('[', i + 9);
      // An internal subset ([…]) may contain '>'.
      const from = br >= 0 && (gt < 0 || br < gt) ? t.indexOf(']', br) : i + 9;
      const e = from < 0 ? -1 : t.indexOf('>', from);
      if (e < 0) return t.length;
      i = e + 1;
      continue;
    }
    return i;
  }
}

/** Root element local name and the first ~4 KB of text of an XML document (BOM/UTF-16 aware). */
export function xmlRoot(u8: Uint8Array): { root: string; prefix: string; head: string } | null {
  const head = headText(u8, 8192);
  const body = head.replace(/^\s+/, '');
  if (!body.startsWith('<')) return null;
  const re = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s>/]/g;
  // Skip declarations, processing instructions, comments and the doctype.
  const stripped = body.slice(skipProlog(body));
  re.lastIndex = 0;
  const m = re.exec(stripped);
  if (!m) return null;
  return { root: m[2], prefix: (m[1] || '').replace(/:$/, ''), head };
}

// ---------------------------------------------------------------------------------------------
// XML formats

export function detectWordml2003(u8: Uint8Array): number {
  const x = xmlRoot(u8);
  if (!x) return 0;
  if (x.root === 'wordDocument' && /schemas\.microsoft\.com\/office\/word\/2003\/wordml/.test(x.head)) return 1;
  if (/<\?mso-application\s+progid="Word\.Document"\?>/i.test(x.head) && x.root !== 'package') return 0.95;
  return 0;
}

export function detectFlatOpc(u8: Uint8Array): number {
  const x = xmlRoot(u8);
  if (!x || x.root !== 'package') return 0;
  if (!/schemas\.microsoft\.com\/office\/2006\/xmlPackage/.test(x.head)) return 0;
  // Word's flat XML (pkg:package); PowerPoint/Excel flat packages carry other main parts.
  return /wordprocessingml|progid="Word\.Document"|\/word\/document\.xml/i.test(x.head) || /\/word\//.test(headText(u8, 65536)) ? 1 : 0.5;
}

export function detectFlatOdt(u8: Uint8Array): number {
  const x = xmlRoot(u8);
  if (!x || x.root !== 'document') return 0;
  return /opendocument\.text|office:mimetype="application\/vnd\.oasis\.opendocument\.text/.test(x.head) || /urn:oasis:names:tc:opendocument:xmlns:office/.test(x.head) ? 0.95 : 0;
}

export function detectFictionBook(u8: Uint8Array, name: string): number {
  if (isZip(u8)) return zipNames(u8).some((n) => /\.fb2$/i.test(n)) ? (extOf(name) === 'fbz' || /\.fb2\.zip$/i.test(name) ? 1 : 0.9) : 0;
  const x = xmlRoot(u8);
  return x && x.root === 'FictionBook' ? 1 : 0;
}

export function detectDocBook(u8: Uint8Array, name: string): number {
  const x = xmlRoot(u8);
  if (!x) return 0;
  if (/docbook\.org\/ns\/docbook/.test(x.head)) return 1;
  if (/<!DOCTYPE\s+\w+\s+PUBLIC\s+"-\/\/OASIS\/\/DTD DocBook/i.test(x.head)) return 1;
  const roots = ['article', 'book', 'chapter', 'part', 'section', 'refentry', 'set', 'sect1'];
  if (roots.includes(x.root) && !x.prefix && /<(title|para|sect1|section|chapter|info|articleinfo|bookinfo)\b/.test(x.head)) return ['dbk', 'docbook'].includes(extOf(name)) ? 0.95 : 0.7;
  return 0;
}

export function detectAbiWord(u8: Uint8Array, name: string): number {
  if (isGzip(u8)) return ['zabw', 'abw', 'awt'].includes(extOf(name)) || /\.abw\.gz$/i.test(name) ? 0.9 : 0;
  const x = xmlRoot(u8);
  if (!x) return 0;
  if (x.root === 'abiword') return 1;
  return /<!DOCTYPE\s+abiword/i.test(x.head) ? 1 : 0;
}

export function detectKWord(u8: Uint8Array, name: string): number {
  if (isZip(u8)) {
    const mt = zipMimetype(u8);
    if (mt === 'application/x-kword') return 1;
    const names = zipNames(u8);
    if (names.includes('maindoc.xml') && !names.includes('content.xml')) return extOf(name) === 'kwd' ? 1 : 0.6;
    return 0;
  }
  if (isGzip(u8)) return ['kwd', 'kwt'].includes(extOf(name)) ? 0.9 : 0; // KOffice 1.0–1.2: gzipped tar
  const x = xmlRoot(u8);
  return x && x.root === 'DOC' && /editor="KWord"|mime="application\/x-kword"/.test(x.head) ? 1 : 0;
}

export function detectStarWriter(u8: Uint8Array, name: string): number {
  if (!isZip(u8)) {
    const x = xmlRoot(u8);
    // Uncompressed StarOffice 6 / OpenOffice.org 1.x XML (office:document with the openoffice.org namespaces).
    return x && /^document(-content)?$/.test(x.root) && /http:\/\/openoffice\.org\/2000\/office/.test(x.head) ? 0.95 : 0;
  }
  const mt = zipMimetype(u8);
  if (mt && /^application\/vnd\.sun\.xml\.writer(\.template|\.global)?$/.test(mt)) return 1;
  if (['sxw', 'stw', 'sxg'].includes(extOf(name)) && zipNames(u8).includes('content.xml')) return 0.9;
  return 0;
}

export function detectHwpx(u8: Uint8Array, name: string): number {
  if (!isZip(u8)) return 0;
  const mt = zipMimetype(u8);
  if (mt === 'application/hwp+zip' || mt === 'application/haansofthwpx') return 1;
  const names = zipNames(u8);
  if (names.some((n) => /^Contents\/section\d+\.xml$/i.test(n)) && names.some((n) => /^Contents\/header\.xml$/i.test(n))) return 0.95;
  return extOf(name) === 'hwpx' ? 0.5 : 0;
}

export function detectPages(u8: Uint8Array, name: string): number {
  if (isZip(u8)) {
    const names = zipNames(u8);
    const strip = (n: string) => n.replace(/^[^/]+\.pages\//i, '');
    const n2 = names.map(strip);
    if (n2.some((n) => /^Index\/Document\.iwa$/i.test(n)) || n2.includes('Index.zip')) {
      // Keynote and Numbers use the same container: tell them apart by their characteristic parts.
      if (n2.some((n) => /^Index\/(Slide|MasterSlide|Theme)/i.test(n)) && !/\.pages$/i.test(name)) return 0;
      if (n2.some((n) => /^Index\/(CalculationEngine|Tables\/)/i.test(n)) && !n2.some((n) => /^Index\/DocumentStylesheet/i.test(n)) && !/\.pages$/i.test(name)) return 0;
      return /\.pages$/i.test(lower(name).replace(/\.zip$/, '')) ? 1 : 0.85;
    }
    if (n2.some((n) => /^index\.xml(\.gz)?$/.test(n))) {
      return /\.pages$/i.test(name) ? 1 : 0.8;
    }
    if (extOf(name) === 'pages' && n2.some((n) => /QuickLook\/Preview\.pdf$|preview\.jpg$/i.test(n))) return 0.9;
    return 0;
  }
  if (isGzip(u8)) return extOf(name) === 'pages' ? 0.6 : 0;
  const x = xmlRoot(u8);
  return x && x.root === 'document' && /apple\.com\/namespaces\/sl/.test(x.head) ? 1 : 0;
}

export function detectRtfd(u8: Uint8Array, name: string): number {
  if (!isZip(u8)) return 0;
  const names = zipNames(u8);
  const hasTxt = names.some((n) => /(^|\/)TXT\.rtf$/i.test(n));
  if (!hasTxt) return 0;
  return /\.rtfd(\.zip)?$/i.test(name) || names.some((n) => /\.rtfd\//i.test(n)) ? 1 : 0.8;
}

export function detectMhtml(u8: Uint8Array, name: string): number {
  const h = headText(u8, 8192);
  // (A header line anywhere in the head; the old nested pattern matched the same and was exponential.)
  if (!/^Content-Type:\s*multipart\/related/im.test(h.replace(/^\s+/, ''))) {
    return ['mht', 'mhtml'].includes(extOf(name)) && /Content-Type:\s*multipart\//i.test(h) ? 0.8 : 0;
  }
  return /text\/html|application\/xhtml/i.test(headText(u8, 65536)) ? 1 : 0.6;
}

// ---------------------------------------------------------------------------------------------
// Text markups (heuristic: the extension carries most of the weight)

function textish(u8: Uint8Array): boolean {
  const n = Math.min(u8.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = u8[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) bad++; }
  return n === 0 || bad / n < 0.01;
}

export function detectLatex(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  const h = headText(u8, 16384);
  const ext = extOf(name);
  const strong = /\\documentclass(\[[^\]]*\])?\{|\\documentstyle\b/.test(h);
  if (['tex', 'latex', 'ltx'].includes(ext)) return strong || /\\(section|chapter|begin)\b/.test(h) ? 1 : 0.8;
  if (strong && /\\begin\{document\}/.test(headText(u8, 1 << 20))) return 0.9;
  return 0;
}

export function detectRst(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  const ext = extOf(name);
  if (['rst', 'rest'].includes(ext)) return 1;
  const h = headText(u8, 16384);
  let score = 0;
  if (/^\.\. (\w[\w-]*::|_[^:]+:|\[\w+\])/m.test(h)) score += 0.4;
  if (/^(=+|-+|~+|\*+|\^+|#+)\r?\n[^\n]+\r?\n\1\s*$/m.test(h) || /^[^\s\n][^\n]*\r?\n(={3,}|-{3,}|~{3,}|\^{3,})\s*$/m.test(h)) score += 0.2;
  if (/:(ref|doc|math|code):`/.test(h) || /`[^`]+`_/.test(h)) score += 0.2;
  return ext === 'txt' || !ext ? Math.min(score, 0.6) : Math.min(score, 0.4);
}

export function detectTextile(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  if (extOf(name) === 'textile') return 1;
  const h = headText(u8, 16384);
  const hits = (h.match(/^(h[1-6]|p|bq|bc|fn\d+)(\([^)]*\)|\{[^}]*\}|[<>=])*\. /gm) || []).length;
  return hits >= 2 ? 0.6 : 0;
}

export function detectAsciiDoc(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  const ext = extOf(name);
  if (['adoc', 'asciidoc', 'asc'].includes(ext)) return ext === 'asc' && /^-----BEGIN PGP/m.test(headText(u8, 200)) ? 0 : 1;
  const h = headText(u8, 16384);
  let s = 0;
  if (/^= \S/m.test(h) && /^:[\w-]+:/m.test(h)) s += 0.5;
  if (/^(\[(source|NOTE|TIP|WARNING|quote|cols=)[^\]]*\]|----|====|\|===)\s*$/m.test(h)) s += 0.2;
  if (/^== \S/m.test(h)) s += 0.1;
  return Math.min(s, 0.6);
}

export function detectOrg(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  if (extOf(name) === 'org') return 1;
  const h = headText(u8, 16384);
  let s = 0;
  if (/^#\+(TITLE|AUTHOR|OPTIONS|BEGIN_SRC|STARTUP):/im.test(h)) s += 0.5;
  if (/^\*+ (TODO |DONE )?\S/m.test(h)) s += 0.1;
  return Math.min(s, 0.6);
}

export function detectTroff(u8: Uint8Array, name: string): number {
  if (!textish(u8)) return 0;
  const ext = extOf(name);
  const h = headText(u8, 16384);
  const req = (h.match(/^\.(TH|SH|SS|PP|LP|TP|IP|B|I|BR|RB|IR|RI|nf|fi|br|sp|Dd|Dt|Os|Sh|Nm|Nd|Pp|\\")\b/gm) || []).length;
  if (/^(man|mdoc|roff)$/.test(ext)) return req >= 1 ? 1 : 0.5;
  // Extensions that plain text uses too (.1, .me, .t, .n …): require request lines.
  if (/^([1-9n]|[1-9][a-z]+|tr|ms|me|mm|t)$/.test(ext)) {
    const any = (h.match(/^\.(?:[A-Za-z][A-Za-z0-9]?|\\")(?=[ \t]|\r?$)/gm) || []).length;
    return req >= 1 ? 1 : any >= 2 ? 0.7 : 0;
  }
  if (/^\.TH\s+\S+/m.test(h) || /^\.Dd\s/m.test(h)) return req >= 3 ? 0.9 : 0.6;
  return req >= 5 ? 0.5 : 0;
}

export const SNIFF_RULES_B: SniffRule[] = [
  { id: 'wordml', label: 'Word 2003 XML document', ext: ['xml', 'wml'], detect: detectWordml2003 },
  { id: 'flatopc', label: 'Word XML document (Flat OPC)', ext: ['xml'], detect: detectFlatOpc },
  { id: 'fodt', label: 'Flat OpenDocument text', ext: ['fodt', 'xml'], detect: detectFlatOdt },
  { id: 'sxw', label: 'OpenOffice.org 1.x text document', ext: ['sxw', 'stw', 'sxg'], detect: detectStarWriter },
  { id: 'abw', label: 'AbiWord document', ext: ['abw', 'zabw', 'awt'], detect: detectAbiWord },
  { id: 'kwd', label: 'KWord / Calligra Words document', ext: ['kwd', 'kwt'], detect: detectKWord },
  { id: 'pages', label: 'Apple Pages document', ext: ['pages'], detect: detectPages },
  { id: 'hwpx', label: 'Hangul HWPX document', ext: ['hwpx', 'hwpt'], detect: detectHwpx },
  { id: 'fb2', label: 'FictionBook e-book', ext: ['fb2', 'fbz'], detect: detectFictionBook },
  { id: 'docbook', label: 'DocBook document', ext: ['dbk', 'docbook', 'xml'], detect: detectDocBook },
  { id: 'rtfd', label: 'Rich Text Format with attachments (RTFD)', ext: ['rtfd'], detect: detectRtfd },
  { id: 'mhtml', label: 'Web archive (MHTML)', ext: ['mht', 'mhtml'], detect: detectMhtml },
  { id: 'latex', label: 'LaTeX document', ext: ['tex', 'latex', 'ltx'], detect: detectLatex },
  { id: 'rst', label: 'reStructuredText document', ext: ['rst', 'rest'], detect: detectRst },
  { id: 'textile', label: 'Textile document', ext: ['textile'], detect: detectTextile },
  { id: 'asciidoc', label: 'AsciiDoc document', ext: ['adoc', 'asciidoc', 'asc'], detect: detectAsciiDoc },
  { id: 'org', label: 'Org-mode document', ext: ['org'], detect: detectOrg },
  { id: 'man', label: 'troff / man page', ext: ['man', 'roff', 'mdoc', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'n'], detect: detectTroff },
];

/** Best matching format id from SNIFF_RULES_B, or null when no rule is confident enough. */
export function sniffB(data: ArrayBuffer | Uint8Array, name: string, threshold = 0.6): string | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  let best: string | null = null;
  let score = threshold;
  for (const r of SNIFF_RULES_B) {
    let s = 0;
    try { s = r.detect(u8, name); } catch { s = 0; }
    if (s > score || (s === 1 && score < 1)) { best = r.id; score = s; }
  }
  return best;
}

/**
 * The rules in the shape of a general content sniffer's registry ({ format, label, category,
 * ext, test(ctx) }), for merging with registerSniffer().
 */
export function snifferRulesB(): { format: string; label: string; category: 'document'; ext: string[]; test: (ctx: { bytes: Uint8Array; name: string }) => number }[] {
  return SNIFF_RULES_B.map((r) => ({ format: r.id, label: r.label, category: 'document' as const, ext: r.ext, test: (ctx: { bytes: Uint8Array; name: string }) => r.detect(ctx.bytes, ctx.name) }));
}

/** File-picker extensions and MIME types for these formats (for platform open dialogs). */
export const OPEN_EXTENSIONS_B = ['xml', 'wml', 'sxw', 'stw', 'sxg', 'abw', 'zabw', 'awt', 'kwd', 'kwt', 'pages', 'hwpx', 'fb2', 'fbz', 'dbk', 'docbook',
  'rtfd', 'mht', 'mhtml', 'tex', 'latex', 'ltx', 'rst', 'rest', 'textile', 'adoc', 'asciidoc', 'org', 'man', 'roff', 'mdoc', 'xhtml'];
export const OPEN_MIMES_B = ['application/xml', 'text/xml', 'application/vnd.ms-word.wordml', 'application/vnd.sun.xml.writer', 'application/x-abiword',
  'application/x-kword', 'application/vnd.apple.pages', 'application/x-iwork-pages-sffpages', 'application/hwp+zip', 'application/x-fictionbook+xml',
  'application/docbook+xml', 'multipart/related', 'message/rfc822', 'application/x-tex', 'text/x-tex', 'text/x-rst', 'text/x-textile', 'text/x-asciidoc',
  'text/x-org', 'text/troff', 'application/x-troff-man'];
