/**
 * Microsoft Word 2003 XML (WordprocessingML 2003, root w:wordDocument) import.
 *
 * Word 2003 XML is the direct ancestor of DOCX's word/document.xml: most elements keep their
 * names, but the document is one file and a few structures differ. This module rewrites it
 * into an Office Open XML package in memory and hands that to the DOCX importer, so styles,
 * numbering, tables, fields, sections and everything else share one well-tested mapping.
 *
 * Differences handled:
 * - styles (w:styles), lists (w:lists: w:listDef / w:list → abstractNum / num, w:nfc → numFmt),
 *   document settings (w:docPr) and properties (o:DocumentProperties) become separate parts;
 * - w:listPr/w:ilfo → w:numPr/w:numId; hyphenated attributes (w:h-ansi, w:first-line,
 *   w:line-rule …) → camelCase; w:vmerge / w:hmerge → w:vMerge / w:hMerge;
 * - footnotes and endnotes written inline (w:footnote inside a run) move to footnotes.xml /
 *   endnotes.xml with references; headers/footers written inline in w:sectPr (w:hdr / w:ftr)
 *   become header/footer parts;
 * - w:hlink → w:hyperlink with an external relationship; w:binData pictures referenced from
 *   VML (v:imagedata src="wordml://…") become media parts;
 * - aml:annotation: comments (Word.Comment + Start/End), bookmarks, and tracked insertions /
 *   deletions (Word.Insertion / Word.Deletion) → comments.xml, w:bookmarkStart/End, w:ins/w:del;
 * - wx:sect / wx:sub-section and smart-tag wrappers are unwrapped; other wx: hints dropped.
 */
import JSZip from 'jszip';
import type { Node as PMNode } from 'prosemirror-model';
import { importDocxZip } from './docx-import';
import { decodeXml, parseXml, attr, kids, kid } from './xml-read';
import { base64ToBytes, extForMime, sniffImageMime } from './serialize';
import { esc } from './ooxml-util';

const W2003 = 'http://schemas.microsoft.com/office/word/2003/wordml';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_DECL = `xmlns:w="${W}" xmlns:r="${R}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"`;
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** w:nfc number-format codes (Word binary/2003 numbering) → OOXML w:numFmt values. */
const NFC: Record<string, string> = {
  0: 'decimal', 1: 'upperRoman', 2: 'lowerRoman', 3: 'upperLetter', 4: 'lowerLetter', 5: 'ordinal', 6: 'cardinalText', 7: 'ordinalText',
  9: 'aiueo', 10: 'iroha', 14: 'decimalFullWidth', 22: 'decimalZero', 23: 'bullet', 24: 'ganada', 25: 'chosung', 255: 'none',
};

const ATTR_RENAME: Record<string, string> = { fareast: 'eastAsia', 'h-ansi': 'hAnsi' };
const EL_RENAME: Record<string, string> = { vmerge: 'vMerge', hmerge: 'hMerge', listPr: 'numPr', ilfo: 'numId', nfc: 'numFmt' };
/** Containers whose children are kept in place. */
const UNWRAP = new Set(['sect', 'sub-section', 'pBdrGroup', 'borders', 'sdt', 'sdtContent', 'customXml']);

const camel = (s: string) => ATTR_RENAME[s] || s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

interface Rel { id: string; type: string; target: string; external?: boolean }

class Converter {
  rels: Rel[] = [];
  media = new Map<string, { path: string; rid: string }>();
  binData = new Map<string, string>(); // wordml:// name → base64
  footnotes: string[] = [];
  endnotes: string[] = [];
  comments: string[] = [];
  parts = new Map<string, string>(); // header/footer parts
  partRels = new Map<string, Rel[]>();
  relSink: Rel[] = this.rels;
  revId = 1;
  hfCount = 0;
  linkRels = new Map<string, string>();

  constructor(private root: Element) {
    for (const b of Array.from(root.getElementsByTagNameNS(W2003, 'binData'))) {
      const n = attr(b, 'name');
      if (n) this.binData.set(n, (b.textContent || '').replace(/\s+/g, ''));
    }
  }

  private rel(type: string, target: string, external = false): string {
    const sink = this.relSink;
    const id = `rId${sink.length + 10}`;
    sink.push({ id, type: `${RT}/${type}`, target, external });
    return id;
  }

  private imageRel(src: string, zip: JSZip): string | null {
    const b64 = this.binData.get(src);
    if (b64 == null) return /^https?:/i.test(src) ? this.rel('image', src, true) : null;
    let m = this.media.get(src);
    if (!m) {
      const bytes = base64ToBytes(b64);
      const mime = sniffImageMime(bytes) || (/\.(emf)$/i.test(src) || (bytes[0] === 1 && bytes[40] === 0x20 && bytes[41] === 0x45) ? 'image/x-emf' : /\.wmf$/i.test(src) || (bytes[0] === 0xd7 && bytes[1] === 0xcd) ? 'image/x-wmf' : 'image/png');
      const path = `media/image${this.media.size + 1}.${extForMime(mime)}`;
      zip.file(`word/${path}`, bytes);
      m = { path, rid: '' };
      this.media.set(src, m);
    }
    // Relationship ids are per part: add one to the current sink each time.
    return this.rel('image', m.path);
  }

  // -------------------------------------------------------------------------------------------
  // Element serialization (2003 → 2007)

  /** Serialize an element in the w (2003) namespace or a foreign namespace into 2007 markup. */
  el(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean } = {}): string {
    const ns = e.namespaceURI || '';
    const ln = e.localName;
    if (ns === W2003) return this.wEl(e, zip, ctx);
    if (/auxHint$/.test(ns)) return UNWRAP.has(ln) ? this.children(e, zip, ctx) : '';
    if (/aml\/2001\/core$/.test(ns)) return this.aml(e, zip, ctx);
    if (ns === 'urn:schemas-microsoft-com:vml' || ns === 'urn:schemas-microsoft-com:office:office' || ns === 'urn:schemas-microsoft-com:office:word') return this.vml(e, zip, ctx);
    // Smart tags and unknown wrappers: keep their content.
    return this.children(e, zip, ctx);
  }

  children(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean } = {}): string {
    let s = '';
    for (const c of kids(e)) s += this.el(c, zip, ctx);
    return s;
  }

  private attrs(e: Element, skip: string[] = []): string {
    let s = '';
    for (let i = 0; i < e.attributes.length; i++) {
      const a = e.attributes[i];
      if (a.name.startsWith('xmlns') || skip.includes(a.localName)) continue;
      const ans = a.namespaceURI || '';
      if (ans === W2003 || (!ans && !a.prefix)) s += ` w:${camel(a.localName)}="${esc(a.value)}"`;
      else if (a.prefix === 'xml') s += ` xml:${a.localName}="${esc(a.value)}"`;
    }
    return s;
  }

  private wEl(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean }): string {
    const ln = e.localName;
    switch (ln) {
      case 'binData': return '';
      case 'sectPr': return this.sectPr(e, zip);
      case 'hlink': {
        const dest = attr(e, 'dest');
        const bm = attr(e, 'bookmark');
        let a = '';
        if (dest) {
          let rid = this.relSink === this.rels ? this.linkRels.get(dest) : undefined;
          if (!rid) { rid = this.rel('hyperlink', dest, true); if (this.relSink === this.rels) this.linkRels.set(dest, rid); }
          a += ` r:id="${rid}"`;
        }
        if (bm) a += ` w:anchor="${esc(bm)}"`;
        return `<w:hyperlink${a}>${this.children(e, zip, ctx)}</w:hyperlink>`;
      }
      case 'r': return this.run(e, zip, ctx);
      case 't': case 'delText':
        return ctx.deleted ? `<w:delText xml:space="preserve">${esc(e.textContent || '')}</w:delText>` : `<w:t xml:space="preserve">${esc(e.textContent || '')}</w:t>`;
      case 'instrText':
        return ctx.deleted ? `<w:delInstrText xml:space="preserve">${esc(e.textContent || '')}</w:delInstrText>` : `<w:instrText xml:space="preserve">${esc(e.textContent || '')}</w:instrText>`;
      case 'footnote': case 'endnote': {
        if (!ctx.inRun) return '';
        const list = ln === 'footnote' ? this.footnotes : this.endnotes;
        const id = list.length + 1;
        list.push(`<w:${ln} w:id="${id}">${this.children(e, zip)}</w:${ln}>`);
        return `<w:${ln}Reference w:id="${id}"/>`;
      }
      case 'footnoteRef': case 'endnoteRef': return `<w:${ln}/>`;
      case 'shd': {
        // Word 2003/LibreOffice write solid shading as a foreground colour; OOXML readers look at the fill.
        const v = attr(e, 'val'), color = attr(e, 'color'), fill = attr(e, 'fill');
        if (v === 'solid' && color && color !== 'auto') return `<w:shd w:val="clear" w:color="auto" w:fill="${esc(color)}"/>`;
        return `<w:shd${this.attrs(e)}/>`;
      }
      case 'gridCol': {
        const w = attr(e, 'w');
        return w && /^\d/.test(w) ? `<w:gridCol w:w="${Math.round(parseFloat(w))}"/>` : '<w:gridCol w:w="0"/>';
      }
      case 'tblHeader': return '<w:tblHeader/>';
      case 'nfc': {
        const code = attr(e, 'val') || '0';
        return `<w:numFmt w:val="${NFC[code] || 'decimal'}"/>`;
      }
      case 'listPr': {
        // Keep only the numbering reference (wx:t / wx:font are rendering hints).
        const ilvl = attr(kid(e, 'ilvl'), 'val');
        const ilfo = attr(kid(e, 'ilfo'), 'val');
        if (ilfo == null) return '';
        return `<w:numPr><w:ilvl w:val="${esc(ilvl || '0')}"/><w:numId w:val="${esc(ilfo)}"/></w:numPr>`;
      }
      case 'spacing': case 'ind': {
        // Decimal twips (LibreOffice writes "239.79") → integers.
        let a = '';
        for (let i = 0; i < e.attributes.length; i++) {
          const at = e.attributes[i];
          if (at.name.startsWith('xmlns')) continue;
          const v = /^-?\d+\.\d+$/.test(at.value) ? String(Math.round(parseFloat(at.value))) : at.value;
          a += ` w:${camel(at.localName)}="${esc(v)}"`;
        }
        return `<w:${ln}${a}/>`;
      }
      case 'fonts': case 'lists': case 'styles': case 'docPr': case 'docOleData': case 'docSuppData': case 'shapeDefaults': case 'bgPict': case 'divs':
        return '';
      default: {
        const name = EL_RENAME[ln] || ln;
        const inner = this.children(e, zip, ctx);
        const text = !kids(e).length ? (e.textContent || '').trim() : '';
        // On/off properties occasionally carry their value as text ("<w:b>on</w:b>").
        const a = this.attrs(e) + (text && !e.hasAttribute('w:val') && /^(on|off|true|false|0|1)$/.test(text) ? ` w:val="${text}"` : '');
        return inner ? `<w:${name}${a}>${inner}</w:${name}>` : `<w:${name}${a}/>`;
      }
    }
  }

  private run(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean }): string {
    const rPr = kid(e, 'rPr');
    const rPrXml = rPr ? this.wEl(rPr, zip, ctx) : '';
    let body = '';
    const out: string[] = [];
    const flush = () => { if (body) out.push(`<w:r>${rPrXml}${body}</w:r>`); body = ''; };
    for (const c of kids(e)) {
      if (c === rPr) continue;
      if (c.namespaceURI === W2003 && c.localName === 'r') {
        // Nested runs (LibreOffice writes them inside hyperlinks): flatten, inner properties win.
        flush();
        const innerPr = kid(c, 'rPr');
        const merged = rPr && !innerPr ? rPrXml : innerPr ? this.wEl(innerPr, zip, ctx) : '';
        let inner = '';
        for (const k of kids(c)) if (k !== innerPr) inner += this.el(k, zip, { ...ctx, inRun: true });
        if (inner) out.push(`<w:r>${merged}${inner}</w:r>`);
        continue;
      }
      if (c.namespaceURI && /aml\/2001\/core$/.test(c.namespaceURI)) {
        // Comment reference / annotation inside a run must sit at paragraph level.
        flush();
        out.push(this.aml(c, zip, ctx, rPrXml));
        continue;
      }
      body += this.el(c, zip, { ...ctx, inRun: true });
    }
    flush();
    return out.join('');
  }

  private aml(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean }, rPrXml = ''): string {
    if (e.localName === 'content') return this.children(e, zip, ctx);
    if (e.localName !== 'annotation') return this.children(e, zip, ctx);
    const type = attr(e, 'type') || '';
    const id = attr(e, 'id') || String(this.revId++);
    const author = esc(attr(e, 'author') || '');
    const date = attr(e, 'createdate') || '';
    const dateAttr = date ? ` w:date="${esc(date)}"` : '';
    const content = kid(e, 'content');
    switch (type) {
      case 'Word.Bookmark.Start': return `<w:bookmarkStart w:id="${esc(id)}" w:name="${esc(attr(e, 'name') || 'bm' + id)}"/>`;
      case 'Word.Bookmark.End': return `<w:bookmarkEnd w:id="${esc(id)}"/>`;
      case 'Word.Comment.Start': return `<w:commentRangeStart w:id="${esc(id)}"/>`;
      case 'Word.Comment.End': return `<w:commentRangeEnd w:id="${esc(id)}"/>`;
      case 'Word.Comment': {
        const saved = this.relSink;
        const body = content ? this.children(content, zip) : '';
        this.relSink = saved;
        this.comments.push(`<w:comment w:id="${esc(id)}" w:author="${author || 'Unknown'}"${dateAttr} w:initials="${esc(attr(e, 'initials') || '')}">${body || '<w:p/>'}</w:comment>`);
        return `<w:r>${rPrXml}<w:commentReference w:id="${esc(id)}"/></w:r>`;
      }
      case 'Word.Insertion': case 'Word.Deletion': {
        const tag = type === 'Word.Insertion' ? 'ins' : 'del';
        const inner = content ? this.children(content, zip, { ...ctx, deleted: tag === 'del' }) : '';
        if (!inner) return '';
        // Paragraph-level annotations wrap runs; within a run they wrap run content.
        const wrapped = ctx.inRun ? `<w:r>${rPrXml}${inner}</w:r>` : inner;
        return `<w:${tag} w:id="${this.revId++}" w:author="${author || 'Unknown'}"${dateAttr}>${wrapped}</w:${tag}>`;
      }
      default:
        // Word.Formatting and other annotations: keep the content, drop the change record.
        return content ? this.children(content, zip, ctx) : '';
    }
  }

  private vml(e: Element, zip: JSZip, ctx: { inRun?: boolean; deleted?: boolean }): string {
    const prefix = e.namespaceURI === 'urn:schemas-microsoft-com:vml' ? 'v' : e.namespaceURI === 'urn:schemas-microsoft-com:office:office' ? 'o' : 'w10';
    let a = '';
    for (let i = 0; i < e.attributes.length; i++) {
      const at = e.attributes[i];
      if (at.name.startsWith('xmlns')) continue;
      if (e.localName === 'imagedata' && at.localName === 'src') {
        const rid = this.imageRel(at.value, zip);
        if (rid) a += ` r:id="${rid}"`;
        continue;
      }
      const p = at.prefix ? `${at.prefix === 'w' ? 'w' : at.prefix}:` : '';
      if (p && !['o:', 'v:', 'w10:'].includes(p)) continue;
      a += ` ${p}${at.localName}="${esc(at.value)}"`;
    }
    const inner = kids(e).map((c) => (c.localName === 'txbxContent' ? `<w:txbxContent>${this.children(c, zip)}</w:txbxContent>` : this.el(c, zip, ctx))).join('');
    return inner ? `<${prefix}:${e.localName}${a}>${inner}</${prefix}:${e.localName}>` : `<${prefix}:${e.localName}${a}/>`;
  }

  // -------------------------------------------------------------------------------------------
  // Sections with inline headers/footers

  private sectPr(e: Element, zip: JSZip): string {
    let s = '';
    for (const c of kids(e)) {
      if (c.namespaceURI === W2003 && (c.localName === 'hdr' || c.localName === 'ftr')) {
        const kind = c.localName;
        const type = attr(c, 'type') || 'odd';
        const n = ++this.hfCount;
        const path = `${kind === 'hdr' ? 'header' : 'footer'}${n}.xml`;
        const saved = this.relSink;
        const rels: Rel[] = [];
        this.relSink = rels;
        const body = this.children(c, zip);
        this.relSink = saved;
        this.parts.set(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${kind} ${NS_DECL}>${body || '<w:p/>'}</w:${kind}>`);
        this.partRels.set(path, rels);
        const rid = this.rel(kind === 'hdr' ? 'header' : 'footer', path);
        const t = type === 'odd' ? 'default' : type === 'even' ? 'even' : 'first';
        s += `<w:${kind === 'hdr' ? 'header' : 'footer'}Reference w:type="${t}" r:id="${rid}"/>`;
        continue;
      }
      s += this.el(c, zip);
    }
    return `<w:sectPr>${s}</w:sectPr>`;
  }

  // -------------------------------------------------------------------------------------------
  // Package parts

  stylesXml(zip: JSZip): string {
    const st = kid(this.root, 'styles');
    let out = '';
    const fonts = kid(this.root, 'fonts');
    const df = kid(fonts, 'defaultFonts');
    if (df) out += `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts${this.attrs(df)}/></w:rPr></w:rPrDefault></w:docDefaults>`;
    for (const s of kids(st)) {
      if (s.localName !== 'style') continue;
      // w:name comes first in OOXML; Word 2003 sometimes puts w:basedOn first.
      const name = kid(s, 'name');
      // LibreOffice writes ODF-encoded names ("Heading_20_1"): decode them to display names.
      const display = (attr(name, 'val') || '').replace(/_([0-9a-fA-F]{2})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      let inner = name ? `<w:name w:val="${esc(display)}"/>` : '';
      for (const c of kids(s)) if (c !== name) inner += this.el(c, zip);
      const a = this.attrs(s).replace(/w:default="on"/, 'w:default="1"');
      out += `<w:style${a}>${inner}</w:style>`;
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS_DECL}>${out}</w:styles>`;
  }

  numberingXml(zip: JSZip): string | null {
    const lists = kid(this.root, 'lists');
    if (!lists) return null;
    let abs = '', nums = '';
    for (const c of kids(lists)) {
      if (c.localName === 'listDef') {
        const id = attr(c, 'listDefId') || '0';
        let inner = '';
        for (const k of kids(c)) {
          if (k.localName === 'lvl') inner += this.el(k, zip);
          else if (k.localName === 'listStyleLink') inner += `<w:numStyleLink w:val="${esc(attr(k, 'val') || '')}"/>`;
          else if (k.localName === 'styleLink') inner += `<w:styleLink w:val="${esc(attr(k, 'val') || '')}"/>`;
        }
        abs += `<w:abstractNum w:abstractNumId="${esc(id)}">${inner}</w:abstractNum>`;
      } else if (c.localName === 'list') {
        const id = attr(c, 'ilfo') || '0';
        let inner = `<w:abstractNumId w:val="${esc(attr(kid(c, 'ilst'), 'val') || '0')}"/>`;
        for (const o of kids(c)) {
          if (o.localName !== 'lvlOverride') continue;
          const so = attr(kid(o, 'startOverride'), 'val');
          const lvl = kid(o, 'lvl');
          inner += `<w:lvlOverride w:ilvl="${esc(attr(o, 'ilvl') || '0')}">${so != null ? `<w:startOverride w:val="${esc(so)}"/>` : ''}${lvl ? this.el(lvl, zip) : ''}</w:lvlOverride>`;
        }
        nums += `<w:num w:numId="${esc(id)}">${inner}</w:num>`;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS_DECL}>${abs}${nums}</w:numbering>`;
  }

  settingsXml(zip: JSZip): string {
    const dp = kid(this.root, 'docPr');
    let s = '';
    for (const c of kids(dp)) {
      switch (c.localName) {
        case 'defaultTabStop': case 'evenAndOddHeaders': case 'mirrorMargins': case 'autoHyphenation': case 'documentProtection':
          s += this.el(c, zip); break;
        case 'footnotePr': case 'endnotePr': {
          const fmt = kid(c, 'numFmt');
          if (fmt) s += `<w:${c.localName}><w:numFmt w:val="${esc(attr(fmt, 'val') || 'decimal')}"/></w:${c.localName}>`;
          break;
        }
        default: break;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings ${NS_DECL}>${s}</w:settings>`;
  }

  coreXml(): string {
    const p = kid(this.root, 'DocumentProperties');
    const t = (n: string) => esc((kid(p, n)?.textContent || '').trim());
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>${t('Title')}</dc:title><dc:subject>${t('Subject')}</dc:subject><dc:creator>${t('Author')}</dc:creator><cp:keywords>${t('Keywords')}</cp:keywords><dc:description>${t('Description')}</dc:description><cp:category>${t('Category')}</cp:category></cp:coreProperties>`;
  }

  appXml(): string {
    const p = kid(this.root, 'DocumentProperties');
    const t = (n: string) => esc((kid(p, n)?.textContent || '').trim());
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>${t('Company')}</Company><Manager>${t('Manager')}</Manager></Properties>`;
  }

  async build(): Promise<JSZip> {
    const zip = new JSZip();
    const body = kid(this.root, 'body');
    const bodyXml = body ? this.children(body, zip) : '<w:p/>';
    let bg = '';
    const bgEl = kid(this.root, 'bgPict');
    const bgColor = attr(kid(bgEl, 'background'), 'bgcolor');
    if (bgColor) bg = `<w:background w:color="${esc(bgColor.replace('#', ''))}"/>`;
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS_DECL}>${bg}<w:body>${bodyXml}</w:body></w:document>`);
    zip.file('word/styles.xml', this.stylesXml(zip));
    this.rel('styles', 'styles.xml');
    const numbering = this.numberingXml(zip);
    if (numbering) { zip.file('word/numbering.xml', numbering); this.rel('numbering', 'numbering.xml'); }
    zip.file('word/settings.xml', this.settingsXml(zip));
    this.rel('settings', 'settings.xml');
    if (this.footnotes.length) { zip.file('word/footnotes.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes ${NS_DECL}>${this.footnotes.join('')}</w:footnotes>`); this.rel('footnotes', 'footnotes.xml'); }
    if (this.endnotes.length) { zip.file('word/endnotes.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:endnotes ${NS_DECL}>${this.endnotes.join('')}</w:endnotes>`); this.rel('endnotes', 'endnotes.xml'); }
    if (this.comments.length) { zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${NS_DECL}>${this.comments.join('')}</w:comments>`); this.rel('comments', 'comments.xml'); }
    for (const [path, xml] of this.parts) {
      zip.file(`word/${path}`, xml);
      zip.file(`word/_rels/${path}.rels`, relsXml(this.partRels.get(path) || []));
    }
    zip.file('word/_rels/document.xml.rels', relsXml(this.rels));
    zip.file('docProps/core.xml', this.coreXml());
    zip.file('docProps/app.xml', this.appXml());
    zip.file('_rels/.rels', relsXml([
      { id: 'rId1', type: `${RT}/officeDocument`, target: 'word/document.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: `${RT}/extended-properties`, target: 'docProps/app.xml' },
    ]));
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
    return zip;
  }
}

function relsXml(rels: Rel[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}

/** Convert a Word 2003 XML document into an in-memory DOCX package (exported for tests). */
export async function wordml2003ToPackage(data: ArrayBuffer): Promise<JSZip> {
  const doc = parseXml(decodeXml(data));
  const root = doc?.documentElement;
  if (!root || root.localName !== 'wordDocument') throw new Error('Not a Word 2003 XML document (w:wordDocument root element missing)');
  return new Converter(root).build();
}

export async function importWordml2003(data: ArrayBuffer, name: string): Promise<PMNode> {
  return importDocxZip(await wordml2003ToPackage(data), name);
}
