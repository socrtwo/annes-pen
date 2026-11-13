/**
 * OpenDocument Text (.odt) and Flat ODT (.fodt) import / export.
 *
 * Export builds content.xml / styles.xml / meta.xml / manifest.xml (or a single office:document
 * for FODT): named paragraph styles for every style used (properties from effectiveStyle, heading
 * outline levels), automatic paragraph/text/list/table/section styles for direct formatting, page
 * layout and master page with header/footer fields, pictures, footnotes, comments (annotations),
 * tracked changes, bookmarks and fields.
 *
 * Import resolves named and automatic styles (parent chains, paragraph and text properties),
 * lists (bullet vs number from list styles, nesting), tables (spans, covered cells, widths),
 * frames/images, notes, annotations, bookmarks, tracked changes, fields, page layout and
 * header/footer text, and document metadata. Both formats share the same code paths.
 */
import JSZip from 'jszip';
import { loadZip } from './zip';
import { Mark, type Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { styleLevel } from '../editor/schema';
import { PAGE_SIZES, type DocSettings, type HF, type StyleDef } from '../editor/settings';
import { resolveStyles, effectiveStyle } from '../editor/styles';
import type { ExportOptions } from './index';
import {
  S, bytesToBase64, base64ToBytes, canonicalStyleName, collectFootnotes, docSettings, docTitle, escapeXml, extForMime, finishDoc,
  htmlToTextLines, imagePixelSize, inlineAtomText, isoNow, lengthToPt, listStart, makeBlob, markSet, mimeForName, newSettings, para, parseDataUrl,
  prepareDoc, r2, resolveFontName, sniffImageMime, toDataUrl, toHexColor, utf8Decode, type NoteInfo,
} from './serialize';

type Attrs = Record<string, any>;

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  xml: 'http://www.w3.org/XML/1998/namespace',
};
const PREFIX: Record<string, string> = Object.fromEntries(Object.entries(NS).map(([k, v]) => [v, k]));

const NS_DECL = Object.entries(NS).filter(([k]) => k !== 'manifest' && k !== 'xml').map(([k, v]) => `xmlns:${k}="${v}"`).join(' ');
const MIME = 'application/vnd.oasis.opendocument.text';

// =============================================================================================
// Export

const pt = (n: number | null | undefined) => `${r2(n || 0)}pt`;

/** An ODF dateTime in UTC, with its Z: without a zone readers take the time as local. */
function odfDate(v: unknown): string {
  const d = v == null || v === '' ? new Date() : new Date(v as number | string);
  return (Number.isFinite(d.getTime()) ? d : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
const x = escapeXml;

/** Encode a style name as an ODF NCName (LibreOffice style: spaces → _20_). */
export function odfName(name: string): string {
  if (name === 'Normal') return 'Standard';
  let out = '';
  for (const ch of name) {
    if (/[A-Za-z0-9_.-]/.test(ch) && ch !== '_') out += ch;
    else out += `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  if (!/^[A-Za-z_]/.test(out)) out = '_' + out;
  return out;
}

function decodeOdfName(name: string): string {
  // A name like "Memo_202401_" is not an escape: keep anything that is not a valid code point.
  return name.replace(/_([0-9a-fA-F]{2,6})_/g, (m, h) => { const cp = parseInt(h, 16); return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? m : String.fromCodePoint(cp); });
}

/** Spaces written by <text:s text:c="n"/>: n is document data (negative counts throw, huge ones exhaust memory). */
function spaceCount(el: Element): number {
  const n = parseInt(att(el, 'text', 'c') || '1', 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, 1000)) : 1;
}

const NUM_FORMAT: Record<string, string> = { decimal: '1', 'lower-alpha': 'a', 'upper-alpha': 'A', 'lower-roman': 'i', 'upper-roman': 'I', 'decimal-zero': '1' };

function borderCss2Odf(v: string | undefined | null, settings: DocSettings): string | null {
  if (!v) return null;
  const m = /([\d.]+)(px|pt)?\s+(solid|dashed|dotted|double)?\s*(.*)$/.exec(v.trim());
  if (!m) return null;
  const w = parseFloat(m[1]) * (m[2] === 'px' || !m[2] ? 0.75 : 1);
  const c = toHexColor(m[4] || '#000000', settings) || '#000000';
  return `${r2(w)}pt ${m[3] || 'solid'} ${c}`;
}

/** Paragraph styles the exporter needs that Anne's Pen has no direct equivalent for. */
const EXTRA_STYLES: Record<string, Partial<StyleDef>> = {
  'Preformatted Text': { name: 'Preformatted Text', type: 'paragraph', basedOn: 'Normal', font: 'Liberation Mono', size: 10, spaceBefore: 0, spaceAfter: 0 },
  'Horizontal Line': { name: 'Horizontal Line', type: 'paragraph', basedOn: 'Normal', size: 6, spaceAfter: 8, borderBottom: '1px solid #808080' },
};

interface ListLevel { kind: 'bullet' | 'ordered' | 'task'; format: string; bullet: string; suffix: string; start: number }

class OdtWriter {
  settings: DocSettings;
  styles: Record<string, StyleDef>;
  flat: boolean;
  notes: Map<PMNode, NoteInfo>;
  usedNamed = new Set<string>(['Normal']);
  fonts = new Set<string>();
  paraAuto = new Map<string, string>();
  textAuto = new Map<string, string>();
  autoXml: string[] = [];
  listStyles: string[] = [];
  tableStyles: string[] = [];
  sectionStyles: string[] = [];
  pictures = new Map<string, { path: string; bytes: Uint8Array; mime: string }>();
  changes: string[] = [];
  changeId = 0;
  noteId = 0;
  imageId = 0;
  tableId = 0;
  listId = 0;
  sectId = 0;
  annId = 0;
  /** Comments open across paragraphs: id -> annotation names (the comment, then its replies). */
  openComments = new Map<string, string[]>();
  /** Lists being written, outermost first, with the element the current item was opened as. */
  listLevels: { tag: string; style: string | null }[] = [];
  /** The last textblock each comment covers, where its annotation-end goes. */
  commentEnds = new Map<string, PMNode>();
  contentWidth: number;
  author: string;
  title: string;
  fileName: string;

  constructor(doc: PMNode, notes: NoteInfo[], flat: boolean, opts: ExportOptions, title: string) {
    this.settings = docSettings(doc);
    this.styles = resolveStyles(this.settings);
    this.flat = flat;
    this.notes = new Map(notes.map((n) => [n.node, n]));
    const p = this.settings.page;
    const w = p.orientation === 'landscape' ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
    this.contentWidth = Math.max(72, w - p.margin.left - p.margin.right - (p.gutter || 0));
    this.author = this.settings.properties.author || opts.author || '';
    this.title = title;
    this.fileName = opts.fileName || '';
    this.fonts.add(resolveFontName('+body', this.settings) || 'Carlito');
    this.fonts.add(resolveFontName('+heading', this.settings) || 'Carlito');
    doc.descendants((n) => {
      if (!n.isTextblock) return true;
      n.forEach((c) => { for (const m of c.marks) if (m.type.name === 'comment') this.commentEnds.set(m.attrs.id, n); });
      return false;
    });
  }

  private closeComment(id: string): string {
    const names = this.openComments.get(id) || [];
    this.openComments.delete(id);
    return names.map((n) => `<office:annotation-end office:name="${n}"/>`).join('');
  }

  eff(name: string): StyleDef { return effectiveStyle(this.styles, this.styles[name] ? name : 'Normal'); }

  useStyle(name: string): string {
    if (EXTRA_STYLES[name]) { this.usedNamed.add(name); return odfName(name); }
    const n = this.styles[name] ? name : 'Normal';
    let cur: string | undefined = n;
    let guard = 0;
    while (cur && !this.usedNamed.has(cur) && guard++ < 20) { this.usedNamed.add(cur); cur = this.styles[cur]?.basedOn; }
    return odfName(n);
  }

  // ---------------------------------------------------------------- property serialization

  paraProps(a: Attrs): string {
    const out: string[] = [];
    if (a.align) out.push(`fo:text-align="${a.align === 'left' ? 'start' : a.align === 'right' ? 'end' : a.align === 'distribute' ? 'justify' : a.align}"`);
    if (a.align === 'distribute') out.push('fo:text-align-last="justify"');
    if (a.indentLeft != null) out.push(`fo:margin-left="${pt(a.indentLeft)}"`);
    if (a.indentRight != null) out.push(`fo:margin-right="${pt(a.indentRight)}"`);
    if (a.indentFirst != null) out.push(`fo:text-indent="${pt(a.indentFirst)}"`);
    if (a.spaceBefore != null) out.push(`fo:margin-top="${pt(a.spaceBefore)}"`);
    if (a.spaceAfter != null) out.push(`fo:margin-bottom="${pt(a.spaceAfter)}"`);
    if (a.lineHeight) {
      const v = String(a.lineHeight);
      if (/^\d+(\.\d+)?$/.test(v)) out.push(`fo:line-height="${Math.round(parseFloat(v) * 100)}%"`);
      else if (v.startsWith('atleast:')) out.push(`style:line-height-at-least="${pt(parseFloat(v.slice(8)))}"`);
      else if (Number.isFinite(parseFloat(v))) out.push(`fo:line-height="${pt(parseFloat(v))}"`);
    }
    if (a.keepNext) out.push('fo:keep-with-next="always"');
    if (a.keepLines) out.push('fo:keep-together="always"');
    if (a.pageBreakBefore) out.push('fo:break-before="page"');
    if (a.widowControl === false) out.push('fo:widows="0" fo:orphans="0"');
    const bg = toHexColor(a.bg, this.settings);
    if (bg) out.push(`fo:background-color="${bg}"`);
    if (a.borderBottom) { const b = borderCss2Odf(a.borderBottom, this.settings); if (b) out.push(`fo:border-bottom="${b}" fo:padding-bottom="1pt"`); }
    if (a.borderTop) { const b = borderCss2Odf(a.borderTop, this.settings); if (b) out.push(`fo:border-top="${b}" fo:padding-top="1pt"`); }
    if (a.borderLeft) { const b = borderCss2Odf(a.borderLeft, this.settings); if (b) out.push(`fo:border-left="${b}" fo:padding-left="6pt"`); }
    if (a.border) {
      try {
        const b = JSON.parse(a.border);
        for (const side of ['top', 'right', 'bottom', 'left']) if (b[side]) { const v = borderCss2Odf(b[side], this.settings); if (v) out.push(`fo:border-${side}="${v}"`); }
      } catch { /* ignore */ }
    }
    if (a.dir === 'rtl') out.push('style:writing-mode="rl-tb"');
    return out.join(' ');
  }

  fontDecl(family: string): string {
    this.fonts.add(family);
    return `style:font-name="${x(family)}" fo:font-family="${x(/\s/.test(family) ? `'${family}'` : family)}"`;
  }

  textPropsFromStyle(e: StyleDef): string {
    const out: string[] = [];
    const f = resolveFontName(e.font, this.settings);
    if (f) out.push(this.fontDecl(f));
    if (e.size) out.push(`fo:font-size="${pt(e.size)}" style:font-size-asian="${pt(e.size)}" style:font-size-complex="${pt(e.size)}"`);
    if (e.bold !== undefined) out.push(`fo:font-weight="${e.bold ? 'bold' : 'normal'}" style:font-weight-asian="${e.bold ? 'bold' : 'normal'}" style:font-weight-complex="${e.bold ? 'bold' : 'normal'}"`);
    if (e.italic !== undefined) out.push(`fo:font-style="${e.italic ? 'italic' : 'normal'}" style:font-style-asian="${e.italic ? 'italic' : 'normal'}" style:font-style-complex="${e.italic ? 'italic' : 'normal'}"`);
    if (e.underline) out.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
    const c = toHexColor(e.color, this.settings);
    if (c) out.push(`fo:color="${c}"`);
    if (e.caps) out.push('fo:text-transform="uppercase"');
    if (e.smallCaps) out.push('fo:font-variant="small-caps"');
    if (e.spacing) out.push(`fo:letter-spacing="${pt(e.spacing)}"`);
    return out.join(' ');
  }

  textPropsFromMarks(marks: readonly Mark[]): string {
    const out: string[] = [];
    for (const m of marks) {
      const a = m.attrs;
      switch (m.type.name) {
        case 'bold': out.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"'); break;
        case 'italic': out.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"'); break;
        case 'underline': {
          const st: Record<string, string> = { single: 'solid', double: 'solid', dotted: 'dotted', dashed: 'dash', wavy: 'wave', thick: 'solid', words: 'solid', dotDash: 'dot-dash', dotDotDash: 'dot-dot-dash' };
          let s = `style:text-underline-style="${st[a.style] || 'solid'}" style:text-underline-width="${a.style === 'thick' ? 'bold' : 'auto'}"`;
          if (a.style === 'double') s += ' style:text-underline-type="double"';
          if (a.style === 'words') s += ' style:text-underline-mode="skip-white-space"';
          const c = toHexColor(a.color, this.settings);
          s += ` style:text-underline-color="${c || 'font-color'}"`;
          out.push(s);
          break;
        }
        case 'strike': out.push('style:text-line-through-style="solid" style:text-line-through-type="single"'); break;
        case 'dstrike': out.push('style:text-line-through-style="solid" style:text-line-through-type="double"'); break;
        case 'sup': out.push('style:text-position="super 58%"'); break;
        case 'sub': out.push('style:text-position="sub 58%"'); break;
        case 'position': { const p = Number(a.pt) || 0; out.push(`style:text-position="${Math.round(p * 8)}% 100%"`); break; }
        case 'smallcaps': out.push('fo:font-variant="small-caps"'); break;
        case 'allcaps': out.push('fo:text-transform="uppercase"'); break;
        case 'hidden': out.push('text:display="none"'); break;
        case 'code': out.push(this.fontDecl('Liberation Mono')); break;
        case 'font': out.push(this.fontDecl(String(a.family || 'Carlito'))); break;
        case 'size': out.push(`fo:font-size="${pt(Number(a.pt))}" style:font-size-asian="${pt(Number(a.pt))}" style:font-size-complex="${pt(Number(a.pt))}"`); break;
        case 'color': { const c = toHexColor(a.color, this.settings); if (c) out.push(`fo:color="${c}"`); break; }
        case 'highlight': case 'shading': { const c = toHexColor(a.color || '#ffff00', this.settings); if (c) out.push(`fo:background-color="${c}"`); break; }
        case 'spacing': out.push(`fo:letter-spacing="${pt(Number(a.pt))}"`); break;
        case 'scale': if (a.pct && a.pct !== 100) out.push(`style:text-scale="${Math.round(a.pct)}%"`); break;
        case 'lang': {
          const [lang, country] = String(a.lang || '').split('-');
          if (lang) out.push(`fo:language="${x(lang)}"${country ? ` fo:country="${x(country.toUpperCase())}"` : ''}`);
          break;
        }
        case 'charBorder': out.push('fo:border="0.5pt solid #000000" fo:padding="0.5pt"'); break;
        case 'dir': break;
        default: break;
      }
    }
    // De-duplicate attributes (later wins)
    const seen = new Map<string, string>();
    for (const chunk of out) {
      const re = /([\w:-]+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(chunk))) seen.set(m[1], m[2]);
    }
    return [...seen.entries()].map(([k, v]) => `${k}="${v}"`).join(' ');
  }

  textStyle(marks: readonly Mark[]): string | null {
    const props = this.textPropsFromMarks(marks.filter((m) => !['link', 'comment', 'insertion', 'deletion', 'formatChange', 'mergeHighlight', 'charStyle'].includes(m.type.name)));
    if (!props) return null;
    let name = this.textAuto.get(props);
    if (!name) {
      name = `T${this.textAuto.size + 1}`;
      this.textAuto.set(props, name);
      this.autoXml.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${props}/></style:style>`);
    }
    return name;
  }

  paraStyle(node: { attrs: Attrs } | null, extra: { breakBefore?: boolean; styleName?: string } = {}): string {
    const a = node ? { ...node.attrs } : {};
    const styleName = extra.styleName || (a.style as string) || 'Normal';
    const named = this.useStyle(styleName);
    if (extra.breakBefore) a.pageBreakBefore = true;
    const direct: Attrs = {};
    for (const k of ['align', 'indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter', 'lineHeight', 'bg', 'border', 'dir']) if (a[k] != null) direct[k] = a[k];
    if (a.keepNext) direct.keepNext = true;
    if (a.keepLines) direct.keepLines = true;
    if (a.pageBreakBefore) direct.pageBreakBefore = true;
    if (a.widowControl === false) direct.widowControl = false;
    const props = this.paraProps(direct);
    if (!props) return named;
    const key = named + '|' + props;
    let name = this.paraAuto.get(key);
    if (!name) {
      name = `P${this.paraAuto.size + 1}`;
      this.paraAuto.set(key, name);
      this.autoXml.push(`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${named}"><style:paragraph-properties ${props}/></style:style>`);
    }
    return name;
  }

  // ---------------------------------------------------------------- inline content

  text(s: string, atStart: { v: boolean }): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') {
        let n = 1;
        while (s[i + n] === ' ') n++;
        if (atStart.v) out += n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`;
        else out += ' ' + (n > 1 ? (n === 2 ? '<text:s/>' : `<text:s text:c="${n - 1}"/>`) : '');
        i += n;
        atStart.v = false;
        continue;
      }
      if (ch === '\t') { out += '<text:tab/>'; i++; atStart.v = false; continue; }
      if (ch === '\n') { out += '<text:line-break/>'; i++; atStart.v = true; continue; }
      let j = i;
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n') j++;
      out += x(s.slice(i, j));
      i = j;
      atStart.v = false;
    }
    return out;
  }

  picture(src: string): { href: string; bytes: Uint8Array | null; mime: string } | null {
    const d = parseDataUrl(src);
    if (!d) return src ? { href: src, bytes: null, mime: mimeForName(src) } : null;
    // The data URL's own type is document data: keep it only when it is a plain image type.
    const mime = sniffImageMime(d.bytes) || (/^image\/[\w.+-]+$/.test(d.mime) ? d.mime : 'application/octet-stream');
    let pic = this.pictures.get(src);
    if (!pic) {
      pic = { path: `Pictures/image${this.pictures.size + 1}.${extForMime(mime)}`, bytes: d.bytes, mime };
      this.pictures.set(src, pic);
    }
    return { href: pic.path, bytes: pic.bytes, mime };
  }

  image(node: PMNode): string {
    const a = node.attrs;
    const pic = this.picture(a.src);
    if (!pic) return '';
    let w = a.width as number | null, h = a.height as number | null;
    const px = pic.bytes ? imagePixelSize(pic.bytes) : null;
    if (!w && !h) { w = px ? px.w * 0.75 : 100; h = px ? px.h * 0.75 : 75; }
    else if (w && !h) h = px ? (w * px.h) / Math.max(1, px.w) : w * 0.75;
    else if (h && !w) w = px ? (h * px.w) / Math.max(1, px.h) : h * 1.33;
    const id = ++this.imageId;
    let anchor = 'as-char', style = 'fr1';
    if (a.wrap === 'left' || a.wrap === 'right' || a.wrap === 'center') { anchor = 'char'; style = `fr_${a.wrap}`; }
    const img = this.flat && pic.bytes
      ? `<draw:image><office:binary-data>${bytesToBase64(pic.bytes)}</office:binary-data></draw:image>`
      : `<draw:image xlink:href="${x(pic.href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"${pic.bytes ? ` draw:mime-type="${x(pic.mime)}"` : ''}/>`;
    const title = a.title ? `<svg:title>${x(a.title)}</svg:title>` : '';
    const desc = a.alt ? `<svg:desc>${x(a.alt)}</svg:desc>` : '';
    return `<draw:frame draw:style-name="${style}" draw:name="Image${id}" text:anchor-type="${anchor}" svg:width="${pt(w)}" svg:height="${pt(h)}" draw:z-index="${id}">${img}${title}${desc}</draw:frame>`;
  }

  field(node: PMNode): string {
    const a = node.attrs;
    const v = x(String(a.value || ''));
    const nf: Record<string, string> = { roman: 'i', ROMAN: 'I', alphabetic: 'a', ALPHABETIC: 'A', Arabic: '1' };
    switch (String(a.type || '').toUpperCase()) {
      case 'PAGE': return `<text:page-number text:select-page="current"${a.format && nf[a.format] ? ` style:num-format="${nf[a.format]}"` : ''}>${v || '1'}</text:page-number>`;
      case 'NUMPAGES': return `<text:page-count>${v || '1'}</text:page-count>`;
      case 'DATE': case 'CREATEDATE': case 'SAVEDATE': case 'PRINTDATE': return `<text:date>${v}</text:date>`;
      case 'TIME': return `<text:time>${v}</text:time>`;
      case 'AUTHOR': return `<text:initial-creator>${v}</text:initial-creator>`;
      case 'TITLE': return `<text:title>${v}</text:title>`;
      case 'SUBJECT': return `<text:subject>${v}</text:subject>`;
      case 'KEYWORDS': return `<text:keywords>${v}</text:keywords>`;
      case 'COMMENTS': return `<text:description>${v}</text:description>`;
      case 'FILENAME': return `<text:file-name text:display="name-and-extension">${v}</text:file-name>`;
      case 'NUMWORDS': return `<text:word-count>${v}</text:word-count>`;
      case 'NUMCHARS': return `<text:character-count>${v}</text:character-count>`;
      case 'SEQ': return `<text:sequence text:name="${x(a.arg || 'Figure')}" text:formula="ooow:${x(a.arg || 'Figure')}+1" style:num-format="${nf[a.format] || '1'}">${v}</text:sequence>`;
      case 'REF': return `<text:bookmark-ref text:reference-format="text" text:ref-name="${x(a.arg || '')}">${v}</text:bookmark-ref>`;
      case 'PAGEREF': return `<text:bookmark-ref text:reference-format="page" text:ref-name="${x(a.arg || '')}">${v}</text:bookmark-ref>`;
      default: return v;
    }
  }

  note(node: PMNode): string {
    const a = node.attrs;
    const info = this.notes.get(node);
    const id = ++this.noteId;
    const cls = a.kind === 'end' ? 'endnote' : 'footnote';
    const style = this.useStyle(a.kind === 'end' ? 'Endnote Text' : 'Footnote Text');
    const label = info?.label || String(id);
    const cit = a.mark ? `<text:note-citation text:label="${x(a.mark)}">${x(a.mark)}</text:note-citation>` : `<text:note-citation>${x(label)}</text:note-citation>`;
    const body = String(a.text || '').split('\n').map((p) => `<text:p text:style-name="${style}">${this.text(p, { v: true })}</text:p>`).join('');
    return `<text:note text:id="ftn${id}" text:note-class="${cls}">${cit}<text:note-body>${body || `<text:p text:style-name="${style}"/>`}</text:note-body></text:note>`;
  }

  atom(node: PMNode): string {
    switch (node.type.name) {
      case 'hard_break': return '<text:line-break/>';
      case 'image': return this.image(node);
      case 'footnote': return this.note(node);
      case 'field': return this.field(node);
      case 'bookmark': return node.attrs.name ? `<text:bookmark text:name="${x(node.attrs.name)}"/>` : '';
      case 'index_entry': {
        const a = node.attrs;
        if (!a.term) return '';
        return a.sub ? `<text:alphabetical-index-mark text:key1="${x(a.term)}" text:string-value="${x(a.sub)}"/>` : `<text:alphabetical-index-mark text:string-value="${x(a.term)}"/>`;
      }
      default: return this.text(inlineAtomText(node), { v: false });
    }
  }

  changeRegion(kind: 'insertion' | 'deletion', m: Mark, deleted?: string): string {
    const id = `ct${++this.changeId}`;
    // UTC with its Z (xsd:dateTime): without a zone readers take the time as local.
    const date = odfDate(m.attrs.date);
    const info = `<office:change-info><dc:creator>${x(m.attrs.author || 'Unknown')}</dc:creator><dc:date>${date}</dc:date></office:change-info>`;
    const body = kind === 'deletion' ? `<text:deletion>${info}<text:p>${this.text(deleted || '', { v: true })}</text:p></text:deletion>` : `<text:insertion>${info}</text:insertion>`;
    this.changes.push(`<text:changed-region text:id="${id}">${body}</text:changed-region>`);
    return id;
  }

  inline(node: PMNode): string {
    let out = '';
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(c));
    const atStart = { v: true };
    const openComments = this.openComments;
    let openIns: { mark: Mark; id: string } | null = null;
    const comments = this.settings.comments || {};
    let i = 0;
    const closeIns = () => { if (openIns) { out += `<text:change-end text:change-id="${openIns.id}"/>`; openIns = null; } };
    while (i < kids.length) {
      const k = kids[i];
      // Comments
      const cms = k.marks.filter((m) => m.type.name === 'comment');
      for (const cid of [...openComments.keys()]) if (!cms.some((m) => m.attrs.id === cid)) out += this.closeComment(cid);
      for (const m of cms) {
        if (openComments.has(m.attrs.id)) continue;
        const name = `__Annotation__${++this.annId}`;
        const c = comments[m.attrs.id];
        // Replies are annotations of their own over the same range (as LibreOffice writes them).
        const resolved = c?.resolved ? ' loext:resolved="true"' : '';
        const body = (t: string) => t.split('\n').map((l) => `<text:p>${this.text(l, { v: true })}</text:p>`).join('');
        out += `<office:annotation office:name="${name}"${resolved}><dc:creator>${x(c?.author || this.author || 'Unknown')}</dc:creator><dc:date>${odfDate(c?.date)}</dc:date>${body(c?.text || '')}</office:annotation>`;
        const names = [name];
        for (const r of c?.replies || []) {
          const rn = `${name}_r${names.length}`;
          names.push(rn);
          out += `<office:annotation office:name="${rn}" loext:parent-name="${name}"${resolved}><dc:creator>${x(r.author || 'Unknown')}</dc:creator><dc:date>${odfDate(r.date)}</dc:date>${body(r.text || '')}</office:annotation>`;
        }
        openComments.set(m.attrs.id, names);
      }
      // Deletions (tracked)
      const del = k.marks.find((m) => m.type.name === 'deletion');
      if (del) {
        closeIns();
        let t = '';
        while (i < kids.length && kids[i].marks.some((m) => m.eq(del))) { t += kids[i].isText ? kids[i].text : inlineAtomText(kids[i]); i++; }
        out += `<text:change text:change-id="${this.changeRegion('deletion', del, t)}"/>`;
        continue;
      }
      const ins = k.marks.find((m) => m.type.name === 'insertion');
      if (openIns && (!ins || !ins.eq(openIns.mark))) closeIns();
      if (ins && !openIns) { const id = this.changeRegion('insertion', ins); out += `<text:change-start text:change-id="${id}"/>`; openIns = { mark: ins, id }; }
      // Links group consecutive nodes
      const link = k.marks.find((m) => m.type.name === 'link');
      if (link) {
        let inner = '';
        const review = (n: PMNode) => n.marks.filter((m) => m.type.name === 'comment' || m.type.name === 'insertion');
        const base = review(k);
        let first = true;
        while (i < kids.length) {
          const kk = kids[i];
          if (!kk.marks.some((m) => m.eq(link)) || kk.marks.some((m) => m.type.name === 'deletion')) break;
          const rv = review(kk);
          if (!first && (rv.length !== base.length || rv.some((m, j) => !m.eq(base[j])))) break;
          inner += this.run(kk, atStart);
          first = false;
          i++;
        }
        out += `<text:a xlink:type="simple" xlink:href="${x(link.attrs.href || '')}"${link.attrs.title ? ` office:title="${x(link.attrs.title)}"` : ''}>${inner}</text:a>`;
        continue;
      }
      out += this.run(k, atStart);
      i++;
    }
    closeIns();
    // A comment that goes on in a later paragraph stays open.
    for (const cid of [...openComments.keys()]) if (this.commentEnds.get(cid) === node || !this.commentEnds.has(cid)) out += this.closeComment(cid);
    return out;
  }

  run(n: PMNode, atStart: { v: boolean }): string {
    const body = n.isText ? this.text(n.text || '', atStart) : this.atom(n);
    if (!n.isText) atStart.v = false;
    if (!body) return '';
    const st = this.textStyle(n.marks);
    return st ? `<text:span text:style-name="${st}">${body}</text:span>` : body;
  }

  paragraph(node: PMNode, breakBefore = false, extraPrefix = ''): string {
    const style = this.paraStyle(node, { breakBefore });
    const lvl = styleLevel(node.attrs.style, node.attrs.outlineLevel);
    const content = extraPrefix + this.inline(node);
    if (lvl > 0) return `<text:h text:style-name="${style}" text:outline-level="${Math.min(10, lvl)}">${content}</text:h>`;
    return content ? `<text:p text:style-name="${style}">${content}</text:p>` : `<text:p text:style-name="${style}"/>`;
  }

  simplePara(text: string, styleName = 'Normal', breakBefore = false, attrs: Attrs = {}): string {
    const st = this.paraStyle({ attrs: { ...attrs, style: styleName } }, { breakBefore });
    const body = this.text(text, { v: true });
    return body ? `<text:p text:style-name="${st}">${body}</text:p>` : `<text:p text:style-name="${st}"/>`;
  }

  listStyle(node: PMNode): { name: string; levels: ListLevel[] } {
    const levels: ListLevel[] = [];
    const visit = (list: PMNode, depth: number) => {
      if (depth > 9) return;
      if (!levels[depth]) {
        levels[depth] = list.type === S.nodes.ordered_list
          ? { kind: 'ordered', format: list.attrs.format || 'decimal', bullet: '', suffix: list.attrs.suffix ?? '.', start: Math.max(1, listStart(list.attrs.order)) }
          : list.type === S.nodes.task_list ? { kind: 'task', format: '', bullet: '', suffix: '', start: 1 }
            : { kind: 'bullet', format: '', bullet: ({ disc: '•', circle: '◦', square: '▪', none: '' } as Record<string, string>)[list.attrs.bullet] ?? String(list.attrs.bullet || '•').slice(0, 2), suffix: '', start: 1 };
      }
      list.forEach((it) => it.forEach((b) => { if (b.type === S.nodes.bullet_list || b.type === S.nodes.ordered_list || b.type === S.nodes.task_list) visit(b, depth + 1); }));
    };
    visit(node, 0);
    const name = `L${++this.listId}`;
    const dflt = ['•', '◦', '▪'];
    const lv: string[] = [];
    for (let d = 0; d < 10; d++) {
      const l = levels[d] || { kind: 'bullet', format: '', bullet: dflt[d % 3], suffix: '', start: 1 };
      levels[d] = l;
      const ind = 18 * (d + 1) + 18;
      const props = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${pt(ind)}" fo:text-indent="-18pt" fo:margin-left="${pt(ind)}"/></style:list-level-properties>`;
      if (l.kind === 'ordered') lv.push(`<text:list-level-style-number text:level="${d + 1}" style:num-suffix="${x(l.suffix)}" style:num-format="${NUM_FORMAT[l.format] || '1'}"${l.start !== 1 ? ` text:start-value="${l.start}"` : ''}>${props}</text:list-level-style-number>`);
      else if (l.kind === 'task' || !l.bullet) lv.push(`<text:list-level-style-number text:level="${d + 1}" style:num-format="">${props}</text:list-level-style-number>`);
      else lv.push(`<text:list-level-style-bullet text:level="${d + 1}" text:bullet-char="${x(l.bullet)}">${props}</text:list-level-style-bullet>`);
    }
    this.listStyles.push(`<text:list-style style:name="${name}">${lv.join('')}</text:list-style>`);
    return { name, levels };
  }

  list(node: PMNode, top: boolean): string {
    const ls = top ? this.listStyle(node) : null;
    const items: string[] = [];
    let first = true;
    const level = { tag: 'text:list-item', style: ls?.name ?? null };
    this.listLevels.push(level);
    node.forEach((item) => {
      let body = '';
      let firstPara = true;
      level.tag = 'text:list-item';
      const checked = node.type === S.nodes.task_list ? !!item.attrs.checked : item.attrs.checked;
      item.forEach((b) => {
        if (b.type === S.nodes.paragraph && firstPara) {
          firstPara = false;
          body += this.paragraph(b, false, checked == null ? '' : x(checked ? '☑ ' : '☐ '));
          return;
        }
        firstPara = false;
        if (b.type === S.nodes.bullet_list || b.type === S.nodes.ordered_list || b.type === S.nodes.task_list) body += this.list(b, false);
        else if (b.type === S.nodes.table || b.type === S.nodes.column_section) body += this.outsideList(b);
        else body += this.block(b, null);
      });
      const order = Math.max(1, listStart(node.attrs.order)); // text:start-value is a positive integer
      const start = first && node.type === S.nodes.ordered_list && order !== 1 ? ` text:start-value="${order}"` : '';
      first = false;
      items.push(`<text:list-item${start}>${body}</${level.tag}>`);
    });
    this.listLevels.pop();
    return `<text:list${ls ? ` text:style-name="${ls.name}"` : ''}>${items.join('')}</text:list>`;
  }

  /**
   * A list item may hold only paragraphs, headings and lists: a table (or section) closes the open
   * lists, follows them, and the lists go on (numbering continued) with an unnumbered header item.
   */
  outsideList(b: PMNode): string {
    const levels = this.listLevels;
    let out = '';
    for (let i = levels.length - 1; i >= 0; i--) out += `</${levels[i].tag}></text:list>`;
    this.listLevels = [];
    out += this.block(b, null);
    this.listLevels = levels;
    for (const l of levels) {
      out += `<text:list${l.style ? ` text:style-name="${l.style}"` : ''} text:continue-numbering="true"><text:list-header>`;
      l.tag = 'text:list-header';
    }
    return out;
  }

  table(node: PMNode): string {
    let map: TableMap;
    try { map = TableMap.get(node); } catch { return ''; }
    const W = map.width;
    const id = ++this.tableId;
    const tname = `Table${id}`;
    const widths: (number | null)[] = Array(W).fill(null);
    for (let r = 0; r < map.height; r++) for (let c = 0; c < W; c++) {
      const pos = map.map[r * W + c];
      const rect = map.findCell(pos);
      if (rect.top !== r || rect.left !== c) continue;
      const cw = node.nodeAt(pos)?.attrs.colwidth as number[] | null;
      if (cw) cw.forEach((px, k) => { if (px && widths[c + k] == null) widths[c + k] = px * 0.75; });
    }
    const known = widths.filter((w) => w != null) as number[];
    const rest = W - known.length;
    const remain = Math.max(rest * 24, this.contentWidth - known.reduce((a, b) => a + b, 0));
    for (let c = 0; c < W; c++) if (widths[c] == null) widths[c] = rest ? remain / rest : this.contentWidth / W;
    const total = (widths as number[]).reduce((a, b) => a + b, 0);
    const align = node.attrs.align === 'center' ? 'center' : node.attrs.align === 'right' ? 'right' : 'margins';
    const tAlign = align === 'margins' && Math.abs(total - this.contentWidth) > 2 ? 'left' : align;
    this.tableStyles.push(`<style:style style:name="${tname}" style:family="table"><style:table-properties style:width="${pt(total)}" table:align="${tAlign}"${node.attrs.indent ? ` fo:margin-left="${pt(node.attrs.indent)}"` : ''}/></style:style>`);
    const cols = (widths as number[]).map((w, c) => {
      const cs = `${tname}.C${c + 1}`;
      this.tableStyles.push(`<style:style style:name="${cs}" style:family="table-column"><style:table-column-properties style:column-width="${pt(w)}"/></style:style>`);
      return `<table:table-column table:style-name="${cs}"/>`;
    }).join('');
    const ts = this.styles[node.attrs.style] || ({} as StyleDef);
    const bc = toHexColor(ts.borderColor || '#000000', this.settings) || '#000000';
    const borders = ts.borders || 'all';
    const cellStyles = new Map<string, string>();
    const cellStyle = (r: number, c: number, cell: PMNode) => {
      const b = `0.5pt solid ${bc}`;
      const props: string[] = ['fo:padding="2.75pt"'];
      if (borders === 'all') props.push(`fo:border="${b}"`);
      else if (borders === 'horizontal') props.push(`fo:border-top="${b}" fo:border-bottom="${b}" fo:border-left="none" fo:border-right="none"`);
      else if (borders === 'outer') props.push(`fo:border-top="${r === 0 ? b : 'none'}" fo:border-bottom="${r === map.height - 1 ? b : 'none'}" fo:border-left="${c === 0 ? b : 'none'}" fo:border-right="${c === W - 1 ? b : 'none'}"`);
      else props.push('fo:border="none"');
      const bg = toHexColor(cell.attrs.background, this.settings);
      if (bg) props.push(`fo:background-color="${bg}"`);
      const va = cell.attrs.valign;
      if (va) props.push(`style:vertical-align="${va === 'center' ? 'middle' : va}"`);
      const key = props.join(' ');
      let name = cellStyles.get(key);
      if (!name) {
        name = `${tname}.S${cellStyles.size + 1}`;
        cellStyles.set(key, name);
        this.tableStyles.push(`<style:style style:name="${name}" style:family="table-cell"><style:table-cell-properties ${key}/></style:style>`);
      }
      return name;
    };
    const rowsXml: string[] = [];
    for (let r = 0; r < map.height; r++) {
      let row = '';
      for (let c = 0; c < W; c++) {
        const pos = map.map[r * W + c];
        const rect = map.findCell(pos);
        if (rect.top !== r || rect.left !== c) { row += '<table:covered-table-cell/>'; continue; }
        const cell = node.nodeAt(pos)!;
        const cs = rect.right - rect.left, rs = rect.bottom - rect.top;
        let content = '';
        cell.forEach((b) => { content += this.block(b, null); });
        row += `<table:table-cell table:style-name="${cellStyle(r, c, cell)}" office:value-type="string"${cs > 1 ? ` table:number-columns-spanned="${cs}"` : ''}${rs > 1 ? ` table:number-rows-spanned="${rs}"` : ''}>${content || `<text:p text:style-name="${this.useStyle('Normal')}"/>`}</table:table-cell>`;
      }
      rowsXml.push(`<table:table-row>${row}</table:table-row>`);
    }
    const hr = Math.min(node.attrs.headerRows || 0, rowsXml.length);
    const head = hr ? `<table:table-header-rows>${rowsXml.slice(0, hr).join('')}</table:table-header-rows>` : '';
    return `<table:table table:name="${tname}" table:style-name="${tname}">${cols}${head}${rowsXml.slice(hr).join('')}</table:table>`;
  }

  block(node: PMNode, next: PMNode | null, pendingBreak = { v: false }): string {
    const t = node.type.name;
    const brk = pendingBreak.v;
    switch (t) {
      case 'paragraph': pendingBreak.v = false; return this.paragraph(node, brk);
      case 'code_block': {
        pendingBreak.v = false;
        return node.textContent.split('\n').map((l, i) => this.simplePara(l, 'Preformatted Text', brk && i === 0)).join('');
      }
      case 'horizontal_rule': pendingBreak.v = false; return this.simplePara('', 'Horizontal Line', brk);
      case 'page_break': case 'section_break': {
        if (t === 'section_break' && node.attrs.kind === 'continuous') return '';
        if (next && (next.type === S.nodes.paragraph || next.type === S.nodes.code_block || next.type === S.nodes.horizontal_rule)) { pendingBreak.v = true; return ''; }
        pendingBreak.v = false;
        return this.simplePara('', 'Normal', true);
      }
      case 'column_break': return '';
      case 'math_block': pendingBreak.v = false; return this.simplePara(node.attrs.latex || '', 'Normal', brk, { align: 'center' });
      case 'gen_block': {
        pendingBreak.v = false;
        const lines = htmlToTextLines(node.attrs.cache || '');
        return lines.map((l, i) => this.simplePara(l, 'Normal', brk && i === 0)).join('');
      }
      case 'bullet_list': case 'ordered_list': case 'task_list': {
        let pre = '';
        if (brk) { pre = this.simplePara('', 'Normal', true); pendingBreak.v = false; }
        return pre + this.list(node, true);
      }
      case 'table': {
        let pre = '';
        if (brk) { pre = this.simplePara('', 'Normal', true); pendingBreak.v = false; }
        return pre + this.table(node);
      }
      case 'column_section': {
        const name = `Sect${++this.sectId}`;
        const cols = Math.max(1, node.attrs.count || 2);
        this.sectionStyles.push(`<style:style style:name="${name}" style:family="section"><style:section-properties text:dont-balance-text-columns="false"><style:columns fo:column-count="${cols}" fo:column-gap="${pt(node.attrs.gap ?? 36)}">${node.attrs.rule ? '<style:column-sep style:width="0.5pt" style:color="#000000" style:height="100%"/>' : ''}</style:columns></style:section-properties></style:style>`);
        return `<text:section text:style-name="${name}" text:name="Section${this.sectId}">${this.children(node, pendingBreak)}</text:section>`;
      }
      default:
        if (node.isLeaf) return '';
        return this.children(node, pendingBreak);
    }
  }

  children(node: PMNode, pendingBreak = { v: false }): string {
    let s = '';
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(c));
    kids.forEach((c, i) => { s += this.block(c, kids[i + 1] || null, pendingBreak); });
    return s;
  }

  // ---------------------------------------------------------------- styles.xml parts

  namedStyles(): string {
    const out: string[] = [];
    const extra = EXTRA_STYLES;
    for (const name of this.usedNamed) {
      const def = (extra[name] as StyleDef) || this.styles[name];
      if (!def) continue;
      const e = extra[name] ? ({ ...this.eff('Normal'), ...extra[name], name } as StyleDef) : this.eff(name);
      const own = extra[name] ? e : def;
      const parent = own.basedOn && (this.styles[own.basedOn] || extra[own.basedOn]) ? odfName(own.basedOn) : null;
      const lvl = styleLevel(name, e.outlineLevel);
      // Write the fully resolved properties so other applications render faithfully.
      const pa: Attrs = {
        align: e.align, indentLeft: e.indentLeft, indentRight: e.indentRight, indentFirst: e.indentFirst,
        spaceBefore: e.spaceBefore ?? 0, spaceAfter: e.spaceAfter ?? 0, lineHeight: e.lineHeight, keepNext: e.keepNext, keepLines: e.keepLines,
        pageBreakBefore: e.pageBreakBefore, bg: (e as any).bg, borderBottom: e.borderBottom, borderTop: e.borderTop, borderLeft: e.borderLeft,
      };
      let pprops = this.paraProps(pa);
      if (name === 'Header' || name === 'Footer') pprops += `><style:tab-stops><style:tab-stop style:position="${pt(this.contentWidth / 2)}" style:type="center"/><style:tab-stop style:position="${pt(this.contentWidth)}" style:type="right"/></style:tab-stops></style:paragraph-properties`;
      const tprops = this.textPropsFromStyle(e);
      const display = odfName(name) !== name ? ` style:display-name="${x(name)}"` : '';
      const next = own.next && this.usedNamed.has(own.next) ? ` style:next-style-name="${odfName(own.next)}"` : '';
      const cls = lvl > 0 ? 'text' : name === 'Header' || name === 'Footer' ? 'extra' : name.includes('note') ? 'extra' : 'text';
      const pp = pprops.endsWith('</style:paragraph-properties') ? `<style:paragraph-properties ${pprops}>` : `<style:paragraph-properties ${pprops}/>`;
      out.push(`<style:style style:name="${odfName(name)}"${display} style:family="paragraph"${parent && name !== 'Normal' ? ` style:parent-style-name="${parent}"` : ''}${next}${lvl > 0 ? ` style:default-outline-level="${lvl}"` : ''} style:class="${cls}">${pp}<style:text-properties ${tprops}/></style:style>`);
    }
    return out.join('\n');
  }

  hfXml(hf: HF, footer: boolean): string {
    const style = this.useStyle(footer ? 'Footer' : 'Header');
    const tok = (s: string) => {
      let out = '';
      const re = /\{([A-Z=]+)(?::([^}]*))?\}/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        out += this.text(s.slice(last, m.index), { v: last === 0 });
        last = m.index + m[0].length;
        switch (m[1]) {
          case 'PAGE': out += '<text:page-number text:select-page="current">1</text:page-number>'; break;
          case 'NUMPAGES': out += '<text:page-count>1</text:page-count>'; break;
          case 'DATE': out += `<text:date>${x(new Date().toLocaleDateString())}</text:date>`; break;
          case 'TIME': out += `<text:time>${x(new Date().toLocaleTimeString())}</text:time>`; break;
          case 'TITLE': out += `<text:title>${x(this.title)}</text:title>`; break;
          case 'AUTHOR': out += `<text:initial-creator>${x(this.author)}</text:initial-creator>`; break;
          case 'FILENAME': out += `<text:file-name text:display="name-and-extension">${x(this.fileName)}</text:file-name>`; break;
          case 'SUBJECT': out += `<text:subject>${x(this.settings.properties.subject || '')}</text:subject>`; break;
          case 'COMPANY': out += x(this.settings.properties.company || ''); break;
          default: out += x(m[0]);
        }
      }
      return out + this.text(s.slice(last), { v: last === 0 });
    };
    return `<text:p text:style-name="${style}">${tok(hf.left || '')}<text:tab/>${tok(hf.center || '')}<text:tab/>${tok(hf.right || '')}</text:p>`;
  }

  masterAndLayout(): { auto: string; master: string } {
    const s = this.settings;
    const p = s.page;
    const land = p.orientation === 'landscape';
    const w = land ? Math.max(p.width, p.height) : Math.min(p.width, p.height);
    const h = land ? Math.min(p.width, p.height) : Math.max(p.width, p.height);
    const has = (hf: HF) => !!(hf && (hf.left || hf.center || hf.right));
    const hasHeader = has(s.header) || (s.differentFirst && has(s.firstHeader)) || (s.differentOddEven && has(s.evenHeader));
    const hasFooter = has(s.footer) || (s.differentFirst && has(s.firstFooter)) || (s.differentOddEven && has(s.evenFooter));
    const line = 14;
    const mt = hasHeader ? p.headerDist : p.margin.top;
    const mb = hasFooter ? p.footerDist : p.margin.bottom;
    const hdrGap = Math.max(0, p.margin.top - p.headerDist - line);
    const ftrGap = Math.max(0, p.margin.bottom - p.footerDist - line);
    const numFmt: Record<string, string> = { decimal: '1', 'lower-roman': 'i', 'upper-roman': 'I', 'lower-alpha': 'a', 'upper-alpha': 'A' };
    const bg = toHexColor(s.pageColor, s);
    const layout = `<style:page-layout style:name="pm1"${p.mirror ? ' style:page-usage="mirrored"' : ''}><style:page-layout-properties fo:page-width="${pt(w)}" fo:page-height="${pt(h)}" style:num-format="${numFmt[s.pageNumber.format] || '1'}" style:print-orientation="${land ? 'landscape' : 'portrait'}" fo:margin-top="${pt(mt)}" fo:margin-bottom="${pt(mb)}" fo:margin-left="${pt(p.margin.left + (p.gutter || 0))}" fo:margin-right="${pt(p.margin.right)}" style:writing-mode="lr-tb"${bg ? ` fo:background-color="${bg}"` : ''}/>` +
      `<style:header-style>${hasHeader ? `<style:header-footer-properties fo:min-height="0pt" fo:margin-bottom="${pt(hdrGap)}" style:dynamic-spacing="false"/>` : ''}</style:header-style>` +
      `<style:footer-style>${hasFooter ? `<style:header-footer-properties fo:min-height="0pt" fo:margin-top="${pt(ftrGap)}" style:dynamic-spacing="false"/>` : ''}</style:footer-style></style:page-layout>`;
    let master = `<style:master-page style:name="Standard" style:page-layout-name="pm1">`;
    if (has(s.header) || hasHeader) {
      master += `<style:header>${this.hfXml(s.header, false)}</style:header>`;
      if (s.differentOddEven) master += `<style:header-left>${this.hfXml(s.evenHeader, false)}</style:header-left>`;
      if (s.differentFirst) master += `<style:header-first>${this.hfXml(s.firstHeader, false)}</style:header-first>`;
    }
    if (has(s.footer) || hasFooter) {
      master += `<style:footer>${this.hfXml(s.footer, true)}</style:footer>`;
      if (s.differentOddEven) master += `<style:footer-left>${this.hfXml(s.evenFooter, true)}</style:footer-left>`;
      if (s.differentFirst) master += `<style:footer-first>${this.hfXml(s.firstFooter, true)}</style:footer-first>`;
    }
    master += '</style:master-page>';
    return { auto: layout, master };
  }

  fontDecls(): string {
    return `<office:font-face-decls>${[...this.fonts].map((f) => `<style:font-face style:name="${x(f)}" svg:font-family="${x(/\s/.test(f) ? `'${f}'` : f)}"${/mono|courier|cousine/i.test(f) ? ' style:font-pitch="fixed" style:font-family-generic="modern"' : ''}/>`).join('')}</office:font-face-decls>`;
  }

  defaultStyles(): string {
    const n = this.eff('Normal');
    const body = resolveFontName(n.font || '+body', this.settings) || 'Carlito';
    const [lang, country] = (this.settings.language || 'en-US').split('-');
    const graphic = `<style:default-style style:family="graphic"><style:graphic-properties draw:shadow-offset-x="0.1181in" draw:shadow-offset-y="0.1181in" style:flow-with-text="false"/></style:default-style>`;
    const paraDefault = `<style:default-style style:family="paragraph"><style:paragraph-properties fo:hyphenation-ladder-count="no-limit" style:text-autospace="ideograph-alpha" style:punctuation-wrap="hanging" style:line-break="strict" style:tab-stop-distance="${pt(this.settings.defaultTab || 36)}" style:writing-mode="page"/><style:text-properties ${this.fontDecl(body)} fo:font-size="${pt(n.size || 11)}" fo:language="${x(lang || 'en')}" fo:country="${x((country || 'US').toUpperCase())}" fo:hyphenate="${this.settings.hyphenation ? 'true' : 'false'}"/></style:default-style>`;
    const outline = `<text:outline-style style:name="Outline">${Array.from({ length: 10 }, (_, i) => `<text:outline-level-style text:level="${i + 1}" style:num-format=""><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab"/></style:list-level-properties></text:outline-level-style>`).join('')}</text:outline-style>`;
    const notes = `<text:notes-configuration text:note-class="footnote" style:num-format="${NUM_FORMAT[this.settings.footnoteFormat.foot] || '1'}" text:start-value="0" text:footnotes-position="${this.settings.footnoteFormat.placement === 'end' ? 'document' : 'page'}" text:start-numbering-at="document"/><text:notes-configuration text:note-class="endnote" style:num-format="${NUM_FORMAT[this.settings.footnoteFormat.end] || 'i'}" text:start-value="0"/>`;
    const frames = `<style:style style:name="Graphics" style:family="graphic"><style:graphic-properties text:anchor-type="as-char" svg:y="0pt" style:wrap="none" style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>`;
    return graphic + paraDefault + outline + notes + frames;
  }

  frameStyles(): string {
    return `<style:style style:name="fr1" style:family="graphic" style:parent-style-name="Graphics"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" fo:border="none"/></style:style>` +
      `<style:style style:name="fr_left" style:family="graphic" style:parent-style-name="Graphics"><style:graphic-properties style:wrap="right" style:horizontal-pos="left" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:margin-right="9pt"/></style:style>` +
      `<style:style style:name="fr_right" style:family="graphic" style:parent-style-name="Graphics"><style:graphic-properties style:wrap="left" style:horizontal-pos="right" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:margin-left="9pt"/></style:style>` +
      `<style:style style:name="fr_center" style:family="graphic" style:parent-style-name="Graphics"><style:graphic-properties style:wrap="none" style:horizontal-pos="center" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph"/></style:style>`;
  }

  metaInner(): string {
    const p = this.settings.properties;
    const now = isoNow();
    const items = [
      '<meta:generator>Anne\'s Pen</meta:generator>',
      this.title ? `<dc:title>${x(this.title)}</dc:title>` : '',
      p.subject ? `<dc:subject>${x(p.subject)}</dc:subject>` : '',
      p.comments ? `<dc:description>${x(p.comments)}</dc:description>` : '',
      ...(p.keywords ? p.keywords.split(/\s*[,;]\s*/).filter(Boolean).map((k) => `<meta:keyword>${x(k)}</meta:keyword>`) : []),
      this.author ? `<meta:initial-creator>${x(this.author)}</meta:initial-creator><dc:creator>${x(this.author)}</dc:creator>` : '',
      `<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date>`,
      `<dc:language>${x(this.settings.language || 'en-US')}</dc:language>`,
      ...['category', 'company', 'manager', 'status'].filter((k) => (p as any)[k]).map((k) => `<meta:user-defined meta:name="${x(k[0].toUpperCase() + k.slice(1))}" meta:value-type="string">${x((p as any)[k])}</meta:user-defined>`),
      ...Object.entries(this.settings.customProps || {}).map(([k, v]) => `<meta:user-defined meta:name="${x(k)}" meta:value-type="string">${x(v)}</meta:user-defined>`),
    ];
    return `<office:meta>${items.join('')}</office:meta>`;
  }

  render(doc: PMNode): { content: string; styles: string; meta: string; flat: string } {
    const body = this.children(doc);
    const { auto: layoutAuto, master } = this.masterAndLayout();
    const tracked = this.changes.length ? `<text:tracked-changes text:track-changes="false">${this.changes.join('')}</text:tracked-changes>` : '';
    const seqDecls = '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Illustration"/><text:sequence-decl text:display-outline-level="0" text:name="Table"/><text:sequence-decl text:display-outline-level="0" text:name="Text"/><text:sequence-decl text:display-outline-level="0" text:name="Drawing"/><text:sequence-decl text:display-outline-level="0" text:name="Figure"/></text:sequence-decls>';
    const contentAuto = this.frameStyles() + this.tableStyles.join('') + this.sectionStyles.join('') + this.autoXml.join('') + this.listStyles.join('');
    const named = this.namedStyles();
    const fonts = this.fontDecls();
    const officeText = `<office:body><office:text>${tracked}${seqDecls}${body}</office:text></office:body>`;
    const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
    const content = `${head}<office:document-content ${NS_DECL} office:version="1.3">${fonts}<office:automatic-styles>${contentAuto}</office:automatic-styles>${officeText}</office:document-content>`;
    const styles = `${head}<office:document-styles ${NS_DECL} office:version="1.3">${fonts}<office:styles>${this.defaultStyles()}${named}</office:styles><office:automatic-styles>${layoutAuto}</office:automatic-styles><office:master-styles>${master}</office:master-styles></office:document-styles>`;
    const meta = `${head}<office:document-meta ${NS_DECL} office:version="1.3">${this.metaInner()}</office:document-meta>`;
    const flat = `${head}<office:document ${NS_DECL} office:version="1.3" office:mimetype="${MIME}">${this.metaInner()}${fonts}<office:styles>${this.defaultStyles()}${named}</office:styles><office:automatic-styles>${layoutAuto}${contentAuto}</office:automatic-styles><office:master-styles>${master}</office:master-styles>${officeText}</office:document>`;
    return { content, styles, meta, flat };
  }
}

function writer(doc: PMNode, opts: ExportOptions, flat: boolean): { w: OdtWriter; parts: ReturnType<OdtWriter['render']> } {
  const prepared = prepareDoc(doc, { keepComments: true, keepRevisions: true });
  const notes = collectFootnotes(prepared);
  const w = new OdtWriter(prepared, notes, flat, opts, docTitle(doc, opts));
  const parts = w.render(prepared);
  return { w, parts };
}

export async function exportOdtBytes(doc: PMNode, opts: ExportOptions): Promise<Uint8Array> {
  const { w, parts } = writer(doc, opts, false);
  const zip = new JSZip();
  zip.file('mimetype', MIME, { compression: 'STORE' });
  zip.file('content.xml', parts.content);
  zip.file('styles.xml', parts.styles);
  zip.file('meta.xml', parts.meta);
  zip.file('settings.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-settings xmlns:office="${NS.office}" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings/></office:document-settings>`);
  const entries = [
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME}"/>`,
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>',
  ];
  for (const pic of w.pictures.values()) {
    zip.file(pic.path, pic.bytes);
    entries.push(`<manifest:file-entry manifest:full-path="${x(pic.path)}" manifest:media-type="${x(pic.mime)}"/>`);
  }
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.3">${entries.join('')}</manifest:manifest>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: MIME });
}

export async function exportOdt(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  return makeBlob(await exportOdtBytes(doc, opts), MIME);
}

export function docToFodt(doc: PMNode, opts: ExportOptions): string {
  return writer(doc, opts, true).parts.flat;
}

export async function exportFodt(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  return makeBlob(docToFodt(doc, opts), 'application/vnd.oasis.opendocument.text-flat-xml');
}

// =============================================================================================
// Import

interface OStyle {
  name: string; display: string; family: string; parent: string | null; auto: boolean;
  pp: Record<string, string>; tp: Record<string, string>; outline: number | null; listStyle: string | null; master: string | null;
  cell: Record<string, string>; col: Record<string, string>; section: { cols: number; gap: number | null; rule: boolean } | null; graphic: Record<string, string>;
}
interface OListLevel { bullet: boolean; format: string; start: number; char: string }

const elKids = (el: Element | Document | null): Element[] => {
  if (!el) return [];
  const out: Element[] = [];
  const nodes = (el as any).childNodes as NodeList;
  for (let i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) out.push(nodes[i] as Element);
  return out;
};
const qn = (el: Element) => `${PREFIX[el.namespaceURI || ''] || el.prefix || ''}:${el.localName}`;
const att = (el: Element | null | undefined, ns: keyof typeof NS, local: string): string | null => {
  if (!el) return null;
  const v = el.getAttributeNS(NS[ns], local);
  if (v != null && v !== '') return v;
  return el.getAttribute(`${ns}:${local}`);
};
function attrMap(el: Element | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const a of Array.from(el.attributes)) {
    const p = PREFIX[a.namespaceURI || ''] || a.prefix || '';
    out[`${p}:${a.localName}`] = a.value;
  }
  return out;
}
function find(el: Element | Document | null, name: string): Element | null {
  for (const k of elKids(el)) if (qn(k) === name) return k;
  return null;
}
function findDeep(el: Element | Document | null, name: string): Element | null {
  if (!el) return null;
  const [p, l] = name.split(':');
  const list = (el as Element).getElementsByTagNameNS ? (el as Element).getElementsByTagNameNS((NS as any)[p], l) : null;
  return list && list.length ? list[0] : null;
}

interface Parts { content: Document; styles: Document | null; meta: Document | null; files: Map<string, Uint8Array> }

class OdtReader {
  parts: Parts;
  settings = newSettings();
  styles = new Map<string, OStyle>();
  hfAuto = new Map<string, OStyle>();
  lists = new Map<string, OListLevel[]>();
  fonts = new Map<string, string>();
  changes = new Map<string, { kind: string; author: string; date: number; deleted: string }>();
  activeChanges: Mark[] = [];
  activeComments: Mark[] = [];
  pendingPointComment: Mark | null = null;
  commentNames = new Map<string, string>();
  /** Reply annotation name -> the name of the comment it belongs to. */
  replyRoot = new Map<string, string>();
  pendingReplies = new Map<string, { author: string; date: number; text: string; resolved: boolean }[]>();
  commentSeq = 0;
  deferred: PMNode[] = [];
  breakAfter = false;
  preParas = new WeakSet<PMNode>();
  hrParas = new WeakSet<PMNode>();
  customStyles = new Map<string, string>();

  constructor(parts: Parts) { this.parts = parts; }

  // ---------------------------------------------------------------- styles

  readStyles(container: Element | null, auto: boolean, target: Map<string, OStyle>): void {
    for (const el of elKids(container)) {
      const q = qn(el);
      if (q === 'style:style') {
        const name = att(el, 'style', 'name') || '';
        const family = att(el, 'style', 'family') || 'paragraph';
        const st: OStyle = {
          name, display: att(el, 'style', 'display-name') || decodeOdfName(name), family, parent: att(el, 'style', 'parent-style-name'), auto,
          pp: attrMap(find(el, 'style:paragraph-properties')), tp: attrMap(find(el, 'style:text-properties')),
          outline: att(el, 'style', 'default-outline-level') ? parseInt(att(el, 'style', 'default-outline-level')!, 10) : null,
          listStyle: att(el, 'style', 'list-style-name'), master: att(el, 'style', 'master-page-name'),
          cell: attrMap(find(el, 'style:table-cell-properties')), col: attrMap(find(el, 'style:table-column-properties')), section: null,
          graphic: attrMap(find(el, 'style:graphic-properties')),
        };
        const sp = find(el, 'style:section-properties');
        const cols = sp ? find(sp, 'style:columns') : null;
        if (cols) st.section = { cols: parseInt(att(cols, 'fo', 'column-count') || '1', 10) || 1, gap: lengthToPt(att(cols, 'fo', 'column-gap')), rule: !!find(cols, 'style:column-sep') };
        target.set(`${family}:${name}`, st);
      } else if (q === 'text:list-style') {
        const name = att(el, 'style', 'name') || '';
        const levels: OListLevel[] = [];
        for (const lv of elKids(el)) {
          const level = parseInt(att(lv, 'text', 'level') || '1', 10) - 1;
          if (level < 0 || level > 9) continue;
          if (qn(lv) === 'text:list-level-style-bullet') levels[level] = { bullet: true, format: 'disc', start: 1, char: att(lv, 'text', 'bullet-char') || '•' };
          else if (qn(lv) === 'text:list-level-style-number') {
            const f = att(lv, 'style', 'num-format') || '';
            const fmt: Record<string, string> = { '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' };
            levels[level] = f ? { bullet: false, format: fmt[f] || 'decimal', start: parseInt(att(lv, 'text', 'start-value') || '1', 10) || 1, char: '' } : { bullet: true, format: 'none', start: 1, char: '' };
          } else if (qn(lv) === 'text:list-level-style-image') levels[level] = { bullet: true, format: 'disc', start: 1, char: '•' };
        }
        this.lists.set(name, levels);
      } else if (q === 'style:default-style') {
        const family = att(el, 'style', 'family') || 'paragraph';
        target.set(`${family}:__default__`, { name: '__default__', display: 'Default', family, parent: null, auto: false, pp: attrMap(find(el, 'style:paragraph-properties')), tp: attrMap(find(el, 'style:text-properties')), outline: null, listStyle: null, master: null, cell: {}, col: {}, section: null, graphic: {} });
      }
    }
  }

  readFonts(doc: Document | null): void {
    const decls = doc ? findDeep(doc, 'office:font-face-decls') : null;
    for (const f of elKids(decls)) {
      if (qn(f) !== 'style:font-face') continue;
      const name = att(f, 'style', 'name') || '';
      const fam = (att(f, 'svg', 'font-family') || name).replace(/^['"]|['"]$/g, '');
      this.fonts.set(name, fam);
    }
  }

  style(name: string | null, family: string, hf = false): OStyle | null {
    if (!name) return null;
    return (hf ? this.hfAuto.get(`${family}:${name}`) : null) || this.styles.get(`${family}:${name}`) || null;
  }

  /** Merge properties along the parent chain (ancestors first). */
  resolved(name: string | null, family: string, hf = false): { pp: Record<string, string>; tp: Record<string, string>; named: OStyle | null; chain: OStyle[]; dangling: string | null } {
    const chain: OStyle[] = [];
    let cur = this.style(name, family, hf);
    let dangling: string | null = cur ? null : name;
    let guard = 0;
    while (cur && guard++ < 30) {
      chain.push(cur);
      const parent: string | null = cur.parent;
      cur = parent ? this.style(parent, family, hf) : null;
      if (!cur && parent) dangling = parent;
    }
    const named = chain.find((s) => !s.auto) || null;
    const use = chain;
    const pp: Record<string, string> = {}, tp: Record<string, string> = {};
    for (let i = use.length - 1; i >= 0; i--) { Object.assign(pp, use[i].pp); Object.assign(tp, use[i].tp); }
    return { pp, tp, named, chain, dangling };
  }

  fontName(tp: Record<string, string>): string | null {
    const fn = tp['style:font-name'];
    if (fn) return this.fonts.get(fn) || fn;
    const ff = tp['fo:font-family'];
    if (ff) return ff.split(',')[0].replace(/['"]/g, '').trim();
    return null;
  }

  textMarks(tp: Record<string, string>): Mark[] {
    const M = S.marks;
    const out: Mark[] = [];
    const fw = tp['fo:font-weight'];
    if (fw && (fw === 'bold' || parseInt(fw, 10) >= 600)) out.push(M.bold.create());
    const fs = tp['fo:font-style'];
    if (fs === 'italic' || fs === 'oblique') out.push(M.italic.create());
    const ul = tp['style:text-underline-style'];
    if (ul && ul !== 'none') {
      let style = ({ solid: 'single', dotted: 'dotted', dash: 'dashed', 'long-dash': 'dashed', 'dot-dash': 'dotDash', 'dot-dot-dash': 'dotDotDash', wave: 'wavy' } as Record<string, string>)[ul] || 'single';
      if (tp['style:text-underline-type'] === 'double') style = 'double';
      if (style === 'single' && /bold|thick/.test(tp['style:text-underline-width'] || '')) style = 'thick';
      if (style === 'single' && tp['style:text-underline-mode'] === 'skip-white-space') style = 'words';
      const uc = tp['style:text-underline-color'];
      out.push(M.underline.create({ style, color: uc && uc !== 'font-color' ? toHexColor(uc) : null }));
    }
    const lt = tp['style:text-line-through-style'];
    if (lt && lt !== 'none') out.push(tp['style:text-line-through-type'] === 'double' ? M.dstrike.create() : M.strike.create());
    const pos = tp['style:text-position'];
    if (pos) {
      const first = pos.trim().split(/\s+/)[0];
      if (first === 'super' || (parseFloat(first) > 0 && /%/.test(first))) out.push(M.sup.create());
      else if (first === 'sub' || parseFloat(first) < 0) out.push(M.sub.create());
    }
    if (tp['fo:font-variant'] === 'small-caps') out.push(M.smallcaps.create());
    if (tp['fo:text-transform'] === 'uppercase') out.push(M.allcaps.create());
    if (tp['text:display'] === 'none') out.push(M.hidden.create());
    const color = toHexColor(tp['fo:color']);
    if (color) out.push(M.color.create({ color }));
    const bg = toHexColor(tp['fo:background-color']);
    if (bg) out.push(M.highlight.create({ color: bg }));
    const size = tp['fo:font-size'];
    if (size && !size.endsWith('%')) { const p = lengthToPt(size); if (p) out.push(M.size.create({ pt: Math.round(p * 2) / 2 })); }
    const font = this.fontName(tp);
    if (font) out.push(M.font.create({ family: font }));
    const ls = tp['fo:letter-spacing'];
    if (ls && ls !== 'normal') { const p = lengthToPt(ls); if (p) out.push(M.spacing.create({ pt: r2(p) })); }
    const sc = tp['style:text-scale'];
    if (sc && parseFloat(sc) && parseFloat(sc) !== 100) out.push(M.scale.create({ pct: parseFloat(sc) }));
    return out;
  }

  paraAttrsFrom(pp: Record<string, string>): Attrs {
    const a: Attrs = {};
    const ta = pp['fo:text-align'];
    if (ta) a.align = ta === 'start' || ta === 'left' ? 'left' : ta === 'end' || ta === 'right' ? 'right' : ta === 'center' ? 'center' : ta === 'justify' ? (pp['fo:text-align-last'] === 'justify' ? 'distribute' : 'justify') : null;
    const num = (k: string) => { const v = pp[k]; return v != null ? lengthToPt(v) : null; };
    if (num('fo:margin-left') != null) a.indentLeft = r2(num('fo:margin-left')!);
    if (num('fo:margin-right') != null) a.indentRight = r2(num('fo:margin-right')!);
    if (num('fo:text-indent') != null) a.indentFirst = r2(num('fo:text-indent')!);
    if (num('fo:margin-top') != null) a.spaceBefore = r2(num('fo:margin-top')!);
    if (num('fo:margin-bottom') != null) a.spaceAfter = r2(num('fo:margin-bottom')!);
    const lh = pp['fo:line-height'];
    if (lh && lh !== 'normal') {
      if (lh.endsWith('%')) a.lineHeight = String(r2(parseFloat(lh) / 100));
      else { const p = lengthToPt(lh); if (p) a.lineHeight = `${r2(p)}pt`; }
    }
    const al = pp['style:line-height-at-least'];
    if (al) { const p = lengthToPt(al); if (p) a.lineHeight = `atleast:${r2(p)}`; }
    if (pp['fo:keep-with-next'] === 'always') a.keepNext = true;
    if (pp['fo:keep-together'] === 'always') a.keepLines = true;
    const bg = toHexColor(pp['fo:background-color']);
    if (bg) a.bg = bg;
    if (pp['style:writing-mode'] === 'rl-tb') a.dir = 'rtl';
    return a;
  }

  /** Map an ODF named paragraph style onto an Anne's Pen style (creating a custom style if needed). */
  qfStyle(named: OStyle | null, outline: number | null): string {
    if (!named) return outline ? `Heading ${Math.min(9, outline)}` : 'Normal';
    const canon = canonicalStyleName(named.display) || canonicalStyleName(named.name);
    if (canon && canon !== 'List Paragraph') {
      if (canon === 'Heading 1' && /^heading$/i.test(named.display) && outline) return `Heading ${Math.min(9, outline)}`;
      return canon;
    }
    if (named.outline && named.outline > 0) return `Heading ${Math.min(9, named.outline)}`;
    if (outline) return `Heading ${Math.min(9, outline)}`;
    if (/^(list|list contents|list bullet|list number|numbering \d.*|list \d.*|table contents|table heading|frame contents|text|default paragraph style|horizontal line)$/i.test(named.display)) return 'Normal';
    // Custom style: define it in the document.
    const cached = this.customStyles.get(named.name);
    if (cached) return cached;
    const name = named.display.slice(0, 80);
    const r = this.resolved(named.name, 'paragraph');
    const a = this.paraAttrsFrom(r.pp);
    const marks = this.textMarks(r.tp);
    const def: StyleDef = { name, type: 'paragraph', basedOn: (named.parent && this.qfStyle(this.style(named.parent, 'paragraph'), null)) || 'Normal' };
    if (a.align && a.align !== 'left') def.align = a.align;
    if (a.indentLeft) def.indentLeft = a.indentLeft;
    if (a.indentRight) def.indentRight = a.indentRight;
    if (a.indentFirst) def.indentFirst = a.indentFirst;
    if (a.spaceBefore != null) def.spaceBefore = a.spaceBefore;
    if (a.spaceAfter != null) def.spaceAfter = a.spaceAfter;
    if (a.lineHeight && /^\d/.test(a.lineHeight)) def.lineHeight = a.lineHeight;
    if (a.keepNext) def.keepNext = true;
    for (const m of marks) {
      if (m.type.name === 'bold') def.bold = true;
      if (m.type.name === 'italic') def.italic = true;
      if (m.type.name === 'underline') def.underline = true;
      if (m.type.name === 'color') def.color = m.attrs.color;
      if (m.type.name === 'size') def.size = m.attrs.pt;
      if (m.type.name === 'font') def.font = m.attrs.family;
      if (m.type.name === 'smallcaps') def.smallCaps = true;
      if (m.type.name === 'allcaps') def.caps = true;
    }
    if (def.basedOn === name) def.basedOn = 'Normal';
    this.settings.styles = { ...this.settings.styles, [name]: def };
    this.customStyles.set(named.name, name);
    return name;
  }

  // ---------------------------------------------------------------- inline content

  picture(href: string | null, frame: Element): string | null {
    const bin = findDeep(frame, 'office:binary-data');
    if (bin && bin.textContent) {
      const bytes = base64ToBytes(bin.textContent);
      if (bytes.length) return toDataUrl(bytes, sniffImageMime(bytes) || 'image/png');
    }
    if (!href) return null;
    if (/^(https?:|data:)/i.test(href)) return href;
    const path = href.replace(/^\.\//, '').replace(/^\//, '');
    const bytes = this.parts.files.get(path) || this.parts.files.get(decodeURIComponent(path));
    if (!bytes) return null;
    return toDataUrl(bytes, sniffImageMime(bytes) || mimeForName(path));
  }

  frame(el: Element, marks: Mark[], out: PMNode[]): void {
    const w = lengthToPt(att(el, 'svg', 'width')), h = lengthToPt(att(el, 'svg', 'height'));
    const title = find(el, 'svg:title')?.textContent || null;
    const desc = find(el, 'svg:desc')?.textContent || '';
    const tb = find(el, 'draw:text-box');
    if (tb) {
      const blocks: PMNode[] = [];
      this.blocks(tb, blocks, { listDepth: 0, listStyle: null });
      // A text frame becomes a text box with the frame's width, fill, border and wrap side.
      const fs = this.style(att(el, 'draw', 'style-name'), 'graphic');
      const g = fs?.graphic || {};
      const hp = g['style:horizontal-pos'], wrapMode = g['style:wrap'];
      const float = wrapMode === 'none' || wrapMode === 'run-through' ? 'none' : hp === 'right' ? 'right' : hp === 'left' || hp === 'from-left' ? 'left' : 'none';
      const bg = toHexColor(g['fo:background-color']);
      const border = g['fo:border'] && g['fo:border'] !== 'none' ? g['fo:border'] : null;
      if (blocks.length) this.deferred.push(S.nodes.text_box.create({ width: w ? String(Math.round(w)) : null, float, bg, border }, blocks));
      return;
    }
    const images = elKids(el).filter((k) => qn(k) === 'draw:image');
    let src: string | null = null;
    for (const im of images) {
      src = this.picture(att(im, 'xlink', 'href'), im);
      if (src && !/^data:image\/(x-emf|x-wmf|svm)|application\/octet-stream/.test(src)) break;
    }
    const obj = find(el, 'draw:object');
    if (!src && obj) {
      const href = (att(obj, 'xlink', 'href') || '').replace(/^\.\//, '');
      const xml = this.parts.files.get(`${href}/content.xml`);
      if (xml) {
        try {
          const d = new DOMParser().parseFromString(utf8Decode(xml), 'application/xml');
          const ann = d.getElementsByTagName('annotation')[0] || d.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'annotation')[0];
          const latex = (ann?.textContent || d.documentElement.textContent || '').trim();
          if (latex) out.push(S.nodes.math_inline.create({ latex }, null, marks));
        } catch { /* ignore */ }
      }
      return;
    }
    if (!src) return;
    const gs = this.style(att(el, 'draw', 'style-name'), 'graphic');
    const anchor = att(el, 'text', 'anchor-type') || 'as-char';
    let wrap = 'inline';
    if (anchor !== 'as-char' && gs) {
      const hp = gs.graphic['style:horizontal-pos'];
      if (hp === 'left' || hp === 'from-left') wrap = 'left';
      else if (hp === 'right') wrap = 'right';
      else if (hp === 'center') wrap = 'center';
    }
    out.push(S.nodes.image.create({ src, alt: desc, title, width: w ? r2(w) : null, height: h ? r2(h) : null, wrap }, null, marks));
  }

  field(el: Element, type: string, marks: Mark[], out: PMNode[], extra: Attrs = {}): void {
    out.push(S.nodes.field.create({ type, value: el.textContent || '', ...extra }, null, marks.filter((m) => m.type !== S.marks.link)));
  }

  inline(el: Element, marks: Mark[], out: PMNode[], ws: { last: boolean }, hf = false): void {
    const nodes = el.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3 || n.nodeType === 4) {
        let t = (n.textContent || '').replace(/[ \t\r\n]+/g, ' ');
        if (ws.last && t.startsWith(' ')) t = t.slice(1);
        if (!t) continue;
        ws.last = t.endsWith(' ');
        this.emitText(t, marks, out);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const c = n as Element;
      const q = qn(c);
      switch (q) {
        case 'text:span': {
          const st = this.style(att(c, 'text', 'style-name'), 'text', hf);
          const r = st ? this.resolved(st.name, 'text', hf) : null;
          const m = r ? markSet([...marks, ...this.textMarks(r.tp)]) : marks;
          this.inline(c, m, out, ws, hf);
          break;
        }
        case 'text:a': {
          const href = att(c, 'xlink', 'href') || '';
          this.inline(c, href ? markSet([...marks, S.marks.link.create({ href, title: att(c, 'office', 'title') })]) : marks, out, ws, hf);
          break;
        }
        case 'text:s': this.emitText(' '.repeat(spaceCount(c)), marks, out); ws.last = false; break;
        case 'text:tab': this.emitText('\t', marks, out); ws.last = false; break;
        case 'text:line-break': out.push(S.nodes.hard_break.create()); ws.last = true; break;
        case 'text:soft-page-break': break;
        case 'text:note': {
          const cls = att(c, 'text', 'note-class') || 'footnote';
          const cit = find(c, 'text:note-citation');
          const body = find(c, 'text:note-body');
          const paras = elKids(body).map((p) => this.plainText(p)).filter((t) => t.length);
          const label = att(cit, 'text', 'label');
          out.push(S.nodes.footnote.create({ text: paras.join('\n'), kind: cls === 'endnote' ? 'end' : 'foot', mark: label || null }));
          ws.last = false;
          break;
        }
        case 'office:annotation': {
          const name = att(c, 'office', 'name');
          const author = find(c, 'dc:creator')?.textContent || '';
          const date = Date.parse(find(c, 'dc:date')?.textContent || '') || Date.now();
          const text = elKids(c).filter((k) => qn(k) === 'text:p' || qn(k) === 'text:h' || qn(k) === 'text:list').map((p) => this.plainText(p)).join('\n');
          const resolved = att(c, 'loext', 'resolved') === 'true';
          // A reply (LibreOffice): added to its parent comment, which marks the range. LibreOffice
          // may write a reply before its parent; it then waits for the parent.
          const parentName = att(c, 'loext', 'parent-name');
          if (parentName) {
            const reply = { author, date, text, resolved };
            const root = this.replyRoot.get(parentName) ?? parentName;
            if (name) this.replyRoot.set(name, root);
            const parentId = this.commentNames.get(root);
            if (parentId) this.addReply(parentId, reply);
            else this.pendingReplies.set(root, [...(this.pendingReplies.get(root) || []), reply]);
            break;
          }
          const id = `odt-c${++this.commentSeq}`;
          this.settings.comments = { ...this.settings.comments, [id]: { id, author, date, text, resolved, replies: [] } };
          for (const r of (name && this.pendingReplies.get(name)) || []) this.addReply(id, r);
          const mark = S.marks.comment.create({ id });
          if (name) { this.commentNames.set(name, id); this.activeComments.push(mark); } else this.pendingPointComment = mark;
          break;
        }
        case 'office:annotation-end': {
          const id = this.commentNames.get(att(c, 'office', 'name') || '');
          if (id) this.activeComments = this.activeComments.filter((m) => m.attrs.id !== id);
          break;
        }
        case 'text:bookmark': case 'text:bookmark-start': {
          const name = att(c, 'text', 'name');
          if (name && !hf) out.push(S.nodes.bookmark.create({ name }));
          break;
        }
        case 'text:bookmark-end': case 'text:reference-mark': case 'text:reference-mark-start': case 'text:reference-mark-end':
        case 'text:alphabetical-index-mark-end': case 'text:toc-mark-end': break;
        case 'text:alphabetical-index-mark': case 'text:alphabetical-index-mark-start': {
          const term = att(c, 'text', 'key1') || att(c, 'text', 'string-value');
          const sub = att(c, 'text', 'key1') ? att(c, 'text', 'string-value') : null;
          if (term && !hf) out.push(S.nodes.index_entry.create({ term, sub }));
          break;
        }
        case 'text:change-start': {
          const ch = this.changes.get(att(c, 'text', 'change-id') || '');
          if (ch && ch.kind === 'insertion') this.activeChanges.push(S.marks.insertion.create({ author: ch.author, date: ch.date, id: att(c, 'text', 'change-id') }));
          break;
        }
        case 'text:change-end': {
          const id = att(c, 'text', 'change-id');
          this.activeChanges = this.activeChanges.filter((m) => m.attrs.id !== id);
          break;
        }
        case 'text:change': {
          const id = att(c, 'text', 'change-id') || '';
          const ch = this.changes.get(id);
          if (ch && ch.kind === 'deletion' && ch.deleted) out.push(S.text(ch.deleted, markSet([...marks, ...this.activeComments, S.marks.deletion.create({ author: ch.author, date: ch.date, id })])));
          break;
        }
        case 'text:page-number': if (hf) this.emitText('{PAGE}', marks, out); else this.field(c, 'PAGE', marks, out); break;
        case 'text:page-count': if (hf) this.emitText('{NUMPAGES}', marks, out); else this.field(c, 'NUMPAGES', marks, out); break;
        case 'text:date': if (hf) this.emitText('{DATE}', marks, out); else this.field(c, 'DATE', marks, out); break;
        case 'text:time': if (hf) this.emitText('{TIME}', marks, out); else this.field(c, 'TIME', marks, out); break;
        case 'text:title': if (hf) this.emitText('{TITLE}', marks, out); else this.field(c, 'TITLE', marks, out); break;
        case 'text:subject': if (hf) this.emitText('{SUBJECT}', marks, out); else this.field(c, 'SUBJECT', marks, out); break;
        case 'text:initial-creator': case 'text:author-name': case 'text:creator':
          if (hf) this.emitText('{AUTHOR}', marks, out); else this.field(c, 'AUTHOR', marks, out); break;
        case 'text:file-name': if (hf) this.emitText('{FILENAME}', marks, out); else this.field(c, 'FILENAME', marks, out); break;
        case 'text:keywords': this.field(c, 'KEYWORDS', marks, out); break;
        case 'text:description': this.field(c, 'COMMENTS', marks, out); break;
        case 'text:word-count': this.field(c, 'NUMWORDS', marks, out); break;
        case 'text:character-count': this.field(c, 'NUMCHARS', marks, out); break;
        case 'text:sequence': {
          const nf = att(c, 'style', 'num-format');
          const fmt: Record<string, string> = { i: 'roman', I: 'ROMAN', a: 'alphabetic', A: 'ALPHABETIC' };
          this.field(c, 'SEQ', marks, out, { arg: att(c, 'text', 'name') || 'Figure', format: nf ? fmt[nf] || null : null });
          break;
        }
        case 'text:bookmark-ref': {
          const fmt = att(c, 'text', 'reference-format');
          this.field(c, fmt === 'page' ? 'PAGEREF' : 'REF', marks, out, { arg: att(c, 'text', 'ref-name') });
          break;
        }
        case 'draw:frame': this.frame(c, markSet([...marks, ...this.activeChanges]), out); ws.last = false; break;
        case 'draw:a': {
          const href = att(c, 'xlink', 'href') || '';
          for (const f of elKids(c)) if (qn(f) === 'draw:frame') this.frame(f, href ? markSet([...marks, S.marks.link.create({ href })]) : marks, out);
          break;
        }
        case 'text:ruby': { const base = find(c, 'text:ruby-base'); if (base) this.inline(base, marks, out, ws, hf); break; }
        case 'text:note-citation': case 'office:annotation-body': case 'svg:desc': case 'svg:title': break;
        case 'text:list': case 'text:p': case 'text:h': {
          // Unusual nesting: flatten as inline text.
          this.inline(c, marks, out, ws, hf);
          break;
        }
        default:
          this.inline(c, marks, out, ws, hf);
      }
      if (q.startsWith('text:') && /page-number|page-count|date|time|title|subject|creator|author-name|file-name|keywords|description|word-count|character-count|sequence|bookmark-ref|note$/.test(q)) ws.last = false;
    }
  }

  addReply(parentId: string, r: { author: string; date: number; text: string; resolved: boolean }): void {
    const parent = this.settings.comments[parentId];
    if (!parent) return;
    const reply = { id: `${parentId}-r${parent.replies.length + 1}`, author: r.author, date: r.date, text: r.text };
    this.settings.comments = { ...this.settings.comments, [parentId]: { ...parent, resolved: parent.resolved || r.resolved, replies: [...parent.replies, reply] } };
  }

  emitText(t: string, marks: Mark[], out: PMNode[]): void {
    if (!t) return;
    const m = this.activeComments.length || this.activeChanges.length ? markSet([...marks, ...this.activeComments, ...this.activeChanges]) : marks;
    if (this.pendingPointComment) {
      // Anchor a point comment to the following word.
      const mm = /^(\s*\S+)([\s\S]*)$/.exec(t);
      if (mm) {
        out.push(S.text(mm[1], markSet([...m, this.pendingPointComment])));
        this.pendingPointComment = null;
        if (mm[2]) out.push(S.text(mm[2], m));
        return;
      }
    }
    out.push(S.text(t, m));
  }

  plainText(el: Element): string {
    let s = '';
    const walk = (e: Element) => {
      e.childNodes.forEach((n) => {
        if (n.nodeType === 3) s += (n.textContent || '').replace(/[ \t\r\n]+/g, ' ');
        else if (n.nodeType === 1) {
          const q = qn(n as Element);
          if (q === 'text:s') s += ' '.repeat(spaceCount(n as Element));
          else if (q === 'text:tab') s += '\t';
          else if (q === 'text:line-break') s += '\n';
          else if (q === 'text:note' || q === 'office:annotation') { /* skip */ }
          else walk(n as Element);
        }
      });
    };
    walk(el);
    return s.trim();
  }

  // ---------------------------------------------------------------- blocks

  paragraph(el: Element, out: PMNode[], ctx: { listDepth: number; listStyle: string | null }): void {
    const isH = qn(el) === 'text:h';
    const styleName = att(el, 'text', 'style-name');
    const r = this.resolved(styleName, 'paragraph');
    const outline = isH ? parseInt(att(el, 'text', 'outline-level') || '1', 10) || 1 : null;
    let qf = !r.named && r.dangling ? canonicalStyleName(decodeOdfName(r.dangling)) || this.qfStyle(null, outline) : this.qfStyle(r.named, outline);
    if (qf === 'List Paragraph') qf = 'Normal';
    if (isH && styleLevel(qf) === 0 && qf !== 'Title' && qf !== 'Subtitle') qf = `Heading ${Math.min(9, outline || 1)}`;
    // Direct paragraph formatting = automatic styles in the chain (before the named style).
    const autoChain: OStyle[] = [];
    for (const s of r.chain) { if (!s.auto) break; autoChain.push(s); }
    const dpp: Record<string, string> = {}, dtp: Record<string, string> = {};
    for (let i = autoChain.length - 1; i >= 0; i--) { Object.assign(dpp, autoChain[i].pp); Object.assign(dtp, autoChain[i].tp); }
    const attrs: Attrs = { ...this.paraAttrsFrom(dpp), style: qf };
    if (ctx.listDepth > 0) { delete attrs.indentLeft; delete attrs.indentFirst; }
    const breakBefore = r.pp['fo:break-before'] === 'page' && dpp['fo:break-before'] === 'page';
    const breakAfter = dpp['fo:break-after'] === 'page';
    const paraMarks = this.textMarks(dtp);
    const inl: PMNode[] = [];
    this.deferred = [];
    const ws = { last: true };
    this.inline(el, paraMarks, inl, ws);
    // Trim the collapsed trailing space (never one from <text:s>, which ends with ws.last false).
    const last = inl[inl.length - 1];
    if (ws.last && last && last.isText && / $/.test(last.text || '')) {
      const t = (last.text || '').replace(/ $/, '');
      inl.pop();
      if (t) inl.push(S.text(t, last.marks));
    }
    const isEmpty = !inl.length;
    if (breakBefore || this.breakAfter) out.push(S.nodes.page_break.create());
    this.breakAfter = breakAfter;
    if (breakBefore && isEmpty && !this.deferred.length) return; // a page-break-only paragraph
    const node = para(inl, attrs);
    const named = r.named?.display || '';
    if (/^(preformatted text|source text|code)$/i.test(named) || /^Preformatted_20_Text$/.test(r.named?.name || '')) this.preParas.add(node);
    if (/^horizontal line$/i.test(named) && isEmpty) this.hrParas.add(node);
    out.push(node);
    if (this.deferred.length) { out.push(...this.deferred); this.deferred = []; }
  }

  list(el: Element, ctx: { listDepth: number; listStyle: string | null }): PMNode | null {
    const styleName = att(el, 'text', 'style-name') || ctx.listStyle;
    const levels = styleName ? this.lists.get(styleName) : null;
    const lv = levels?.[Math.min(ctx.listDepth, 9)];
    const ordered = lv ? !lv.bullet : false;
    const items: { blocks: PMNode[]; start: number | null }[] = [];
    for (const it of elKids(el)) {
      const q = qn(it);
      if (q !== 'text:list-item' && q !== 'text:list-header') continue;
      const blocks: PMNode[] = [];
      this.blocks(it, blocks, { listDepth: ctx.listDepth + 1, listStyle: styleName });
      const sv = att(it, 'text', 'start-value');
      items.push({ blocks, start: sv ? parseInt(sv, 10) : null });
    }
    if (!items.length) return null;
    const firstText = (b: PMNode[]) => (b[0] && b[0].type === S.nodes.paragraph ? b[0].textContent : '');
    const isTask = items.every((it) => /^[☐☑☒]\s?/.test(firstText(it.blocks)));
    const mkItem = (it: { blocks: PMNode[] }, type: typeof S.nodes.list_item) => {
      let blocks = it.blocks;
      let checked: boolean | null = null;
      if (isTask && blocks[0]) {
        const p = blocks[0];
        checked = !/^☐/.test(p.textContent);
        const inl: PMNode[] = [];
        let stripped = false;
        p.forEach((c) => {
          if (!stripped && c.isText) { stripped = true; const t = (c.text || '').replace(/^[☐☑☒]\s?/, ''); if (t) inl.push(S.text(t, c.marks)); return; }
          inl.push(c);
        });
        blocks = [p.type.create(p.attrs, inl), ...blocks.slice(1)];
      }
      if (!blocks.length || blocks[0].type !== S.nodes.paragraph) blocks = [para(), ...blocks];
      return type === S.nodes.task_item ? S.nodes.task_item.create({ checked: !!checked }, blocks) : S.nodes.list_item.create(null, blocks);
    };
    if (isTask) return S.nodes.task_list.create(null, items.map((it) => mkItem(it, S.nodes.task_item)));
    if (ordered) return S.nodes.ordered_list.create({ order: items[0].start ?? lv?.start ?? 1, format: lv?.format || 'decimal' }, items.map((it) => mkItem(it, S.nodes.list_item)));
    const ch = lv?.char || '•';
    const bullet = lv?.format === 'none' ? 'none' : ch === '•' || ch === '●' || ch === '' ? 'disc' : ch === '◦' || ch === '○' ? 'circle' : ch === '▪' || ch === '■' ? 'square' : ch;
    return S.nodes.bullet_list.create({ bullet }, items.map((it) => mkItem(it, S.nodes.list_item)));
  }

  table(el: Element): PMNode | null {
    const colWidths: (number | null)[] = [];
    const rows: { el: Element; header: boolean }[] = [];
    const walk = (e: Element, header: boolean) => {
      for (const k of elKids(e)) {
        const q = qn(k);
        if (q === 'table:table-column') {
          const rep = Math.min(64, parseInt(att(k, 'table', 'number-columns-repeated') || '1', 10) || 1);
          const st = this.style(att(k, 'table', 'style-name'), 'table-column');
          const w = st ? lengthToPt(st.col['style:column-width']) : null;
          for (let i = 0; i < rep; i++) colWidths.push(w);
        } else if (q === 'table:table-columns' || q === 'table:table-header-columns' || q === 'table:table-column-group') walk(k, header);
        else if (q === 'table:table-row') {
          const rep = Math.min(50, parseInt(att(k, 'table', 'number-rows-repeated') || '1', 10) || 1);
          for (let i = 0; i < rep; i++) rows.push({ el: k, header });
        } else if (q === 'table:table-header-rows') walk(k, true);
        else if (q === 'table:table-rows' || q === 'table:table-row-group') walk(k, header);
      }
    };
    walk(el, false);
    if (!rows.length) return null;
    let headerRows = 0;
    while (headerRows < rows.length && rows[headerRows].header) headerRows++;
    const maxCols = Math.max(colWidths.length, 1);
    const pmRows = rows.map((row, ri) => {
      const cells: PMNode[] = [];
      let col = 0;
      for (const c of elKids(row.el)) {
        const q = qn(c);
        if (q === 'table:covered-table-cell') { col += Math.min(64, parseInt(att(c, 'table', 'number-columns-repeated') || '1', 10) || 1); continue; }
        if (q !== 'table:table-cell') continue;
        let rep = Math.min(64, parseInt(att(c, 'table', 'number-columns-repeated') || '1', 10) || 1);
        if (col + rep > Math.max(maxCols, 64)) rep = Math.max(1, Math.max(maxCols, 64) - col);
        // Spans stay inside the table (huge values would build huge tables).
        const colspan = Math.max(1, Math.min(parseInt(att(c, 'table', 'number-columns-spanned') || '1', 10) || 1, Math.max(maxCols, 64) - col));
        const rowspan = Math.max(1, Math.min(parseInt(att(c, 'table', 'number-rows-spanned') || '1', 10) || 1, rows.length - ri));
        const st = this.style(att(c, 'table', 'style-name'), 'table-cell');
        const bg = st ? toHexColor(st.cell['fo:background-color']) : null;
        const va = st?.cell['style:vertical-align'];
        const borders = st ? odfCellBorders(st.cell) : null;
        for (let k = 0; k < rep; k++) {
          const blocks: PMNode[] = [];
          this.blocks(c, blocks, { listDepth: 0, listStyle: null });
          const widths = Array.from({ length: colspan }, (_, j) => colWidths[col + j]);
          const colwidth = widths.every((w) => w) ? widths.map((w) => Math.round(w! / 0.75)) : null;
          cells.push((ri < headerRows ? S.nodes.table_header : S.nodes.table_cell).create(
            { colspan, rowspan, colwidth, background: bg, valign: va && va !== 'top' && va !== 'automatic' ? va : null, borders },
            blocks.length ? blocks : [para()],
          ));
          col += colspan;
        }
      }
      return S.nodes.table_row.create(null, cells);
    }).filter((r) => r.childCount > 0);
    if (!pmRows.length) return null;
    // Drop trailing empty repeated rows (spreadsheet artifacts).
    return S.nodes.table.create({ headerRows }, pmRows);
  }

  blocks(container: Element, out: PMNode[], ctx: { listDepth: number; listStyle: string | null }): void {
    joinListContinuations(container);
    const start = out.length;
    for (const el of elKids(container)) {
      const q = qn(el);
      switch (q) {
        case 'text:p': case 'text:h': this.paragraph(el, out, ctx); break;
        case 'text:list': {
          if (ctx.listDepth > 0 && ctx.listDepth > 12) { this.blocks(el, out, ctx); break; }
          const l = this.list(el, { listDepth: ctx.listDepth, listStyle: ctx.listStyle });
          if (l) out.push(l);
          break;
        }
        case 'text:numbered-paragraph': this.blocks(el, out, ctx); break;
        case 'table:table': { const t = this.table(el); if (t) out.push(t); break; }
        case 'text:section': {
          const st = this.style(att(el, 'text', 'style-name'), 'section');
          if (st?.section && st.section.cols > 1) {
            const inner: PMNode[] = [];
            this.blocks(el, inner, ctx);
            out.push(S.nodes.column_section.create({ count: st.section.cols, gap: st.section.gap ?? 36, rule: st.section.rule }, inner.length ? inner : [para()]));
          } else this.blocks(el, out, ctx);
          break;
        }
        case 'text:table-of-content': case 'text:alphabetical-index': case 'text:illustration-index': case 'text:bibliography':
        case 'text:user-index': case 'text:object-index': case 'text:table-index': {
          const body = find(el, 'text:index-body');
          if (body) this.blocks(body, out, ctx);
          break;
        }
        case 'text:index-title': this.blocks(el, out, ctx); break;
        case 'draw:frame': case 'draw:a': {
          const inl: PMNode[] = [];
          this.deferred = [];
          if (q === 'draw:frame') this.frame(el, [], inl); else this.inline(el, [], inl, { last: true });
          if (inl.length) out.push(para(inl));
          out.push(...this.deferred);
          this.deferred = [];
          break;
        }
        case 'text:tracked-changes': case 'text:sequence-decls': case 'text:variable-decls': case 'text:user-field-decls': case 'office:forms':
        case 'text:dde-connection-decls': case 'text:soft-page-break': case 'office:annotation': case 'office:annotation-end': case 'text:change':
        case 'text:change-start': case 'text:change-end': case 'table:table-source': case 'text:alphabetical-index-auto-mark-file': break;
        case 'text:list-item': case 'text:list-header': this.blocks(el, out, ctx); break;
        default: this.blocks(el, out, ctx);
      }
    }
    // Merge preformatted paragraphs into code blocks; empty "Horizontal Line" paragraphs into rules.
    const merged: PMNode[] = [];
    for (const n of out.splice(start)) {
      if (this.hrParas.has(n)) { merged.push(S.nodes.horizontal_rule.create()); continue; }
      if (this.preParas.has(n)) {
        const prev = merged[merged.length - 1];
        const text = n.textContent;
        if (prev && prev.type === S.nodes.code_block && (prev as any).__qfPre) {
          const nt = prev.textContent + '\n' + text;
          const cb = S.nodes.code_block.create(null, nt ? S.text(nt) : null);
          (cb as any).__qfPre = true;
          merged[merged.length - 1] = cb;
        } else {
          const cb = S.nodes.code_block.create(null, text ? S.text(text) : null);
          (cb as any).__qfPre = true;
          merged.push(cb);
        }
        continue;
      }
      merged.push(n);
    }
    out.push(...merged);
  }

  // ---------------------------------------------------------------- settings

  hfText(el: Element | null): HF | null {
    if (!el || att(el, 'style', 'display') === 'false') return null;
    const paras = elKids(el).filter((p) => qn(p) === 'text:p' || qn(p) === 'text:h');
    if (!paras.length) return { left: '', center: '', right: '' };
    const p = paras.find((x) => (x.textContent || '').trim() || x.getElementsByTagNameNS(NS.text, 'page-number').length) || paras[0];
    const inl: PMNode[] = [];
    this.inline(p, [], inl, { last: true }, true);
    const text = inl.map((n) => (n.isText ? n.text : n.type === S.nodes.hard_break ? ' ' : '')).join('');
    const parts = text.split('\t');
    if (parts.length >= 3) return { left: parts[0].trim(), center: parts[1].trim(), right: parts.slice(2).join(' ').trim() };
    if (parts.length === 2) return { left: parts[0].trim(), center: parts[1].trim(), right: '' };
    const r = this.resolved(att(p, 'text', 'style-name'), 'paragraph', true);
    const al = r.pp['fo:text-align'];
    const t = parts[0].trim();
    if (al === 'center') return { left: '', center: t, right: '' };
    if (al === 'end' || al === 'right') return { left: '', center: '', right: t };
    return { left: t, center: '', right: '' };
  }

  readPage(firstParaStyle: string | null): void {
    const sd = this.parts.styles || this.parts.content;
    const masters = findDeep(sd, 'office:master-styles');
    let masterName: string | null = null;
    if (firstParaStyle) {
      const r = this.resolved(firstParaStyle, 'paragraph');
      masterName = r.chain.find((s) => s.master)?.master || null;
    }
    const all = elKids(masters).filter((m) => qn(m) === 'style:master-page');
    const master = all.find((m) => att(m, 'style', 'name') === masterName) || all.find((m) => att(m, 'style', 'name') === 'Standard') || all[0];
    if (!master) return;
    const layoutName = att(master, 'style', 'page-layout-name');
    let layout: Element | null = null;
    for (const d of [this.parts.styles, this.parts.content]) {
      if (!d) continue;
      const list = d.getElementsByTagNameNS(NS.style, 'page-layout');
      for (let i = 0; i < list.length; i++) if (att(list[i], 'style', 'name') === layoutName) { layout = list[i]; break; }
      if (layout) break;
    }
    const s = this.settings;
    const header = this.hfText(find(master, 'style:header'));
    const footer = this.hfText(find(master, 'style:footer'));
    const headerLeft = this.hfText(find(master, 'style:header-left'));
    const footerLeft = this.hfText(find(master, 'style:footer-left'));
    const headerFirst = this.hfText(find(master, 'style:header-first'));
    const footerFirst = this.hfText(find(master, 'style:footer-first'));
    if (header) s.header = header;
    if (footer) s.footer = footer;
    if (headerLeft) { s.evenHeader = headerLeft; s.differentOddEven = true; }
    if (footerLeft) { s.evenFooter = footerLeft; s.differentOddEven = true; }
    if (headerFirst) { s.firstHeader = headerFirst; s.differentFirst = true; }
    if (footerFirst) { s.firstFooter = footerFirst; s.differentFirst = true; }
    if (!layout) return;
    const pp = attrMap(find(layout, 'style:page-layout-properties'));
    const w = lengthToPt(pp['fo:page-width']), h = lengthToPt(pp['fo:page-height']);
    if (w && h) {
      s.page.width = r2(Math.min(w, h));
      s.page.height = r2(Math.max(w, h));
      s.page.orientation = pp['style:print-orientation'] === 'landscape' || w > h ? 'landscape' : 'portrait';
      const match = Object.entries(PAGE_SIZES).find(([, d]) => Math.abs(d[0] - s.page.width) < 2 && Math.abs(d[1] - s.page.height) < 2);
      s.page.sizeName = match ? match[0] : 'Custom';
    }
    const m = (k: string) => lengthToPt(pp[k]);
    if (m('fo:margin-left') != null) s.page.margin.left = r2(m('fo:margin-left')!);
    if (m('fo:margin-right') != null) s.page.margin.right = r2(m('fo:margin-right')!);
    const mt = m('fo:margin-top'), mb = m('fo:margin-bottom');
    const hp = attrMap(findDeep(find(layout, 'style:header-style'), 'style:header-footer-properties'));
    const fp = attrMap(findDeep(find(layout, 'style:footer-style'), 'style:header-footer-properties'));
    const hasH = !!header && Object.keys(hp).length > 0;
    const hasF = !!footer && Object.keys(fp).length > 0;
    if (mt != null) {
      if (hasH) { s.page.headerDist = r2(mt); s.page.margin.top = r2(mt + (lengthToPt(hp['fo:min-height']) || 0) + (lengthToPt(hp['fo:margin-bottom']) || 0) + 14); }
      else s.page.margin.top = r2(mt);
    }
    if (mb != null) {
      if (hasF) { s.page.footerDist = r2(mb); s.page.margin.bottom = r2(mb + (lengthToPt(fp['fo:min-height']) || 0) + (lengthToPt(fp['fo:margin-top']) || 0) + 14); }
      else s.page.margin.bottom = r2(mb);
    }
    const nf = pp['style:num-format'];
    const fmt: Record<string, string> = { '1': 'decimal', i: 'lower-roman', I: 'upper-roman', a: 'lower-alpha', A: 'upper-alpha' };
    if (nf && fmt[nf]) s.pageNumber.format = fmt[nf];
    if (pp['style:page-usage'] === 'mirrored') s.page.mirror = true;
    const bg = toHexColor(pp['fo:background-color']);
    if (bg && bg !== '#ffffff') s.pageColor = bg;
  }

  readMeta(): void {
    const d = this.parts.meta;
    const meta = d ? findDeep(d, 'office:meta') : null;
    if (!meta) return;
    const p = this.settings.properties;
    const keywords: string[] = [];
    for (const k of elKids(meta)) {
      const v = (k.textContent || '').trim();
      switch (qn(k)) {
        case 'dc:title': if (v) p.title = v; break;
        case 'dc:subject': if (v) p.subject = v; break;
        case 'dc:description': if (v) p.comments = v; break;
        case 'meta:keyword': if (v) keywords.push(v); break;
        case 'meta:initial-creator': if (v) p.author = v; break;
        case 'dc:creator': if (v && !p.author) p.author = v; break;
        case 'dc:language': if (v) this.settings.language = v; break;
        case 'meta:user-defined': {
          const name = att(k, 'meta', 'name') || '';
          const low = name.toLowerCase();
          if (['category', 'company', 'manager', 'status'].includes(low)) (p as any)[low] = v;
          else if (name) this.settings.customProps = { ...this.settings.customProps, [name]: v };
          break;
        }
      }
    }
    if (keywords.length) p.keywords = keywords.join(', ');
  }

  readChanges(body: Element | null): void {
    const tc = body ? find(body, 'text:tracked-changes') : null;
    for (const r of elKids(tc)) {
      if (qn(r) !== 'text:changed-region') continue;
      const id = att(r, 'text', 'id') || r.getAttributeNS(NS.xml, 'id') || r.getAttribute('xml:id') || '';
      const kindEl = elKids(r)[0];
      if (!kindEl) continue;
      const kind = kindEl.localName;
      const info = find(kindEl, 'office:change-info');
      const author = find(info, 'dc:creator')?.textContent || '';
      const date = Date.parse(find(info, 'dc:date')?.textContent || '') || 0;
      const deleted = kind === 'deletion' ? elKids(kindEl).filter((k) => qn(k) !== 'office:change-info').map((p) => this.plainText(p)).join(' ') : '';
      this.changes.set(id, { kind, author, date, deleted });
    }
  }

  applyStyleDefaults(): void {
    // Use the document's default/Standard font and size as Normal + theme fonts.
    const r = this.resolved('Standard', 'paragraph');
    const def = this.styles.get('paragraph:__default__');
    const tp = { ...(def?.tp || {}), ...r.tp };
    const font = this.fontName(tp);
    const size = tp['fo:font-size'] && !tp['fo:font-size'].endsWith('%') ? lengthToPt(tp['fo:font-size']) : null;
    const s = this.settings;
    if (font) s.theme = { ...s.theme, bodyFont: font, headingFont: font };
    const hr = this.resolved('Heading', 'paragraph');
    const hfont = this.styles.has('paragraph:Heading') ? this.fontName(hr.tp) : null;
    if (hfont) s.theme = { ...s.theme, headingFont: hfont };
    if (size) s.styles = { ...s.styles, Normal: { ...(s.styles.Normal || {}), name: 'Normal', type: 'paragraph', size: Math.round(size * 2) / 2 } as StyleDef };
  }

  parse(): PMNode {
    const { content, styles } = this.parts;
    this.readFonts(styles);
    this.readFonts(content);
    if (styles) {
      this.readStyles(findDeep(styles, 'office:styles'), false, this.styles);
      this.readStyles(findDeep(styles, 'office:automatic-styles'), true, this.hfAuto);
    }
    this.readStyles(findDeep(content, 'office:styles'), false, this.styles);
    const cAuto = elKids(content.documentElement).find((e) => qn(e) === 'office:automatic-styles') || findDeep(content, 'office:automatic-styles');
    this.readStyles(cAuto, true, this.styles);
    if (styles === content) this.readStyles(cAuto, true, this.hfAuto);
    this.readMeta();
    this.applyStyleDefaults();
    const body = findDeep(content, 'office:body');
    const text = body ? find(body, 'office:text') : null;
    this.readChanges(text);
    const blocks: PMNode[] = [];
    if (text) this.blocks(text, blocks, { listDepth: 0, listStyle: null });
    if (this.breakAfter) blocks.push(S.nodes.page_break.create());
    const firstP = text ? text.getElementsByTagNameNS(NS.text, 'p')[0] || text.getElementsByTagNameNS(NS.text, 'h')[0] : null;
    this.readPage(firstP ? att(firstP, 'text', 'style-name') : null);
    return finishDoc(blocks, this.settings);
  }
}

const isItem = (e: Element | null | undefined) => !!e && (qn(e) === 'text:list-item' || qn(e) === 'text:list-header');
const firstItem = (l: Element) => elKids(l).find(isItem);
const lastItem = (l: Element) => elKids(l).filter(isItem).pop();

/**
 * Tables (or sections) cannot sit in a list item, so a list item holding one is written as: the
 * lists closed, the table, and the lists continued with an unnumbered header item (see the writer's
 * outsideList). Put such tables back into the item and the continued list back into the first one.
 */
function joinListContinuations(container: Element): void {
  const kids = elKids(container);
  for (let k = 0; k < kids.length; k++) {
    const l2 = kids[k];
    if (qn(l2) !== 'text:list' || !continues(l2)) continue;
    let j = k - 1;
    while (j >= 0 && (qn(kids[j]) === 'table:table' || qn(kids[j]) === 'text:section')) j--;
    if (j < 0 || j === k - 1 || qn(kids[j]) !== 'text:list') continue;
    const between = kids.slice(j + 1, k);
    mergeList(kids[j], between, l2);
    kids.splice(j + 1, k - j);
    k = j;
  }
}

/** A continuation list: continued numbering, starting with a header item. */
function continues(l: Element): boolean {
  const f = firstItem(l);
  return !!f && qn(f) === 'text:list-header' && (att(l, 'text', 'continue-numbering') === 'true' || !!att(l, 'text', 'continue-list'));
}

function mergeList(l1: Element, between: Element[], l2: Element): void {
  const item1 = lastItem(l1);
  const head = firstItem(l2)!;
  if (!item1) return;
  const nested1 = elKids(item1).pop();
  const nested2 = elKids(head)[0];
  let rest = Array.from(head.childNodes);
  if (nested1 && qn(nested1) === 'text:list' && nested2 && qn(nested2) === 'text:list' && continues(nested2)) {
    mergeList(nested1, between, nested2);
    rest = rest.filter((n) => n !== nested2);
  } else for (const b of between) item1.appendChild(b);
  for (const n of rest) item1.appendChild(n);
  head.remove();
  for (const n of Array.from(l2.childNodes)) l1.appendChild(n);
  l2.remove();
}

function parseXml(text: string): Document | null {
  try {
    const d = new DOMParser().parseFromString(text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length && !d.documentElement?.namespaceURI?.includes('opendocument')) return null;
    return d;
  } catch {
    return null;
  }
}

function fallbackText(xml: string): PMNode {
  const text = xml.replace(/<text:(p|h)\b[^>]*\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<[^>]+>/g, '');
  const div = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  const decoded = div ? ((div.innerHTML = text.slice(0, 5_000_000)), div.value) : text;
  return finishDoc(decoded.split('\n').map((l) => para(l.trim() ? [S.text(l.trim())] : [])), newSettings());
}

export async function importOdt(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  let zip: JSZip;
  try { zip = await loadZip(data); } catch { return importFodt(data, name); }
  const files = new Map<string, Uint8Array>();
  const read = async (p: string) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const contentXml = await read('content.xml');
  if (!contentXml) return finishDoc([], newSettings());
  const tasks: Promise<void>[] = [];
  zip.forEach((path, f) => {
    if (f.dir || /\.xml$/i.test(path) && !/^Object/.test(path)) return;
    if (/^(Pictures|media|Object|ObjectReplacements)\//i.test(path) || /\.(png|jpe?g|gif|svg|bmp|webp)$/i.test(path) || /^Object[^/]*\/content\.xml$/.test(path)) {
      tasks.push(f.async('uint8array').then((u) => { files.set(path, u); }));
    }
  });
  await Promise.all(tasks);
  const content = parseXml(contentXml);
  if (!content) return fallbackText(contentXml);
  const stylesXml = await read('styles.xml');
  const metaXml = await read('meta.xml');
  try {
    return new OdtReader({ content, styles: stylesXml ? parseXml(stylesXml) : null, meta: metaXml ? parseXml(metaXml) : null, files }).parse();
  } catch {
    return fallbackText(contentXml);
  }
}

export async function importFodt(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const text = utf8Decode(data).replace(/^\uFEFF/, '');
  const d = parseXml(text);
  if (!d) return fallbackText(text);
  try {
    return new OdtReader({ content: d, styles: d, meta: d, files: new Map() }).parse();
  } catch {
    return fallbackText(text);
  }
}

/** Build a document from already-parsed ODF parts (used by converters that translate older XML dialects to ODF). */
export function odfPartsToDoc(parts: { content: Document; styles: Document | null; meta: Document | null; files: Map<string, Uint8Array> }): PMNode {
  return new OdtReader(parts).parse();
}

/** Cell borders from ODF table-cell properties (fo:border and per-side fo:border-*). */
function odfCellBorders(cell: Record<string, string>): string | null {
  const out: Record<string, string> = {};
  const all = cell['fo:border'];
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const v = cell[`fo:border-${side}`] ?? all;
    if (v && v !== 'none' && !/^0(\.0+)?[a-z]*\b/.test(v)) out[side] = v.replace(/(\d*\.?\d+)(cm|mm|in)/, (m) => `${Math.max(0.25, Math.round((lengthToPt(m) || 0.5) * 100) / 100)}pt`);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
