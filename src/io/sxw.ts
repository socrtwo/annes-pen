/**
 * StarOffice 6/7 and OpenOffice.org 1.x Writer import (.sxw documents, .stw templates,
 * .sxg master documents, and the uncompressed single-file XML variant).
 *
 * The OpenOffice.org 1.x XML format is the direct predecessor of OpenDocument: the same
 * element vocabulary under different namespace URIs, plus a handful of structural changes
 * that OASIS made when standardizing it. This module translates the 1.x DOM into ODF and
 * reads it with the ODT importer, so styles, lists, tables, frames, notes, annotations and
 * tracked changes get the same treatment as .odt.
 *
 * Translation (OOo 1.x → ODF 1.x):
 * - namespaces http://openoffice.org/2000/* and the XSL-FO/SVG URIs → urn:oasis:… ;
 * - style:properties → the family-specific *-properties elements (paragraph and text
 *   properties split attribute by attribute); style:text-underline / text-crossing-out →
 *   text-underline-style/type/width and text-line-through-*;
 * - text:ordered-list / text:unordered-list → text:list; text:footnote / text:endnote →
 *   text:note (+ citation/body); text:h text:level → text:outline-level; text:tab-stop → text:tab;
 * - style:page-master → style:page-layout; office:font-decls → office:font-face-decls;
 * - stand-alone draw:image / draw:text-box → draw:frame wrappers (with "#Pictures/…" links
 *   made package-relative); office:annotation and change-info attributes → dc:creator/dc:date;
 * - office:body content → office:body/office:text.
 */
import { loadZip } from './zip';
import type { Node as PMNode } from 'prosemirror-model';
import { odfPartsToDoc } from './odt';
import { decodeXml, parseXml } from './xml-read';
import { finishDoc, newSettings, para, S } from './serialize';

const OOO = 'http://openoffice.org/2000/';
const ODF: Record<string, string> = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  drawing: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  datastyle: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  chart: 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0',
  dr3d: 'urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0',
  form: 'urn:oasis:names:tc:opendocument:xmlns:form:1.0',
  script: 'urn:oasis:names:tc:opendocument:xmlns:script:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
  xlink: 'http://www.w3.org/1999/xlink',
};
const PREFIX_FOR: Record<string, string> = {
  office: 'office', style: 'style', text: 'text', table: 'table', drawing: 'draw', datastyle: 'number', meta: 'meta', chart: 'chart',
  dr3d: 'dr3d', form: 'form', script: 'script', fo: 'fo', svg: 'svg', dc: 'dc', xlink: 'xlink',
};

/** Map an OOo 1.x namespace URI to its ODF key, or null for foreign namespaces. */
function nsKey(uri: string | null): string | null {
  if (!uri) return null;
  if (uri.startsWith(OOO)) return uri.slice(OOO.length);
  if (uri === 'http://www.w3.org/1999/XSL/Format') return 'fo';
  if (uri === 'http://www.w3.org/2000/svg') return 'svg';
  if (uri === 'http://purl.org/dc/elements/1.1/') return 'dc';
  if (uri === 'http://www.w3.org/1999/xlink') return 'xlink';
  if (uri.startsWith('urn:oasis:names:tc:opendocument:xmlns:')) {
    const k = uri.slice('urn:oasis:names:tc:opendocument:xmlns:'.length).replace(/:1\.0$/, '');
    return k === 'xsl-fo-compatible' ? 'fo' : k === 'svg-compatible' ? 'svg' : k;
  }
  return null;
}

const TEXT_PROP = /^(fo:(font-|color$|letter-spacing|text-transform|text-shadow|language|country|hyphenat)|style:(font-|text-(underline|crossing-out|position|blinking|emphasize|scale|rotation|outline|relief|combine|line-through|overline)|use-window-font-color|letter-kerning|language-|country-))/;

const FAMILY_PROPS: Record<string, string> = {
  paragraph: 'paragraph-properties', text: 'text-properties', table: 'table-properties', 'table-column': 'table-column-properties',
  'table-row': 'table-row-properties', 'table-cell': 'table-cell-properties', graphics: 'graphic-properties', graphic: 'graphic-properties',
  section: 'section-properties', ruby: 'ruby-properties', chart: 'chart-properties', 'drawing-page': 'drawing-page-properties',
};

const UNDERLINE: Record<string, [string, string?, string?]> = {
  single: ['solid'], double: ['solid', 'double'], dotted: ['dotted'], dash: ['dash'], 'long-dash': ['long-dash'], 'dot-dash': ['dot-dash'],
  'dot-dot-dash': ['dot-dot-dash'], wave: ['wave'], 'small-wave': ['wave', undefined, 'thin'], 'double-wave': ['wave', 'double'], bold: ['solid', undefined, 'bold'],
  'bold-dotted': ['dotted', undefined, 'bold'], 'bold-dash': ['dash', undefined, 'bold'], 'bold-long-dash': ['long-dash', undefined, 'bold'],
  'bold-dot-dash': ['dot-dash', undefined, 'bold'], 'bold-dot-dot-dash': ['dot-dot-dash', undefined, 'bold'], 'bold-wave': ['wave', undefined, 'bold'], none: ['none'],
};

class Translator {
  out: Document;
  constructor(rootName: string) {
    this.out = document.implementation.createDocument(ODF.office, `office:${rootName}`, null);
  }

  private make(key: string, local: string): Element {
    return this.out.createElementNS(ODF[key], `${PREFIX_FOR[key]}:${local}`);
  }

  private setAttr(el: Element, key: string, local: string, value: string): void {
    el.setAttributeNS(ODF[key], `${PREFIX_FOR[key]}:${local}`, value);
  }

  /** Copy attributes, translating namespaces and a few renamed attributes. */
  private copyAttrs(src: Element, dst: Element, filter?: (q: string) => boolean): void {
    for (let i = 0; i < src.attributes.length; i++) {
      const a = src.attributes[i];
      if (a.name.startsWith('xmlns')) continue;
      const key = nsKey(a.namespaceURI);
      if (!key || !ODF[key]) continue;
      let local = a.localName;
      let value = a.value;
      let k = key;
      const q = `${PREFIX_FOR[key]}:${local}`;
      if (filter && !filter(q)) continue;
      if (q === 'style:page-master-name') local = 'page-layout-name';
      if (q === 'table:value-type' || q === 'table:value' || q === 'table:date-value' || q === 'table:time-value' || q === 'table:boolean-value' || q === 'table:string-value') k = 'office';
      if (q === 'xlink:href' && value.startsWith('#') && /^#(Pictures|Objects?|ObjectReplacements)\//.test(value)) value = value.slice(1);
      if (q === 'fo:font-family' && dst.localName === 'font-face') { k = 'svg'; }
      if (q === 'text:level' && dst.localName === 'h') local = 'outline-level';
      this.setAttr(dst, k, local, value);
    }
  }

  /** Split a style:properties element into ODF property elements for a family. */
  private properties(src: Element, family: string, parentLocal: string, dst: Element): void {
    const textEl = this.make('style', 'text-properties');
    const mainName = parentLocal === 'page-master' ? 'page-layout-properties'
      : parentLocal === 'header-style' || parentLocal === 'footer-style' ? 'header-footer-properties'
        : /^list-level-style/.test(parentLocal) ? 'list-level-properties'
          : FAMILY_PROPS[family] || 'paragraph-properties';
    const main = this.make('style', mainName);
    const textFamily = family === 'text' || /^list-level-style/.test(parentLocal);
    for (let i = 0; i < src.attributes.length; i++) {
      const a = src.attributes[i];
      const key = nsKey(a.namespaceURI);
      if (!key || !ODF[key]) continue;
      const q = `${PREFIX_FOR[key]}:${a.localName}`;
      const toText = (TEXT_PROP.test(q) || (family === 'text' && q === 'fo:background-color')) && mainName !== 'page-layout-properties' && mainName !== 'header-footer-properties';
      const target = toText || (textFamily && mainName === 'text-properties') ? textEl : main;
      if (q === 'style:text-underline') {
        const [style, type, width] = UNDERLINE[a.value] || ['solid'];
        this.setAttr(target, 'style', 'text-underline-style', style);
        if (type) this.setAttr(target, 'style', 'text-underline-type', type);
        this.setAttr(target, 'style', 'text-underline-width', width || 'auto');
        if (style !== 'none') this.setAttr(target, 'style', 'text-underline-color', 'font-color');
        continue;
      }
      if (q === 'style:text-crossing-out') {
        const v = a.value;
        if (v === 'none') { this.setAttr(target, 'style', 'text-line-through-style', 'none'); continue; }
        this.setAttr(target, 'style', 'text-line-through-style', 'solid');
        if (v === 'double-line') this.setAttr(target, 'style', 'text-line-through-type', 'double');
        if (v === 'thick-line') this.setAttr(target, 'style', 'text-line-through-width', 'bold');
        if (v === 'slash' || v === 'X') this.setAttr(target, 'style', 'text-line-through-text', v === 'slash' ? '/' : 'X');
        continue;
      }
      if (q === 'text:min-label-width' || q === 'text:space-before' || q === 'text:min-label-distance') { this.setAttr(main, 'text', a.localName, a.value); continue; }
      this.setAttr(target, key === 'drawing' ? 'drawing' : key, a.localName, a.value);
    }
    // Children (tab stops, drop caps, background images, columns, header/footer rules).
    for (const c of Array.from(src.children)) {
      const t = this.el(c);
      if (t) main.appendChild(t);
    }
    if (main.attributes.length || main.childNodes.length) dst.appendChild(main);
    if (textEl.attributes.length) dst.appendChild(textEl);
  }

  /** Translate one element (returns null for elements that are dropped). */
  el(src: Element): Element | null {
    const key = nsKey(src.namespaceURI);
    if (!key || !ODF[key]) return null;
    const q = `${PREFIX_FOR[key]}:${src.localName}`;
    let local = src.localName;
    let k = key;
    const extra: [string, string, string][] = [];
    switch (q) {
      case 'text:ordered-list': case 'text:unordered-list': local = 'list'; break;
      case 'text:footnote': case 'text:endnote': local = 'note'; extra.push(['text', 'note-class', src.localName === 'footnote' ? 'footnote' : 'endnote']); break;
      case 'text:footnote-citation': case 'text:endnote-citation': local = 'note-citation'; break;
      case 'text:footnote-body': case 'text:endnote-body': local = 'note-body'; break;
      case 'text:footnotes-configuration': case 'text:endnotes-configuration': local = 'notes-configuration'; extra.push(['text', 'note-class', src.localName.startsWith('foot') ? 'footnote' : 'endnote']); break;
      case 'text:tab-stop': local = 'tab'; break;
      case 'style:page-master': local = 'page-layout'; break;
      case 'office:font-decls': local = 'font-face-decls'; break;
      case 'style:font-decl': local = 'font-face'; break;
      case 'office:script': case 'office:settings': return null;
      case 'draw:image': case 'draw:text-box': case 'draw:object': case 'draw:object-ole': {
        if (src.parentElement && src.parentElement.localName === 'frame') break;
        return this.frameWrap(src);
      }
      case 'office:annotation': return this.annotation(src);
      case 'office:change-info': return this.changeInfo(src);
      default: break;
    }
    const dst = this.make(k, local);
    this.copyAttrs(src, dst);
    for (const [ek, el, ev] of extra) this.setAttr(dst, ek, el, ev);
    const family = src.getAttributeNS(OOO + 'style', 'family') || src.getAttribute('style:family') || '';
    for (const c of Array.from(src.childNodes)) {
      if (c.nodeType === 3 || c.nodeType === 4) { dst.appendChild(this.out.createTextNode(c.nodeValue || '')); continue; }
      if (c.nodeType !== 1) continue;
      const ce = c as Element;
      if (nsKey(ce.namespaceURI) === 'style' && ce.localName === 'properties') {
        const parentFamily = family || (src.localName === 'default-style' ? src.getAttribute('style:family') || 'paragraph' : src.localName === 'page-master' ? 'page' : src.localName.startsWith('list-level-style') ? 'text' : 'paragraph');
        this.properties(ce, parentFamily, src.localName, dst);
        continue;
      }
      const t = this.el(ce);
      if (t) dst.appendChild(t);
    }
    void k;
    return dst;
  }

  private frameWrap(src: Element): Element {
    const frame = this.make('drawing', 'frame');
    const inner = this.make('drawing', src.localName === 'text-box' ? 'text-box' : src.localName === 'image' ? 'image' : 'object');
    // Position/size attributes belong to the frame; the link stays on the image.
    for (let i = 0; i < src.attributes.length; i++) {
      const a = src.attributes[i];
      const key = nsKey(a.namespaceURI);
      if (!key || !ODF[key]) continue;
      let v = a.value;
      if (key === 'xlink') {
        if (a.localName === 'href' && /^#(Pictures|Objects?)\//.test(v)) v = v.slice(1);
        this.setAttr(inner, 'xlink', a.localName, v);
      } else if (key === 'fo' && /^min-(height|width)$/.test(a.localName)) {
        this.setAttr(inner, 'fo', a.localName, v);
        this.setAttr(frame, 'fo', a.localName, v);
      } else this.setAttr(frame, key, a.localName, v);
    }
    for (const c of Array.from(src.childNodes)) {
      if (c.nodeType !== 1) continue;
      const ce = c as Element;
      const t = this.el(ce);
      if (!t) continue;
      if (ce.localName === 'desc' || ce.localName === 'title') frame.appendChild(t);
      else inner.appendChild(t);
    }
    frame.insertBefore(inner, frame.firstChild);
    return frame;
  }

  private annotation(src: Element): Element {
    const dst = this.make('office', 'annotation');
    const author = src.getAttributeNS(OOO + 'office', 'author') || src.getAttribute('office:author');
    const date = src.getAttributeNS(OOO + 'office', 'create-date') || src.getAttribute('office:create-date');
    if (author) { const c = this.make('dc', 'creator'); c.textContent = author; dst.appendChild(c); }
    if (date) { const d = this.make('dc', 'date'); d.textContent = date; dst.appendChild(d); }
    for (const c of Array.from(src.children)) { const t = this.el(c); if (t) dst.appendChild(t); }
    return dst;
  }

  private changeInfo(src: Element): Element {
    const dst = this.make('office', 'change-info');
    const author = src.getAttributeNS(OOO + 'office', 'chg-author') || src.getAttribute('office:chg-author');
    const date = src.getAttributeNS(OOO + 'office', 'chg-date-time') || src.getAttribute('office:chg-date-time');
    if (author) { const c = this.make('dc', 'creator'); c.textContent = author; dst.appendChild(c); }
    if (date) { const d = this.make('dc', 'date'); d.textContent = date; dst.appendChild(d); }
    for (const c of Array.from(src.children)) { const t = this.el(c); if (t) dst.appendChild(t); }
    return dst;
  }

  /** Translate a whole part; office:body content is wrapped in office:text. */
  doc(src: Document): Document {
    const root = src.documentElement;
    this.copyAttrs(root, this.out.documentElement);
    for (const c of Array.from(root.children)) {
      const key = nsKey(c.namespaceURI);
      if (key === 'office' && c.localName === 'body') {
        const body = this.make('office', 'body');
        const text = this.make('office', 'text');
        for (const k of Array.from(c.children)) { const t = this.el(k); if (t) text.appendChild(t); }
        body.appendChild(text);
        this.out.documentElement.appendChild(body);
        continue;
      }
      const t = this.el(c);
      if (t) this.out.documentElement.appendChild(t);
    }
    return this.out;
  }
}

/** Translate an OpenOffice.org 1.x XML part (already parsed) into an ODF DOM. Already-ODF input passes through. */
export function translateOoo1(src: Document): Document {
  const root = src.documentElement;
  if (!root || (root.namespaceURI || '').startsWith('urn:oasis:')) return src;
  return new Translator(root.localName).doc(src);
}

function parse(text: string | null): Document | null {
  if (!text) return null;
  // The 1.x DTD reference cannot be resolved; drop it before parsing.
  const d = parseXml(text.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, ''));
  return d ? translateOoo1(d) : null;
}

function textFallback(xml: string): PMNode {
  const body = xml.replace(/<text:(p|h)\b[^>]*\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<text:tab-stop\/>/g, '\t').replace(/<[^>]+>/g, '');
  const t = body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return finishDoc(t.split('\n').map((l) => para(l.trim() ? [S.text(l.trim())] : [])), newSettings());
}

export async function importSxw(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const u8 = new Uint8Array(data);
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) {
    // Single-file (uncompressed) StarOffice XML.
    const text = decodeXml(u8);
    const d = parse(text);
    if (!d) return textFallback(text);
    return odfPartsToDoc({ content: d, styles: d, meta: d, files: new Map() });
  }
  const zip = await loadZip(data);
  const read = async (p: string) => { const f = zip.file(p); return f ? decodeXml(await f.async('uint8array')) : null; };
  const contentXml = await read('content.xml');
  if (!contentXml) throw new Error('content.xml is missing: not a StarOffice/OpenOffice.org document');
  const files = new Map<string, Uint8Array>();
  const tasks: Promise<void>[] = [];
  zip.forEach((path, f) => {
    if (!f.dir && /^(Pictures|Objects?|ObjectReplacements)\//i.test(path)) tasks.push(f.async('uint8array').then((u) => { files.set(path, u); }));
  });
  await Promise.all(tasks);
  const content = parse(contentXml);
  if (!content) return textFallback(contentXml);
  try {
    return odfPartsToDoc({ content, styles: parse(await read('styles.xml')), meta: parse(await read('meta.xml')), files });
  } catch {
    return textFallback(contentXml);
  }
}
