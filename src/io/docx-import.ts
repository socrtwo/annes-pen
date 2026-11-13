/**
 * DOCX (Office Open XML WordprocessingML) import.
 *
 * Reads word/document.xml and its companion parts (styles, numbering, footnotes, endnotes,
 * comments, headers/footers, settings, theme, docProps, media) with JSZip + DOMParser and
 * builds an Anne's Pen `doc` node. Elements are selected by localName so both Transitional
 * and Strict OOXML namespaces work. Unknown markup is skipped, never fatal.
 *
 * Notes on mapping decisions
 * - Sections: the body's final w:sectPr becomes settings.page/headers/footers. Mid-document
 *   section properties become `section_break` nodes; a section whose w:cols has num > 1 is
 *   wrapped in a `column_section` (continuous breaks bounding a columned section do not
 *   produce extra section_break nodes, which makes column sections round-trip).
 * - Styles: custom styles used by the document are imported into settings.styles; for
 *   built-in style names only the properties that differ from Anne's Pen's own definition
 *   are imported as overrides.
 * - Complex fields are tracked with a stack that spans runs and paragraphs; TOC / INDEX /
 *   BIBLIOGRAPHY / TOA fields become `gen_block`s whose cache holds the cached result lines.
 */
import JSZip from 'jszip';
import { loadZip } from './zip';
import { Fragment, Mark, type Node as PMNode, type NodeType } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { defaultSettings, PAGE_SIZES, type CommentData, type DocSettings, type StyleDef, type HF } from '../editor/settings';
import { BUILTIN_STYLES, effectiveStyle, fontStack, resolveStyles } from '../editor/styles';
import {
  ACCENT_CHARS, DATE_FIELDS, FUNCTION_NAMES, HIGHLIGHT_COLORS, KNOWN_FIELDS, NARY_CHARS, UNICODE_TO_LATEX, canonicalStyleName,
  cssBorderToOoxml, cssColorToHex, exportFontName, isBuiltinStyleName, mimeForExt, onOff, ooxmlBorderToCss,
  ooxmlColorToCss, parseFieldInstr, parseTwips, round2, escapeXmlText, stripInvalidXml, tableStyleFor, type FieldInstr,
} from './ooxml-util';
import { safeCssValue, safeNum } from '../util/sanitize';

const S = schema.nodes;
const MK = schema.marks;

// ------------------------------------------------------------------------------------------
// DOM helpers (namespace-agnostic: everything by localName)

function kids(el: Element | null | undefined): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c);
  return out;
}
function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}
function kidsNamed(el: Element | null | undefined, name: string): Element[] {
  return kids(el).filter((c) => c.localName === name);
}
function desc(el: Element | null | undefined, name: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagNameNS('*', name));
}
function firstDesc(el: Element | null | undefined, name: string): Element | null {
  return desc(el, name)[0] || null;
}
/** Attribute by local name (any namespace). */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) if (attrs[i].localName === name) return attrs[i].value;
  return null;
}
/** Relationship id attribute (r:id / r:embed / r:link), preferring the relationships namespace. */
function relAttr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const attrs = el.attributes;
  let fallback: string | null = null;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.localName !== name) continue;
    if (a.namespaceURI && /relationships$/.test(a.namespaceURI)) return a.value;
    fallback = a.value;
  }
  return fallback;
}
function val(el: Element | null | undefined, child: string): string | null {
  return attr(kid(el, child), 'val');
}
/** Tri-state boolean property: null when the element is absent. */
function flag(el: Element | null | undefined, child: string): boolean | null {
  const c = kid(el, child);
  if (!c) return null;
  return onOff(attr(c, 'val'));
}
function twAttr(el: Element | null | undefined, name: string): number | null {
  return parseTwips(attr(el, name));
}
function ptAttr(el: Element | null | undefined, name: string): number | null {
  const t = twAttr(el, name);
  return t == null ? null : round2(t / 20);
}
function intAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function decodeXmlBytes(u8: Uint8Array): string {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  const s = new TextDecoder('utf-8').decode(u8);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseXml(text: string): Element | null {
  const parse = (t: string) => {
    const d = new DOMParser().parseFromString(t, 'application/xml');
    const root = d.documentElement;
    if (!root || root.localName === 'parsererror' || d.getElementsByTagName('parsererror').length) return null;
    return root;
  };
  return parse(text) || parse(stripInvalidXml(text).replace(/^<\?xml[^>]*\?>/, ''));
}

// ------------------------------------------------------------------------------------------
// Package access

interface Rel { id: string; type: string; target: string; external: boolean }

class Package {
  private names = new Map<string, string>();
  constructor(public zip: JSZip) {
    zip.forEach((p, f) => { if (!f.dir) this.names.set(p.toLowerCase(), p); });
  }
  resolve(path: string): string | null {
    const p = path.replace(/^\/+/, '');
    if (this.zip.file(p)) return p;
    return this.names.get(p.toLowerCase()) ?? null;
  }
  async bytes(path: string): Promise<Uint8Array | null> {
    const p = this.resolve(path);
    if (!p) return null;
    return this.zip.file(p)!.async('uint8array');
  }
  async xml(path: string | null | undefined): Promise<Element | null> {
    if (!path) return null;
    const b = await this.bytes(path);
    if (!b) return null;
    try { return parseXml(decodeXmlBytes(b)); } catch { return null; }
  }
  files(): string[] { return [...this.names.values()]; }
  async rels(partPath: string): Promise<Map<string, Rel>> {
    const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/') + 1) : '';
    const name = partPath.slice(dir.length);
    const root = await this.xml(`${dir}_rels/${name}.rels`);
    const out = new Map<string, Rel>();
    for (const r of kidsNamed(root, 'Relationship')) {
      const id = attr(r, 'Id') || '';
      const target = attr(r, 'Target') || '';
      const external = (attr(r, 'TargetMode') || '').toLowerCase() === 'external';
      out.set(id, { id, type: attr(r, 'Type') || '', target: external ? target : joinPath(dir, target), external });
    }
    return out;
  }
}

function joinPath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

const relOfType = (rels: Map<string, Rel>, suffix: string): Rel | undefined =>
  [...rels.values()].find((r) => r.type.endsWith('/' + suffix));

// ------------------------------------------------------------------------------------------
// Types

interface WStyle {
  id: string; name: string; type: string; basedOn: string | null; next: string | null;
  pPr: Element | null; rPr: Element | null; qFormat: boolean; isDefault: boolean;
  numId: string | null; ilvl: number | null;
}
interface LvlDef { numFmt: string; lvlText: string; start: number; font: string | null }
interface NumDef { abstractId: string; overrides: Map<number, { start?: number; lvl?: LvlDef }> }
interface ListInfo { numId: string; ilvl: number }
type Item = { node: PMNode; list?: ListInfo; listCont?: boolean } | { sect: Element };

interface FieldFrame {
  instr: string;
  phase: 'instr' | 'result';
  mode: 'capture' | 'suppress' | 'link' | 'pass' | null;
  result: string;
  marks: readonly Mark[];
  info: FieldInstr | null;
  ffData: Element | null;
  linkMark: Mark | null;
  locked: boolean;
  genKind: string | null;
  genOptions: Record<string, unknown>;
}

type Sink = { kind: 'emit'; extra: Mark[] } | { kind: 'instr'; frame: FieldFrame } | { kind: 'capture'; frame: FieldFrame };

interface PartCtx { path: string; rels: Map<string, Rel> }

const PAGE_FMT: Record<string, string> = {
  decimal: 'decimal', lowerRoman: 'lower-roman', upperRoman: 'upper-roman', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha',
  chicago: 'symbols', decimalZero: 'decimal-zero',
};
const LIST_FMT: Record<string, string> = {
  decimal: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman',
  decimalZero: 'decimal-zero', ordinal: 'decimal', cardinalText: 'decimal', ordinalText: 'decimal', decimalEnclosedParen: 'decimal',
};
const UNDERLINE: Record<string, string> = {
  single: 'single', double: 'double', dotted: 'dotted', dottedHeavy: 'dotted', dash: 'dashed', dashedHeavy: 'dashed', dashLong: 'dashed',
  dashLongHeavy: 'dashed', wave: 'wavy', wavyHeavy: 'wavy', wavyDouble: 'wavy', thick: 'thick', words: 'words',
  dotDash: 'dotDash', dashDotHeavy: 'dotDash', dotDotDash: 'dotDotDash', dashDotDotHeavy: 'dotDotDash',
};

/** Private-use bullet glyphs from the Symbol / Wingdings fonts. */
const PUA_BULLETS: Record<number, string> = {
  0xf0b7: 'disc', 0xf0a7: 'square', 0xf06e: 'square', 0xf0a8: 'square', 0xf06f: 'circle', 0xf0d8: '➢', 0xf076: '❖',
  0xf0fc: '✓', 0xf0e0: '➢', 0xf0a5: 'disc', 0xf02d: '–', 0xf0b2: '◊', 0xf0de: '⇒', 0xf0e8: '➔', 0xf0d2: '•',
};

function bulletFor(text: string, font: string | null): string {
  const t = (text || '').trim();
  if (!t) return 'none';
  if (t === '•' || t === '·' || t === '●' || t === '∙') return 'disc';
  if (t === 'o' || t === '◦' || t === '○') return 'circle';
  if (t === '▪' || t === '■' || (t === '§' && /wingdings/i.test(font || ''))) return 'square';
  const code = t.charCodeAt(0);
  if (code >= 0xf000 && code <= 0xf0ff) return PUA_BULLETS[code] || 'disc';
  return t;
}

// ------------------------------------------------------------------------------------------
// Paragraph builder: collects inline content and splits paragraphs at block-level breaks.

class ParaBuilder {
  out: PMNode[] = [];
  cur: PMNode[] = [];
  after: PMNode[] = [];
  touched = false;
  constructor(private imp: DocxImporter, public attrs: Record<string, any>) {}

  text(t: string, marks: readonly Mark[]): void {
    if (!t) return;
    const s = this.imp.sink();
    if (s.kind === 'instr') { s.frame.instr += t; return; }
    if (s.kind === 'capture') { s.frame.result += t; this.touched = true; return; }
    const clean = stripInvalidXml(t);
    if (clean) this.cur.push(schema.text(clean, addMarks(marks, s.extra)));
  }
  inline(node: PMNode): void {
    const s = this.imp.sink();
    if (s.kind === 'instr') { s.frame.instr += inlineText(node); return; }
    if (s.kind === 'capture') { s.frame.result += inlineText(node); this.touched = true; return; }
    this.cur.push(s.extra.length ? node.mark(addMarks(node.marks, s.extra)) : node);
  }
  block(node: PMNode): void {
    const s = this.imp.sink();
    if (s.kind !== 'emit') { this.touched = true; return; }
    this.flush();
    this.out.push(node);
  }
  afterBlock(node: PMNode): void {
    if (this.imp.sink().kind !== 'emit') return;
    this.after.push(node);
  }
  flush(force = false): void {
    if (this.cur.length || force) this.out.push(S.paragraph.create(this.attrs, this.cur));
    this.cur = [];
  }
  finish(): PMNode[] {
    if (this.cur.length) this.flush();
    else if (!this.out.length && !this.after.length && !this.touched) this.flush(true);
    return [...this.out, ...this.after];
  }
}

function addMarks(base: readonly Mark[], extra: readonly Mark[]): readonly Mark[] {
  let set = base;
  for (const m of extra) set = m.addToSet(set);
  return set;
}

function inlineText(node: PMNode): string {
  if (node.isText) return node.text || '';
  if (node.type === S.field) return node.attrs.value || '';
  if (node.type === S.hard_break) return '\n';
  if (node.type === S.footnote || node.type === S.bookmark) return '';
  return node.textContent;
}

const emptyPara = (attrs?: Record<string, any>) => S.paragraph.create(attrs || null);

/** Ensure container content starts with a paragraph and is non-empty. */
function leadParagraph(blocks: PMNode[]): PMNode[] {
  if (!blocks.length || blocks[0].type !== S.paragraph) return [emptyPara(), ...blocks];
  return blocks;
}

// ------------------------------------------------------------------------------------------
// The importer

class DocxImporter {
  settings: DocSettings = defaultSettings();
  styles = new Map<string, WStyle>();
  defaultParaStyle: string | null = null;
  defaultCharStyle: string | null = null;
  docDefaultsP: Element | null = null;
  docDefaultsR: Element | null = null;
  abstracts = new Map<string, Map<number, LvlDef>>();
  abstractStyleLink = new Map<string, string>();
  nums = new Map<string, NumDef>();
  footnotes = new Map<string, string>();
  endnotes = new Map<string, string>();
  media = new Map<string, string>();
  themeMajor: string | null = null;
  themeMinor: string | null = null;
  part: PartCtx = { path: 'word/document.xml', rels: new Map() };
  docPath = 'word/document.xml';
  activeComments = new Set<string>();
  skipComments = new Set<string>();
  knownComments = new Set<string>();
  fieldStack: FieldFrame[] = [];
  pendingInlines: PMNode[] = [];
  pendingDropCap: { lines: number; inlines: PMNode[] } | null = null;
  bookmarkNames = new Set<string>();
  usedStyles = new Set<string>();
  counters = new Map<string, number[]>();
  defaultLang: string | null = null;
  sectPrs: Element[] = [];

  constructor(private pkg: Package, private fileName: string) {}

  // ---------------------------------------------------------------------------------------
  async convert(): Promise<PMNode> {
    const rootRels = await this.pkg.rels('');
    const main = relOfType(rootRels, 'officeDocument');
    let docPath = main ? main.target : 'word/document.xml';
    if (!this.pkg.resolve(docPath)) {
      docPath = this.pkg.files().find((f) => /(^|\/)document\.xml$/i.test(f)) || 'word/document.xml';
    }
    this.docPath = this.pkg.resolve(docPath) || docPath;
    const docRels = await this.pkg.rels(this.docPath);
    this.part = { path: this.docPath, rels: docRels };
    const dir = this.docPath.slice(0, this.docPath.lastIndexOf('/') + 1);
    const partPath = (type: string, fallback: string) => relOfType(docRels, type)?.target || dir + fallback;

    await this.loadMedia();
    const theme = await this.pkg.xml(relOfType(docRels, 'theme')?.target || dir + 'theme/theme1.xml');
    if (theme) {
      this.themeMajor = attr(firstDesc(firstDesc(theme, 'majorFont'), 'latin'), 'typeface') || null;
      this.themeMinor = attr(firstDesc(firstDesc(theme, 'minorFont'), 'latin'), 'typeface') || null;
    }
    this.parseStyles(await this.pkg.xml(partPath('styles', 'styles.xml')));
    this.parseNumbering(await this.pkg.xml(partPath('numbering', 'numbering.xml')));
    this.footnotes = this.parseNotes(await this.pkg.xml(partPath('footnotes', 'footnotes.xml')), 'footnote');
    this.endnotes = this.parseNotes(await this.pkg.xml(partPath('endnotes', 'endnotes.xml')), 'endnote');
    await this.parseComments(await this.pkg.xml(partPath('comments', 'comments.xml')), await this.pkg.xml(relOfType(docRels, 'commentsExtended')?.target || dir + 'commentsExtended.xml'));
    this.parseSettingsPart(await this.pkg.xml(partPath('settings', 'settings.xml')));
    await this.parseProps(rootRels);

    const docRoot = await this.pkg.xml(this.docPath);
    if (!docRoot) throw new Error(`Not a valid Word document (${this.fileName}): word/document.xml is missing or unreadable`);
    const bg = kid(docRoot, 'background');
    if (bg) this.settings.pageColor = ooxmlColorToCss(attr(bg, 'color'));
    const body = kid(docRoot, 'body');
    const bodySect = kid(body, 'sectPr');
    const items: Item[] = [];
    this.collectBlocks(kids(body), items);
    if (this.pendingInlines.length || this.pendingDropCap) {
      items.push({ node: S.paragraph.create(null, [...(this.pendingDropCap?.inlines || []), ...this.pendingInlines]) });
      this.pendingInlines = [];
      this.pendingDropCap = null;
    }
    const blocks = this.assembleSections(items, bodySect);
    await this.applySection(bodySect);
    this.buildStyleSettings();

    const settings = JSON.parse(JSON.stringify(this.settings));
    let doc = S.doc.create({ settings }, blocks.length ? blocks : [emptyPara()]);
    try {
      doc.check();
    } catch {
      doc = repair(doc);
    }
    return doc;
  }

  // ---------------------------------------------------------------------------------------
  // Media, styles, numbering, notes, comments, settings, properties

  private async loadMedia(): Promise<void> {
    for (const f of this.pkg.files()) {
      const ext = (f.split('.').pop() || '').toLowerCase();
      const mime = mimeForExt(ext);
      if (!mime.startsWith('image/')) continue;
      try {
        const b64 = await this.pkg.zip.file(f)!.async('base64');
        this.media.set(f, `data:${mime};base64,${b64}`);
      } catch { /* skip unreadable media */ }
    }
  }

  private mediaFor(rid: string | null): string | null {
    if (!rid) return null;
    const rel = this.part.rels.get(rid);
    if (!rel) return null;
    if (rel.external) return /^(https?:|data:)/i.test(rel.target) ? rel.target : null;
    const p = this.pkg.resolve(rel.target);
    return p ? this.media.get(p) || null : null;
  }

  private parseStyles(root: Element | null): void {
    if (!root) return;
    const dd = kid(root, 'docDefaults');
    this.docDefaultsP = kid(kid(dd, 'pPrDefault'), 'pPr');
    this.docDefaultsR = kid(kid(dd, 'rPrDefault'), 'rPr');
    const lang = attr(kid(this.docDefaultsR, 'lang'), 'val');
    if (lang) { this.defaultLang = lang; this.settings.language = lang; }
    for (const s of kidsNamed(root, 'style')) {
      const id = attr(s, 'styleId') || '';
      const rawName = val(s, 'name') || id;
      const type = attr(s, 'type') || 'paragraph';
      const pPr = kid(s, 'pPr');
      const numPr = kid(pPr, 'numPr');
      const st: WStyle = {
        id, type,
        name: type === 'table' ? rawName : canonicalStyleName(rawName),
        basedOn: val(s, 'basedOn'), next: val(s, 'next'), pPr, rPr: kid(s, 'rPr'),
        qFormat: !!kid(s, 'qFormat'), isDefault: onOff(attr(s, 'default') ?? '0'),
        numId: val(numPr, 'numId'), ilvl: numPr ? (parseInt(val(numPr, 'ilvl') || '0', 10) || 0) : null,
      };
      this.styles.set(id, st);
      if (st.isDefault && type === 'paragraph') this.defaultParaStyle = id;
      if (st.isDefault && type === 'character') this.defaultCharStyle = id;
    }
  }

  private styleName(id: string | null): string {
    if (!id) return 'Normal';
    const s = this.styles.get(id);
    if (s) return s.name;
    return canonicalStyleName(id);
  }

  private parseLvl(l: Element): LvlDef {
    const rFonts = kid(kid(l, 'rPr'), 'rFonts');
    return {
      numFmt: val(l, 'numFmt') || 'decimal',
      lvlText: val(l, 'lvlText') ?? '',
      start: intAttr(kid(l, 'start'), 'val') ?? 1, // a non-numeric value would number the list "NaN"
      font: attr(rFonts, 'ascii') || attr(rFonts, 'hAnsi'),
    };
  }

  private parseNumbering(root: Element | null): void {
    if (!root) return;
    for (const a of kidsNamed(root, 'abstractNum')) {
      const id = attr(a, 'abstractNumId') || '';
      const lv = new Map<number, LvlDef>();
      for (const l of kidsNamed(a, 'lvl')) lv.set(intAttr(l, 'ilvl') ?? 0, this.parseLvl(l));
      this.abstracts.set(id, lv);
      const link = val(a, 'numStyleLink');
      if (link) this.abstractStyleLink.set(id, link);
    }
    for (const n of kidsNamed(root, 'num')) {
      const id = attr(n, 'numId') || '';
      const overrides = new Map<number, { start?: number; lvl?: LvlDef }>();
      for (const o of kidsNamed(n, 'lvlOverride')) {
        const ilvl = intAttr(o, 'ilvl') ?? 0;
        const l = kid(o, 'lvl');
        overrides.set(ilvl, { start: intAttr(kid(o, 'startOverride'), 'val') ?? undefined, lvl: l ? this.parseLvl(l) : undefined });
      }
      this.nums.set(id, { abstractId: val(n, 'abstractNumId') || '', overrides });
    }
  }

  private levelDef(numId: string, ilvl: number): { kind: 'bullet' | 'ordered'; bullet: string; format: string; start: number; suffix: string; outline: boolean; counterKey: string } {
    const num = this.nums.get(numId);
    let abs = num ? this.abstracts.get(num.abstractId) : undefined;
    let absId = num?.abstractId || '';
    for (let guard = 0; num && abs && this.abstractStyleLink.has(absId) && guard < 4; guard++) {
      const st = this.styles.get(this.abstractStyleLink.get(absId)!);
      const linked = st?.numId ? this.nums.get(st.numId) : undefined;
      if (!linked || linked.abstractId === absId) break;
      absId = linked.abstractId;
      abs = this.abstracts.get(absId) || abs;
    }
    const ov = num?.overrides.get(ilvl);
    const lvl: LvlDef = ov?.lvl || abs?.get(ilvl) || { numFmt: 'bullet', lvlText: '•', start: 1, font: null };
    const start = ov?.start ?? lvl.start ?? 1;
    const hasOverride = !!num && [...num.overrides.values()].some((o) => o.start != null);
    const counterKey = hasOverride ? 'n' + numId : 'a' + absId;
    if (lvl.numFmt === 'bullet' || lvl.numFmt === 'none') {
      return { kind: 'bullet', bullet: lvl.numFmt === 'none' ? 'none' : bulletFor(lvl.lvlText, lvl.font), format: 'decimal', start, suffix: '.', outline: false, counterKey };
    }
    const text = lvl.lvlText || '';
    const own = text.lastIndexOf('%' + (ilvl + 1));
    const tail = own >= 0 ? text.slice(own + 2) : text.replace(/%\d/g, '');
    return {
      kind: 'ordered', bullet: 'disc', format: LIST_FMT[lvl.numFmt] || 'decimal', start,
      suffix: tail.trim() || '', outline: (text.match(/%\d/g) || []).length > 1, counterKey,
    };
  }

  private noteText(n: Element): string {
    return kidsNamed(n, 'p').map((p) => plainText(p)).join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
  }

  private parseNotes(root: Element | null, tag: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of kidsNamed(root, tag)) {
      const type = attr(n, 'type');
      if (type && type !== 'normal') continue;
      out.set(attr(n, 'id') || '', this.noteText(n));
    }
    return out;
  }

  private async parseComments(root: Element | null, ext: Element | null): Promise<void> {
    if (!root) return;
    const byPara = new Map<string, string>();
    const comments = new Map<string, CommentData>();
    for (const c of kidsNamed(root, 'comment')) {
      const id = attr(c, 'id') || String(comments.size);
      const ps = kidsNamed(c, 'p');
      const last = ps[ps.length - 1];
      const paraId = attr(last, 'paraId');
      if (paraId) byPara.set(paraId.toUpperCase(), id);
      const d = Date.parse(attr(c, 'date') || '');
      comments.set(id, {
        id, author: attr(c, 'author') || 'Unknown', date: Number.isFinite(d) ? d : 0,
        text: this.noteText(c), resolved: false, replies: [],
      });
    }
    for (const e of kidsNamed(ext, 'commentEx')) {
      const pid = (attr(e, 'paraId') || '').toUpperCase();
      const id = byPara.get(pid);
      if (!id) continue;
      const cm = comments.get(id)!;
      if (onOff(attr(e, 'done') ?? '0')) cm.resolved = true;
      const parentPid = attr(e, 'paraIdParent');
      const parentId = parentPid ? byPara.get(parentPid.toUpperCase()) : undefined;
      if (parentId && parentId !== id && comments.has(parentId)) {
        const parent = comments.get(parentId)!;
        parent.replies.push({ id, author: cm.author, date: cm.date, text: cm.text });
        if (cm.resolved) parent.resolved = true;
        this.skipComments.add(id);
      }
    }
    for (const [id, cm] of comments) {
      if (this.skipComments.has(id)) continue;
      this.settings.comments[id] = cm;
      this.knownComments.add(id);
    }
  }

  private parseSettingsPart(root: Element | null): void {
    if (!root) return;
    const tab = twAttr(kid(root, 'defaultTabStop'), 'val');
    if (tab) this.settings.defaultTab = round2(tab / 20);
    if (flag(root, 'autoHyphenation')) this.settings.hyphenation = true;
    if (flag(root, 'evenAndOddHeaders')) this.settings.differentOddEven = true;
    if (flag(root, 'mirrorMargins')) this.settings.page.mirror = true;
    const prot = kid(root, 'documentProtection');
    if (prot && onOff(attr(prot, 'enforcement') ?? '0')) {
      const edit = attr(prot, 'edit');
      this.settings.protection = { mode: edit === 'readOnly' ? 'readonly' : edit === 'comments' ? 'comments' : edit === 'trackedChanges' ? 'tracked' : edit === 'forms' ? 'forms' : 'none' };
    }
    for (const v of kidsNamed(kid(root, 'docVars'), 'docVar')) {
      const n = attr(v, 'name');
      if (n) this.settings.variables[n] = attr(v, 'val') || '';
    }
    const fFmt = val(kid(root, 'footnotePr'), 'numFmt');
    if (fFmt && PAGE_FMT[fFmt]) this.settings.footnoteFormat.foot = PAGE_FMT[fFmt];
    const eFmt = val(kid(root, 'endnotePr'), 'numFmt');
    if (eFmt && PAGE_FMT[eFmt]) this.settings.footnoteFormat.end = PAGE_FMT[eFmt];
  }

  private async parseProps(rootRels: Map<string, Rel>): Promise<void> {
    const p = this.settings.properties;
    const core = await this.pkg.xml(relOfType(rootRels, 'core-properties')?.target || 'docProps/core.xml');
    const txt = (root: Element | null, name: string) => (firstDesc(root, name)?.textContent || '').trim();
    if (core) {
      p.title = txt(core, 'title'); p.subject = txt(core, 'subject'); p.author = txt(core, 'creator');
      p.keywords = txt(core, 'keywords'); p.comments = txt(core, 'description'); p.category = txt(core, 'category');
      p.status = txt(core, 'contentStatus');
    }
    const app = await this.pkg.xml(relOfType(rootRels, 'extended-properties')?.target || 'docProps/app.xml');
    if (app) { p.company = txt(app, 'Company'); p.manager = txt(app, 'Manager'); }
    const custom = await this.pkg.xml(relOfType(rootRels, 'custom-properties')?.target || 'docProps/custom.xml');
    for (const prop of kidsNamed(custom, 'property')) {
      const name = attr(prop, 'name');
      if (name) this.settings.customProps[name] = (prop.textContent || '').trim();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Section properties

  private async applySection(sect: Element | null): Promise<void> {
    const s = this.settings;
    if (sect) {
      const pg = this.pageFromSect(sect);
      Object.assign(s.page, pg);
      if (flag(sect, 'titlePg')) s.differentFirst = true;
      const pn = kid(sect, 'pgNumType');
      if (pn) {
        const fmt = attr(pn, 'fmt');
        if (fmt && PAGE_FMT[fmt]) s.pageNumber.format = PAGE_FMT[fmt];
        const st = intAttr(pn, 'start');
        if (st != null) s.pageNumber.start = st;
      }
      const ln = kid(sect, 'lnNumType');
      if (ln) {
        const restart = attr(ln, 'restart');
        s.lineNumbers = { enabled: true, countBy: intAttr(ln, 'countBy') || 1, restart: restart === 'newPage' || restart === 'newSection' ? 'page' : 'continuous' };
      }
      const va = val(sect, 'vAlign');
      if (va) s.page.vAlign = va === 'both' ? 'justify' : (['top', 'center', 'bottom'].includes(va) ? va : 'top') as any;
      const pb = kid(sect, 'pgBorders');
      if (pb) {
        const side = kid(pb, 'top') || kid(pb, 'left') || kid(pb, 'bottom') || kid(pb, 'right');
        if (side) s.pageBorder = ooxmlBorderToCss(attr(side, 'val'), attr(side, 'sz'), attr(side, 'color'));
      }
      const fFmt = val(kid(sect, 'footnotePr'), 'numFmt');
      if (fFmt && PAGE_FMT[fFmt]) s.footnoteFormat.foot = PAGE_FMT[fFmt];
      const eFmt = val(kid(sect, 'endnotePr'), 'numFmt');
      if (eFmt && PAGE_FMT[eFmt]) s.footnoteFormat.end = PAGE_FMT[eFmt];
    }
    // Headers / footers: prefer the final section, fall back to earlier sections (Word inherits them).
    const all = [...(sect ? [sect] : []), ...this.sectPrs];
    const find = (tag: string, type: string): Rel | undefined => {
      for (const sp of all) {
        for (const ref of kidsNamed(sp, tag)) {
          if ((attr(ref, 'type') || 'default') !== type) continue;
          const rel = this.part.rels.get(relAttr(ref, 'id') || '');
          if (rel) return rel;
        }
      }
      return undefined;
    };
    const load = async (tag: string, type: string): Promise<HF | null> => {
      const rel = find(tag, type);
      if (!rel) return null;
      return this.headerFooter(rel.target);
    };
    s.header = (await load('headerReference', 'default')) || s.header;
    s.footer = (await load('footerReference', 'default')) || s.footer;
    s.firstHeader = (await load('headerReference', 'first')) || s.firstHeader;
    s.firstFooter = (await load('footerReference', 'first')) || s.firstFooter;
    s.evenHeader = (await load('headerReference', 'even')) || s.evenHeader;
    s.evenFooter = (await load('footerReference', 'even')) || s.evenFooter;
  }

  private pageFromSect(sect: Element): Partial<DocSettings['page']> {
    const out: any = {};
    const sz = kid(sect, 'pgSz');
    if (sz) {
      const w = ptAttr(sz, 'w') || 612, h = ptAttr(sz, 'h') || 792;
      const orient = attr(sz, 'orient');
      out.orientation = orient === 'landscape' || (!orient && w > h) ? 'landscape' : 'portrait';
      out.width = Math.min(w, h);
      out.height = Math.max(w, h);
      out.sizeName = 'Custom';
      for (const [name, [pw, ph]] of Object.entries(PAGE_SIZES)) {
        if (Math.abs(pw - out.width) <= 2 && Math.abs(ph - out.height) <= 2) { out.sizeName = name; break; }
      }
    }
    const mar = kid(sect, 'pgMar');
    if (mar) {
      const g = (n: string, d: number) => { const v = ptAttr(mar, n); return v == null ? d : Math.abs(v); };
      out.margin = { top: g('top', 72), right: g('right', 72), bottom: g('bottom', 72), left: g('left', 72) };
      out.headerDist = g('header', 36);
      out.footerDist = g('footer', 36);
      out.gutter = g('gutter', 0);
    }
    return out;
  }

  private async headerFooter(path: string): Promise<HF | null> {
    const root = await this.pkg.xml(path);
    if (!root) return null;
    const saved = { part: this.part, stack: this.fieldStack, comments: this.activeComments, pending: this.pendingInlines };
    this.part = { path, rels: await this.pkg.rels(path) };
    this.fieldStack = [];
    this.activeComments = new Set();
    this.pendingInlines = [];
    const hf: HF = { left: '', center: '', right: '' };
    const lines: { left: string[]; center: string[]; right: string[] } = { left: [], center: [], right: [] };
    try {
      for (const el of kids(root)) {
        if (el.localName === 'p') {
          const items: Item[] = [];
          this.paragraph(el, items);
          const tabs = kid(kid(el, 'pPr'), 'tabs');
          const tabStops = kidsNamed(tabs, 'tab').map((t) => attr(t, 'val'));
          for (const it of items) {
            if (!('node' in it) || it.node.type !== S.paragraph) continue;
            const text = tokenText(it.node);
            if (!text.trim()) continue;
            const parts = text.split('\t');
            const align = it.node.attrs.align;
            if (parts.length >= 3) {
              lines.left.push(parts[0]); lines.center.push(parts[1]); lines.right.push(parts.slice(2).join(' ').trim());
            } else if (parts.length === 2) {
              const onlyRight = tabStops.length === 1 && tabStops[0] === 'right';
              lines.left.push(parts[0]);
              (onlyRight ? lines.right : lines.center).push(parts[1]);
            } else if (align === 'center') lines.center.push(text);
            else if (align === 'right') lines.right.push(text);
            else lines.left.push(text);
          }
        } else if (el.localName === 'tbl') {
          const row = kidsNamed(el, 'tr')[0];
          const cells = kidsNamed(row, 'tc').map((tc) => kidsNamed(tc, 'p').map((p) => {
            const items: Item[] = [];
            this.paragraph(p, items);
            return items.map((it) => ('node' in it ? tokenText(it.node) : '')).join(' ');
          }).join(' ').trim());
          if (cells.length >= 3) { lines.left.push(cells[0]); lines.center.push(cells[1]); lines.right.push(cells[cells.length - 1]); } else if (cells.length === 2) { lines.left.push(cells[0]); lines.right.push(cells[1]); } else if (cells[0]) lines.left.push(cells[0]);
        }
      }
    } finally {
      this.part = saved.part;
      this.fieldStack = saved.stack;
      this.activeComments = saved.comments;
      this.pendingInlines = saved.pending;
    }
    const join = (a: string[]) => a.filter((x) => x.trim()).join('\n').trim();
    hf.left = join(lines.left); hf.center = join(lines.center); hf.right = join(lines.right);
    return hf;
  }

  // ---------------------------------------------------------------------------------------
  // Block level

  collectBlocks(elements: Element[], items: Item[]): void {
    for (const el of elements) {
      switch (el.localName) {
        case 'p': this.paragraph(el, items); break;
        case 'tbl': items.push({ node: this.table(el) }); break;
        case 'sdt': this.blockSdt(el, items); break;
        case 'customXml': case 'ins': case 'moveTo': case 'del': case 'moveFrom': case 'smartTag':
          this.collectBlocks(kids(el), items); break;
        case 'AlternateContent': this.collectBlocks(kids(chooseAlternate(el)), items); break;
        case 'bookmarkStart': { const b = this.bookmark(el); if (b) this.pendingInlines.push(b); break; }
        case 'commentRangeStart': this.commentStart(el); break;
        case 'commentRangeEnd': this.activeComments.delete(attr(el, 'id') || ''); break;
        case 'oMathPara': for (const m of desc(el, 'oMath')) items.push({ node: S.math_block.create({ latex: ommlToLatex(m) }) }); break;
        case 'oMath': items.push({ node: S.math_block.create({ latex: ommlToLatex(el) }) }); break;
        default: break; // sectPr, altChunk, proofErr, permStart, ... are ignored
      }
    }
  }

  /** Convert a container's block children (cell, text box, sdt) into blocks. */
  blocksOf(container: Element | null): PMNode[] {
    const items: Item[] = [];
    this.collectBlocks(kids(container), items);
    if (this.pendingInlines.length) {
      items.push({ node: S.paragraph.create(null, this.pendingInlines) });
      this.pendingInlines = [];
    }
    return this.assemble(items.filter((i) => 'node' in i));
  }

  private blockSdt(sdt: Element, items: Item[]): void {
    const pr = kid(sdt, 'sdtPr');
    const content = kid(sdt, 'sdtContent');
    const tag = val(pr, 'tag') || '';
    if (tag.startsWith('qf:textbox')) {
      let opts: unknown = {};
      try { opts = JSON.parse(tag.slice('qf:textbox'.length).replace(/^:/, '') || '{}'); } catch { /* */ }
      const blocks = this.blocksOf(content).map((b) => (b.type === S.paragraph && (b.attrs.border || b.attrs.bg) ? b.type.create({ ...b.attrs, border: null, bg: null }, b.content, b.marks) : b));
      items.push({ node: S.text_box.create(textBoxOpts(opts), blocks.length ? blocks : [emptyPara()]) });
      return;
    }
    this.collectBlocks(kids(content), items);
  }

  private commentStart(el: Element): void {
    const id = attr(el, 'id') || '';
    if (!this.skipComments.has(id)) this.activeComments.add(id);
  }

  private bookmark(el: Element): PMNode | null {
    const name = attr(el, 'name') || '';
    if (!name || name === '_GoBack' || /^_Toc/i.test(name) || this.bookmarkNames.has(name)) return null;
    this.bookmarkNames.add(name);
    return S.bookmark.create({ name });
  }

  // ---------------------------------------------------------------------------------------
  // Paragraphs

  private paraAttrs(pPr: Element | null): Record<string, any> {
    const a: Record<string, any> = {};
    const sid = val(pPr, 'pStyle') || this.defaultParaStyle;
    if (sid) this.usedStyles.add(sid);
    a.style = this.styleName(sid);
    Object.assign(a, parsePPr(pPr));
    return a;
  }

  private listInfo(pPr: Element | null): ListInfo | null {
    const numPr = kid(pPr, 'numPr');
    const directNum = val(numPr, 'numId');
    let numId = directNum;
    let ilvl = intAttr(kid(numPr, 'ilvl'), 'val'); // null when absent or not a number (NaN would pass the clamp below)
    if (numId == null) {
      let sid = val(pPr, 'pStyle') || this.defaultParaStyle;
      for (let guard = 0; sid && guard < 12; guard++) {
        const st = this.styles.get(sid);
        if (!st) break;
        if (st.numId != null) { numId = st.numId; if (ilvl == null) ilvl = st.ilvl ?? 0; break; }
        sid = st.basedOn;
      }
    }
    if (numId == null || numId === '0' || !this.nums.has(numId)) return null;
    return { numId, ilvl: Math.max(0, Math.min(8, ilvl ?? 0)) };
  }

  paragraph(p: Element, items: Item[]): void {
    const pPr = kid(p, 'pPr');
    const attrs = this.paraAttrs(pPr);
    let list = this.listInfo(pPr);
    // Outline numbering without a number (LibreOffice's default chapter numbering) is not a list.
    if (list && /^(Heading \d|Title)$/.test(attrs.style)) {
      const def = this.levelDef(list.numId, list.ilvl);
      if (def.kind === 'bullet' && def.bullet === 'none') list = null;
    }
    if (list) {
      if (attrs.style === 'List Paragraph') attrs.style = 'Normal';
      attrs.indentLeft = null;
      attrs.indentFirst = null;
    }
    const frame = kid(pPr, 'framePr');
    const dropCap = frame && /^(drop|margin)$/.test(attr(frame, 'dropCap') || '') ? (intAttr(frame, 'lines') || 3) : 0;
    const pb = new ParaBuilder(this, attrs);
    if (this.pendingDropCap && !dropCap) {
      attrs.dropCap = this.pendingDropCap.lines;
      pb.cur.push(...this.pendingDropCap.inlines);
      this.pendingDropCap = null;
    }
    if (this.pendingInlines.length) {
      pb.cur.push(...this.pendingInlines);
      this.pendingInlines = [];
    }
    this.walkInline(p, pb, Mark.none);
    for (const f of this.fieldStack) if (f.phase === 'result' && (f.mode === 'capture' || f.mode === 'suppress')) f.result += '\n';

    if (dropCap) {
      const inl = [...pb.cur];
      this.pendingDropCap = { lines: dropCap, inlines: inl };
      return;
    }
    const blocks = pb.finish();
    const sect = kid(pPr, 'sectPr');
    let first = true;
    for (const b of blocks) {
      // An empty paragraph that only carries section properties is dropped.
      if (sect && b.type === S.paragraph && b.childCount === 0 && blocks.length === 1) break;
      if (first && b.type === S.paragraph && list) items.push({ node: b, list });
      else if (first && b.type === S.paragraph && attrs.style === 'List Paragraph') items.push({ node: b, listCont: true });
      else items.push({ node: b });
      first = false;
    }
    if (sect) { items.push({ sect }); this.sectPrs.push(sect); }
  }

  walkInline(el: Element, pb: ParaBuilder, wrap: readonly Mark[]): void {
    for (const c of kids(el)) this.inlineEl(c, pb, wrap);
  }

  private inlineEl(c: Element, pb: ParaBuilder, wrap: readonly Mark[]): void {
    switch (c.localName) {
      case 'r': this.run(c, pb, wrap); break;
      case 'hyperlink': {
        const rel = this.part.rels.get(relAttr(c, 'id') || '');
        const anchor = attr(c, 'anchor');
        let href = rel ? rel.target : '';
        if (anchor) href = href ? `${href}#${anchor}` : `#${anchor}`;
        const m = href ? MK.link.create({ href, title: attr(c, 'tooltip') }) : null;
        this.walkInline(c, pb, m ? m.addToSet(wrap) : wrap);
        break;
      }
      case 'ins': case 'moveTo':
        this.walkInline(c, pb, MK.insertion.create(this.revAttrs(c)).addToSet(wrap)); break;
      case 'del': case 'moveFrom':
        this.walkInline(c, pb, MK.deletion.create(this.revAttrs(c)).addToSet(wrap)); break;
      case 'smartTag': case 'customXml': case 'bdo':
        this.walkInline(c, pb, wrap); break;
      case 'dir':
        this.walkInline(c, pb, attr(c, 'val') === 'rtl' ? MK.dir.create({ dir: 'rtl' }).addToSet(wrap) : wrap); break;
      case 'sdt': this.inlineSdt(c, pb, wrap); break;
      case 'fldSimple': {
        const frame = this.beginField(this.runMarks(kid(firstDesc(c, 'r'), 'rPr'), wrap), null, onOff(attr(c, 'fldLock') ?? '0'));
        frame.instr = attr(c, 'instr') || '';
        this.separateField();
        this.walkInline(c, pb, wrap);
        this.endField(pb);
        break;
      }
      case 'bookmarkStart': { const b = this.bookmark(c); if (b) pb.inline(b); break; }
      case 'commentRangeStart': this.commentStart(c); break;
      case 'commentRangeEnd': this.activeComments.delete(attr(c, 'id') || ''); break;
      case 'oMath': pb.inline(S.math_inline.create({ latex: ommlToLatex(c) }, null, this.runMarks(null, wrap))); break;
      case 'oMathPara': for (const m of desc(c, 'oMath')) pb.block(S.math_block.create({ latex: ommlToLatex(m) })); break;
      case 'AlternateContent': this.walkInline(chooseAlternate(c), pb, wrap); break;
      default: break; // pPr, proofErr, permStart/End, bookmarkEnd, moveFromRangeStart ...
    }
  }

  private revAttrs(el: Element): Record<string, any> {
    const d = Date.parse(attr(el, 'date') || '');
    return { author: attr(el, 'author') || '', date: Number.isFinite(d) ? d : 0, id: attr(el, 'id') || '' };
  }

  /** Marks for a run: wrapper marks (link, revisions) + rPr formatting + active comments. */
  runMarks(rPr: Element | null, wrap: readonly Mark[]): readonly Mark[] {
    let set: readonly Mark[] = Mark.none;
    const inLink = wrap.some((m) => m.type === MK.link) || this.fieldStack.some((f) => f.linkMark);
    for (const m of this.rPrMarks(rPr, inLink)) set = m.addToSet(set);
    for (const m of wrap) set = m.addToSet(set);
    for (const id of this.activeComments) set = MK.comment.create({ id }).addToSet(set);
    return set;
  }

  private fontOf(rFonts: Element | null): string | null {
    if (!rFonts) return null;
    const theme = attr(rFonts, 'asciiTheme') || attr(rFonts, 'hAnsiTheme');
    if (theme) {
      const t = /^major/.test(theme) ? this.themeMajor : this.themeMinor;
      if (t) return t;
    }
    return attr(rFonts, 'ascii') || attr(rFonts, 'hAnsi') || attr(rFonts, 'cs') || null;
  }

  private rPrMarks(rPr: Element | null, inLink: boolean): Mark[] {
    const out: Mark[] = [];
    if (!rPr) return out;
    const rs = val(rPr, 'rStyle');
    let isCode = false;
    if (rs && rs !== this.defaultCharStyle) {
      const name = this.styleName(rs);
      this.usedStyles.add(rs);
      if (name === 'HTML Code') { isCode = true; out.push(MK.code.create()); } else if (!(inLink && name === 'Hyperlink') && !/^(Footnote|Endnote|Comment) Reference$/.test(name) && name !== 'Default Paragraph Font') {
        out.push(MK.charStyle.create({ name }));
      }
    }
    if (flag(rPr, 'b')) out.push(MK.bold.create());
    if (flag(rPr, 'i')) out.push(MK.italic.create());
    const u = kid(rPr, 'u');
    if (u) {
      const v = attr(u, 'val') || 'single';
      if (v !== 'none') out.push(MK.underline.create({ style: UNDERLINE[v] || 'single', color: ooxmlColorToCss(attr(u, 'color')) }));
    }
    if (flag(rPr, 'strike')) out.push(MK.strike.create());
    if (flag(rPr, 'dstrike')) out.push(MK.dstrike.create());
    const va = val(rPr, 'vertAlign');
    if (va === 'superscript') out.push(MK.sup.create());
    else if (va === 'subscript') out.push(MK.sub.create());
    if (flag(rPr, 'smallCaps')) out.push(MK.smallcaps.create());
    if (flag(rPr, 'caps')) out.push(MK.allcaps.create());
    if (flag(rPr, 'vanish')) out.push(MK.hidden.create());
    const font = this.fontOf(kid(rPr, 'rFonts'));
    if (font && !(isCode && /^courier new$/i.test(font))) out.push(MK.font.create({ family: font }));
    const sz = val(rPr, 'sz');
    if (sz && !isCode) { const n = parseFloat(sz); if (n > 0) out.push(MK.size.create({ pt: n / 2 })); }
    const color = ooxmlColorToCss(val(rPr, 'color'));
    if (color) out.push(MK.color.create({ color }));
    const hl = val(rPr, 'highlight');
    if (hl && hl !== 'none' && HIGHLIGHT_COLORS[hl]) out.push(MK.highlight.create({ color: '#' + HIGHLIGHT_COLORS[hl] }));
    const shd = kid(rPr, 'shd');
    const fill = ooxmlColorToCss(attr(shd, 'fill'));
    if (fill && attr(shd, 'val') !== 'nil') out.push(MK.shading.create({ color: fill }));
    const sp = twAttr(kid(rPr, 'spacing'), 'val');
    if (sp) out.push(MK.spacing.create({ pt: round2(sp / 20) }));
    const pos = val(rPr, 'position');
    if (pos && parseFloat(pos)) out.push(MK.position.create({ pt: parseFloat(pos) / 2 }));
    const w = val(rPr, 'w');
    if (w && parseFloat(w) !== 100 && parseFloat(w) > 0) out.push(MK.scale.create({ pct: parseFloat(w) }));
    const lang = val(rPr, 'lang');
    const noProof = !!flag(rPr, 'noProof');
    if ((lang && lang !== this.defaultLang) || noProof) out.push(MK.lang.create({ lang: lang || this.defaultLang || 'en-US', noProof }));
    if (flag(rPr, 'rtl')) out.push(MK.dir.create({ dir: 'rtl' }));
    const bdr = kid(rPr, 'bdr');
    if (bdr) { const css = ooxmlBorderToCss(attr(bdr, 'val'), attr(bdr, 'sz'), attr(bdr, 'color')); if (css) out.push(MK.charBorder.create({ border: css })); }
    for (const [tag, kind] of [['outline', 'outline'], ['shadow', 'shadow'], ['emboss', 'emboss'], ['imprint', 'engrave']] as const) {
      if (flag(rPr, tag)) { out.push(MK.effect.create({ kind })); break; }
    }
    return out;
  }

  private run(r: Element, pb: ParaBuilder, wrap: readonly Mark[]): void {
    const marks = this.runMarks(kid(r, 'rPr'), wrap);
    const children = kids(r);
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.localName === 'footnoteReference' || c.localName === 'endnoteReference') {
        const id = attr(c, 'id') || '';
        const kind = c.localName === 'footnoteReference' ? 'foot' : 'end';
        let mark: string | null = null;
        if (onOff(attr(c, 'customMarkFollows') ?? '0')) {
          const next = children[i + 1];
          if (next && next.localName === 't') { mark = next.textContent || null; i++; }
        }
        const text = (kind === 'foot' ? this.footnotes : this.endnotes).get(id) || '';
        pb.inline(S.footnote.create({ text, kind, id, mark }, null, marks));
        continue;
      }
      this.runChild(c, pb, marks, wrap);
    }
  }

  private runChild(c: Element, pb: ParaBuilder, marks: readonly Mark[], wrap: readonly Mark[]): void {
    switch (c.localName) {
      case 't': case 'delText': pb.text(c.textContent || '', marks); break;
      case 'instrText': case 'delInstrText': {
        const top = this.fieldStack[this.fieldStack.length - 1];
        if (top && top.phase === 'instr') top.instr += c.textContent || '';
        break;
      }
      case 'tab': case 'ptab': pb.text('\t', marks); break;
      case 'br': {
        const type = attr(c, 'type');
        if (type === 'page') pb.block(S.page_break.create());
        else if (type === 'column') pb.block(S.column_break.create());
        else pb.inline(S.hard_break.create(null, null, marks));
        break;
      }
      case 'cr': pb.inline(S.hard_break.create(null, null, marks)); break;
      case 'noBreakHyphen': pb.text('‑', marks); break;
      case 'softHyphen': pb.text('­', marks); break;
      case 'sym': {
        const code = parseInt(attr(c, 'char') || '', 16);
        if (!Number.isFinite(code)) break;
        const font = attr(c, 'font');
        const ch = String.fromCharCode(code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code);
        pb.text(ch, font ? MK.font.create({ family: font }).addToSet(marks) : marks);
        break;
      }
      case 'fldChar': {
        const type = attr(c, 'fldCharType');
        if (type === 'begin') this.beginField(marks, kid(c, 'ffData'), onOff(attr(c, 'fldLock') ?? '0'));
        else if (type === 'separate') this.separateField();
        else if (type === 'end') this.endField(pb);
        break;
      }
      case 'drawing': this.drawing(c, pb, marks); break;
      case 'pict': case 'object': this.pict(c, pb, marks); break;
      case 'AlternateContent': for (const k of kids(chooseAlternate(c))) this.runChild(k, pb, marks, wrap); break;
      case 'ruby': {
        const rt = plainText(kid(c, 'rt'));
        const ruby = rt ? MK.ruby.create({ text: rt }) : null;
        this.walkInline(kid(c, 'rubyBase') || c, pb, ruby ? ruby.addToSet(wrap) : wrap);
        break;
      }
      default: break; // rPr, lastRenderedPageBreak, footnoteRef, annotationRef, commentReference, separator ...
    }
  }

  // ---------------------------------------------------------------------------------------
  // Fields

  sink(): Sink {
    const extra: Mark[] = [];
    for (const f of this.fieldStack) {
      if (f.phase === 'instr') return { kind: 'instr', frame: f };
      if (f.mode === 'capture' || f.mode === 'suppress') return { kind: 'capture', frame: f };
      if (f.mode === 'link' && f.linkMark) extra.push(f.linkMark);
    }
    return { kind: 'emit', extra };
  }

  private beginField(marks: readonly Mark[], ffData: Element | null, locked: boolean): FieldFrame {
    const f: FieldFrame = { instr: '', phase: 'instr', mode: null, result: '', marks, info: null, ffData, linkMark: null, locked, genKind: null, genOptions: {} };
    this.fieldStack.push(f);
    return f;
  }

  private separateField(): void {
    const f = this.fieldStack[this.fieldStack.length - 1];
    if (!f || f.phase !== 'instr') return;
    f.phase = 'result';
    this.decideField(f);
  }

  private decideField(f: FieldFrame): void {
    const info = parseFieldInstr(f.instr);
    f.info = info;
    const sw = (n: string) => info.switches.find((s) => s.name.toLowerCase() === n.toLowerCase());
    switch (info.type) {
      case 'HYPERLINK': {
        let href = info.args[0] || '';
        const l = sw('l')?.value;
        if (l) href = href ? `${href}#${l}` : `#${l}`;
        f.mode = 'link';
        f.linkMark = href ? MK.link.create({ href, title: sw('o')?.value || null }) : null;
        return;
      }
      case 'TOC': {
        const c = sw('c')?.value || sw('a')?.value;
        f.mode = 'suppress';
        f.genKind = c || sw('a') ? 'tof' : 'toc';
        const o = sw('o')?.value;
        const m = o ? /(\d)\s*-\s*(\d)/.exec(o) : null;
        if (m) f.genOptions.levels = parseInt(m[2], 10);
        if (c) f.genOptions.label = c;
        return;
      }
      case 'INDEX': f.mode = 'suppress'; f.genKind = 'index'; return;
      case 'BIBLIOGRAPHY': f.mode = 'suppress'; f.genKind = 'bibliography'; return;
      case 'TOA': f.mode = 'suppress'; f.genKind = 'toa'; return;
      case 'XE': case 'TC': case 'FORMCHECKBOX': case 'FORMDROPDOWN': f.mode = 'capture'; return;
      default:
        f.mode = KNOWN_FIELDS.has(info.type) ? 'capture' : 'pass';
    }
  }

  private endField(pb: ParaBuilder): void {
    const f = this.fieldStack.pop();
    if (!f) return;
    if (f.phase === 'instr') { f.phase = 'result'; this.decideField(f); }
    const info = f.info!;
    if (f.mode === 'suppress') {
      const lines = f.result.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
      const cache = lines.map((l) => `<p>${escapeXmlText(l, '&#39;')}</p>`).join('');
      pb.block(S.gen_block.create({ kind: f.genKind || 'toc', options: f.genOptions, cache }));
      return;
    }
    if (f.mode !== 'capture') return;
    const node = this.fieldNode(f, info);
    if (node) pb.inline(node);
  }

  private fieldNode(f: FieldFrame, info: FieldInstr): PMNode | null {
    const sw = (n: string) => info.switches.find((s) => s.name.toLowerCase() === n.toLowerCase());
    const marks = f.marks;
    switch (info.type) {
      case 'TC': return null;
      case 'XE': {
        const [term, sub] = (info.args[0] || '').split(':');
        return S.index_entry.create({ term: term || '', sub: sub ?? null, see: sw('t')?.value || null, bold: !!sw('b'), italic: !!sw('i') }, null, marks);
      }
      case 'FORMCHECKBOX': {
        const cb = kid(f.ffData, 'checkBox');
        const checked = kid(cb, 'checked') ? onOff(attr(kid(cb, 'checked'), 'val')) : onOff(attr(kid(cb, 'default'), 'val') ?? '0');
        return S.control.create({ kind: 'checkbox', value: checked ? 'true' : 'false', tag: val(f.ffData, 'name') || '' }, null, marks);
      }
      case 'FORMDROPDOWN': {
        const dd = kid(f.ffData, 'ddList');
        const opts = kidsNamed(dd, 'listEntry').map((e) => attr(e, 'val') || '');
        const idx = parseInt(val(dd, 'result') || val(dd, 'default') || '0', 10) || 0;
        return S.control.create({ kind: 'dropdown', options: opts.join('|'), value: opts[idx] || '', tag: val(f.ffData, 'name') || '' }, null, marks);
      }
      default: {
        let format = info.format;
        let arg = info.arg;
        if (info.type === '=') arg = info.args[0] || null;
        if (info.type === 'SECTIONPAGES') return S.field.create({ type: 'NUMPAGES', format, arg: null, value: f.result.replace(/\n+$/, ''), locked: f.locked }, null, marks);
        if (format === '') format = null;
        // Date pictures sometimes escape literal characters (LibreOffice writes "M\/d\/yyyy").
        if (format && DATE_FIELDS.has(info.type)) format = format.replace(/\\(.)/g, '$1');
        return S.field.create({ type: info.type, format, arg, value: f.result.replace(/\n+$/, '').replace(/\n/g, ' '), locked: f.locked }, null, marks);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Content controls

  private inlineSdt(sdt: Element, pb: ParaBuilder, wrap: readonly Mark[]): void {
    const pr = kid(sdt, 'sdtPr');
    const content = kid(sdt, 'sdtContent');
    const tag = val(pr, 'tag') || '';
    const label = val(pr, 'alias') || '';
    const marks = this.runMarks(kid(firstDesc(content, 'r'), 'rPr'), wrap);
    const text = plainText(content);
    const cb = kid(pr, 'checkbox');
    if (cb) {
      const checked = onOff(attr(kid(cb, 'checked'), 'val') ?? '0');
      pb.inline(S.control.create({ kind: 'checkbox', value: checked ? 'true' : 'false', label, tag }, null, marks));
      return;
    }
    const dd = kid(pr, 'dropDownList') || kid(pr, 'comboBox');
    if (dd) {
      const opts = kidsNamed(dd, 'listItem').map((li) => attr(li, 'displayText') || attr(li, 'value') || '').filter((x) => x);
      const placeholder = !!kid(pr, 'showingPlcHdr');
      pb.inline(S.control.create({ kind: 'dropdown', options: opts.join('|'), value: placeholder ? '' : text, label, tag }, null, marks));
      return;
    }
    const date = kid(pr, 'date');
    if (date) {
      const placeholder = !!kid(pr, 'showingPlcHdr');
      pb.inline(S.control.create({ kind: 'date', value: placeholder ? '' : text, options: val(date, 'dateFormat') || '', label, tag }, null, marks));
      return;
    }
    if (content) this.walkInline(content, pb, wrap);
  }

  // ---------------------------------------------------------------------------------------
  // Images and text boxes

  private drawing(d: Element, pb: ParaBuilder, marks: readonly Mark[]): void {
    const box = kid(d, 'inline') || kid(d, 'anchor');
    if (!box) return;
    const anchored = box.localName === 'anchor';
    const ext = kid(box, 'extent');
    const cx = intAttr(ext, 'cx'), cy = intAttr(ext, 'cy');
    const width = cx ? round2(cx / 12700) : null;
    const height = cy ? round2(cy / 12700) : null;
    const docPr = kid(box, 'docPr');
    let wrapMode = 'inline';
    if (anchored) {
      const align = (firstDesc(kid(box, 'positionH'), 'align')?.textContent || '').trim();
      if (kid(box, 'wrapSquare') || kid(box, 'wrapTight') || kid(box, 'wrapThrough')) wrapMode = align === 'right' || align === 'outside' ? 'right' : align === 'center' ? 'center' : 'left';
      else if (kid(box, 'wrapTopAndBottom')) wrapMode = align === 'center' ? 'center' : 'topBottom';
      else wrapMode = onOff(attr(box, 'behindDoc') ?? '0') ? 'behind' : 'front';
    }
    const txbx = firstDesc(box, 'txbxContent');
    if (txbx) {
      const blocks = this.blocksOf(txbx);
      const spPr = firstDesc(box, 'spPr');
      const fill = firstDesc(kid(spPr, 'solidFill'), 'srgbClr');
      const ln = kid(spPr, 'ln');
      let border: string | null = '1px solid #444';
      if (ln && kid(ln, 'noFill')) border = null;
      else if (ln) {
        const c = attr(firstDesc(kid(ln, 'solidFill'), 'srgbClr'), 'val');
        const w = intAttr(ln, 'w');
        border = `${w ? round2(w / 12700) : 0.75}pt solid ${c ? '#' + c.toLowerCase() : '#444444'}`;
      }
      pb.afterBlock(S.text_box.create({
        float: wrapMode === 'left' || wrapMode === 'right' ? wrapMode : 'none',
        width: width ? String(Math.round(width)) : null,
        bg: fill ? '#' + (attr(fill, 'val') || 'ffffff').toLowerCase() : null,
        border,
      }, blocks.length ? blocks : [emptyPara()]));
      return;
    }
    const blip = firstDesc(box, 'blip');
    if (!blip) return;
    const svg = firstDesc(blip, 'svgBlip');
    const src = this.mediaFor(relAttr(svg, 'embed')) || this.mediaFor(relAttr(blip, 'embed')) || this.mediaFor(relAttr(blip, 'link'));
    if (!src) return;
    const xfrm = firstDesc(firstDesc(box, 'spPr'), 'xfrm') || firstDesc(box, 'xfrm');
    const rot = intAttr(xfrm, 'rot');
    const hl = kid(docPr, 'hlinkClick');
    const linkRel = hl ? this.part.rels.get(relAttr(hl, 'id') || '') : undefined;
    pb.inline(S.image.create({
      src, alt: attr(docPr, 'descr') || '', title: attr(docPr, 'title') || null, width, height, wrap: wrapMode,
      rotate: rot ? round2(rot / 60000) : 0, flipH: onOff(attr(xfrm, 'flipH') ?? '0'), flipV: onOff(attr(xfrm, 'flipV') ?? '0'),
      link: linkRel ? linkRel.target : null,
    }, null, marks));
  }

  private pict(el: Element, pb: ParaBuilder, marks: readonly Mark[]): void {
    const txbx = firstDesc(el, 'txbxContent');
    const shape = firstDesc(el, 'shape') || firstDesc(el, 'rect') || firstDesc(el, 'roundrect');
    const style = attr(shape, 'style') || '';
    const dim = (n: string) => {
      const m = new RegExp(`(?:^|;)\\s*${n}\\s*:\\s*([\\d.]+)(pt|in|px|cm|mm)?`, 'i').exec(style);
      if (!m) return null;
      const v = parseFloat(m[1]);
      switch (m[2]) { case 'in': return v * 72; case 'px': return v * 0.75; case 'cm': return (v / 2.54) * 72; case 'mm': return (v / 25.4) * 72; default: return v; }
    };
    if (txbx) {
      const blocks = this.blocksOf(txbx);
      const w = dim('width');
      pb.afterBlock(S.text_box.create({ width: w ? String(Math.round(w)) : null, float: /mso-position-horizontal:\s*right/.test(style) ? 'right' : 'none' }, blocks.length ? blocks : [emptyPara()]));
      return;
    }
    const img = firstDesc(el, 'imagedata');
    if (!img) return;
    const src = this.mediaFor(relAttr(img, 'id') || relAttr(img, 'pict'));
    if (!src) return;
    pb.inline(S.image.create({ src, alt: attr(shape, 'alt') || attr(img, 'title') || '', width: dim('width'), height: dim('height') }, null, marks));
  }

  // ---------------------------------------------------------------------------------------
  // Tables

  private table(tbl: Element): PMNode {
    const tblPr = kid(tbl, 'tblPr');
    const grid = kidsNamed(kid(tbl, 'tblGrid'), 'gridCol').map((g) => twAttr(g, 'w') || 0);
    const rowEls: Element[] = [];
    const gatherRows = (el: Element) => {
      for (const c of kids(el)) {
        if (c.localName === 'tr') rowEls.push(c);
        else if (c.localName === 'sdt') gatherRows(kid(c, 'sdtContent') || c);
        else if (c.localName === 'customXml' || c.localName === 'ins' || c.localName === 'del') gatherRows(c);
      }
    };
    gatherRows(tbl);

    /** el null: an empty placeholder for w:gridBefore / w:gridAfter columns. */
    interface CellInfo { el: Element | null; col: number; span: number; vm: 'restart' | 'continue' | null; rowspan: number }
    const rows: { el: Element; cells: CellInfo[]; header: boolean }[] = [];
    // Spans never reach past the grid (63 columns, Word's limit, when there is none).
    const maxCols = grid.length || 63;
    const clampSpan = (n: number, col: number) => Math.max(1, Math.min(n, maxCols - col));
    for (const tr of rowEls) {
      const trPr = kid(tr, 'trPr');
      let col = 0;
      const cells: CellInfo[] = [];
      const before = Math.min(maxCols - 1, Math.max(0, parseInt(val(trPr, 'gridBefore') || '0', 10) || 0));
      if (before > 0) { cells.push({ el: null, col, span: before, vm: null, rowspan: 1 }); col += before; }
      const tcs: Element[] = [];
      const gatherCells = (el: Element) => {
        for (const c of kids(el)) {
          if (c.localName === 'tc') tcs.push(c);
          else if (c.localName === 'sdt') gatherCells(kid(c, 'sdtContent') || c);
          else if (c.localName === 'customXml') gatherCells(c);
        }
      };
      gatherCells(tr);
      for (const tc of tcs) {
        const tcPr = kid(tc, 'tcPr');
        const span = clampSpan(parseInt(val(tcPr, 'gridSpan') || '1', 10) || 1, col);
        const hm = kid(tcPr, 'hMerge');
        if (hm && attr(hm, 'val') !== 'restart' && cells.length) { cells[cells.length - 1].span += span; col += span; continue; }
        const vmEl = kid(tcPr, 'vMerge');
        const vm = vmEl ? (attr(vmEl, 'val') === 'restart' ? 'restart' : 'continue') : null;
        cells.push({ el: tc, col, span, vm, rowspan: 1 });
        col += span;
      }
      const after = Math.max(0, Math.min(maxCols - col, parseInt(val(trPr, 'gridAfter') || '0', 10) || 0));
      if (after > 0) cells.push({ el: null, col, span: after, vm: null, rowspan: 1 });
      rows.push({ el: tr, cells, header: !!flag(trPr, 'tblHeader') });
    }
    // Rowspans: count following continue-cells in the same grid column.
    for (let r = 0; r < rows.length; r++) {
      for (const c of rows[r].cells) {
        if (c.vm !== 'restart') continue;
        let n = 1;
        for (let k = r + 1; k < rows.length; k++) {
          const below = rows[k].cells.find((x) => x.col === c.col);
          if (below && below.vm === 'continue') n++; else break;
        }
        c.rowspan = n;
      }
    }
    let headerRows = 0;
    while (headerRows < rows.length && rows[headerRows].header) headerRows++;

    const pmRows: PMNode[] = [];
    rows.forEach((row, r) => {
      const isHeader = r < headerRows;
      const cellNodes: PMNode[] = [];
      for (const c of row.cells) {
        if (c.vm === 'continue') {
          // A continuation without a restart above it is treated as a normal cell.
          const above = rows.slice(0, r).some((pr) => pr.cells.some((x) => x.col === c.col && x.vm === 'restart'));
          if (above) continue;
        }
        const tcPr = c.el ? kid(c.el, 'tcPr') : null;
        let colwidth: number[] | null = null;
        const gw = grid.slice(c.col, c.col + c.span);
        if (gw.length === c.span && gw.every((x) => x > 0)) colwidth = gw.map((x) => Math.round(x / 15));
        else {
          const tcW = kid(tcPr, 'tcW');
          const w = twAttr(tcW, 'w');
          if (w && (attr(tcW, 'type') || 'dxa') === 'dxa') colwidth = Array.from({ length: c.span }, () => Math.round(w / 15 / c.span));
        }
        const shd = kid(tcPr, 'shd');
        const fill = attr(shd, 'val') === 'nil' ? null : ooxmlColorToCss(attr(shd, 'fill'));
        const va = val(tcPr, 'vAlign');
        const borders = bordersJson(kid(tcPr, 'tcBorders'));
        // A cell may start with a nested table (block+), so no paragraph is added in front of it.
        const blocks = c.el ? this.blocksOf(c.el) : [];
        const content = blocks.length ? blocks : [emptyPara()];
        const type = isHeader ? S.table_header : S.table_cell;
        cellNodes.push(type.create({
          colspan: c.span, rowspan: c.rowspan, colwidth,
          background: fill, valign: va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : va === 'top' ? 'top' : null,
          borders, textDir: val(tcPr, 'textDirection'),
        }, content));
      }
      if (cellNodes.length) pmRows.push(S.table_row.create(null, cellNodes));
      else {
        // An empty row (fully merged): shrink rowspans that crossed it.
        for (let k = 0; k < r; k++) for (const c of rows[k].cells) if (c.vm === 'restart' && k + c.rowspan > r) c.rowspan--;
      }
    });
    if (!pmRows.length) pmRows.push(S.table_row.create(null, [S.table_cell.create(null, [emptyPara()])]));

    const styleId = val(tblPr, 'tblStyle');
    if (styleId) this.usedStyles.add(styleId);
    const styleName = tableStyleFor(styleId ? this.styleName(styleId) : null);
    const tblW = kid(tblPr, 'tblW');
    let width: string | number | null = null;
    const wType = attr(tblW, 'type');
    const wVal = attr(tblW, 'w');
    if (wType === 'pct' && wVal) width = wVal.endsWith('%') ? wVal : `${round2(parseFloat(wVal) / 50)}%`;
    else if (wType === 'dxa' && wVal && parseFloat(wVal) > 0) width = round2((parseTwips(wVal) || 0) / 20);
    const jc = val(tblPr, 'jc');
    const look = kid(tblPr, 'tblLook');
    const lookVal = parseInt(attr(look, 'val') || '0', 16) || 0;
    const lk = (name: string, bit: number) => { const a = attr(look, name); return a != null ? onOff(a) : !!(lookVal & bit); };
    const firstRow = look ? lk('firstRow', 0x20) : false;
    const tableStyleDef = BUILTIN_STYLES.find((s) => s.name === styleName);
    return S.table.create({
      style: styleName, width,
      align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : null,
      indent: ptAttr(kid(tblPr, 'tblInd'), 'w') || null,
      headerRows: headerRows || (firstRow && tableStyleDef?.headerBg ? 1 : 0),
      banded: look ? !lk('noHBand', 0x200) : true,
      firstCol: look ? lk('firstColumn', 0x80) : false,
      lastRow: look ? lk('lastRow', 0x40) : false,
      lastCol: look ? lk('lastColumn', 0x100) : false,
      bandedCols: look ? !lk('noVBand', 0x400) : false,
      layout: attr(kid(tblPr, 'tblLayout'), 'type') === 'fixed' ? 'fixed' : 'auto',
    }, pmRows);
  }

  // ---------------------------------------------------------------------------------------
  // Assembly: lists, code blocks, rules, sections

  assemble(items: Item[]): PMNode[] {
    /** indented: a code block indented like list text (written for a code block inside a list item). */
    const flat: { node: PMNode; list?: ListInfo; listCont?: boolean; indented?: boolean }[] = [];
    // Merge "Code" paragraphs into code blocks, detect horizontal rules.
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (!('node' in it)) continue;
      const n = it.node;
      // Hidden spacer paragraph between two tables (written by Anne's Pen to keep them apart).
      if (n.type === S.paragraph && n.childCount === 0 && n.attrs.hidden && flat.length && flat[flat.length - 1].node.type === S.table) {
        const nx = items[k + 1];
        if (nx && 'node' in nx && nx.node.type === S.table) continue;
      }
      if (!it.list && n.type === S.paragraph && n.attrs.style === 'Code') {
        const prev = flat[flat.length - 1];
        const line = codeLine(n);
        if (prev && !prev.list && prev.node.type === S.code_block) {
          const text = prev.node.textContent + '\n' + line;
          prev.node = S.code_block.create(null, text ? schema.text(text) : null);
        } else flat.push({ node: S.code_block.create(null, line ? schema.text(line) : null), indented: (n.attrs.indentLeft || 0) > 0 });
        continue;
      }
      if (!it.list && n.type === S.paragraph && n.childCount === 0 && n.attrs.border) {
        const hr = ruleFrom(n);
        if (hr) { flat.push({ node: hr }); continue; }
      }
      flat.push(it);
    }

    interface OpenList { numId: string; level: number; kind: 'bullet' | 'ordered'; attrs: Record<string, any>; items: PMNode[][] }
    const out: PMNode[] = [];
    const stack: OpenList[] = [];
    const lastItem = (l: OpenList) => { if (!l.items.length) l.items.push([emptyPara()]); return l.items[l.items.length - 1]; };
    const closeTop = () => {
      const l = stack.pop()!;
      const node = buildList(l.kind, l.attrs, l.items);
      if (stack.length) lastItem(stack[stack.length - 1]).push(node); else out.push(node);
    };
    const closeAll = () => { while (stack.length) closeTop(); };
    // A table or code block followed (past other such blocks) by an item of the same list belongs to
    // the item before it: Word has no other way to put one inside a list item.
    const inItem = (n: PMNode) => n.type === S.table || n.type === S.code_block;
    const nextNum: (string | null)[] = new Array(flat.length).fill(null);
    for (let k = flat.length - 2; k >= 0; k--) {
      const nx = flat[k + 1];
      nextNum[k] = nx.list ? nx.list.numId : !nx.listCont && inItem(nx.node) ? nextNum[k + 1] : null;
    }
    for (let k = 0; k < flat.length; k++) {
      const it = flat[k];
      if (!it.list && !it.listCont && stack.length && inItem(it.node) && (it.indented || nextNum[k] === stack[0].numId)) {
        lastItem(stack[stack.length - 1]).push(it.node);
        continue;
      }
      if (it.list) {
        const { numId, ilvl } = it.list;
        const def = this.levelDef(numId, ilvl);
        if (stack.length && stack[0].numId !== numId) closeAll();
        while (stack.length && stack[stack.length - 1].level > ilvl) closeTop();
        let top = stack[stack.length - 1];
        const attrs = def.kind === 'bullet' ? { bullet: def.bullet } : { format: def.format, suffix: def.suffix, outline: def.outline };
        if (top && top.level === ilvl && (top.kind !== def.kind || (def.kind === 'bullet' ? top.attrs.bullet !== def.bullet : top.attrs.format !== def.format))) { closeTop(); top = stack[stack.length - 1]; }
        let counters = this.counters.get(def.counterKey);
        if (!counters) { counters = new Array(9).fill(0); this.counters.set(def.counterKey, counters); }
        if (!top || top.level < ilvl) {
          if (top) lastItem(top);
          const a: Record<string, any> = { ...attrs };
          if (def.kind === 'ordered') a.order = def.start + counters[ilvl];
          stack.push({ numId, level: ilvl, kind: def.kind, attrs: a, items: [] });
          top = stack[stack.length - 1];
        }
        counters[ilvl]++;
        for (let k = ilvl + 1; k < 9; k++) counters[k] = 0;
        top.items.push([it.node]);
      } else if (it.listCont && stack.length) {
        lastItem(stack[stack.length - 1]).push(it.node.type === S.paragraph && it.node.attrs.style === 'List Paragraph'
          ? it.node.type.create({ ...it.node.attrs, style: 'Normal', indentLeft: null, indentFirst: null }, it.node.content, it.node.marks) : it.node);
      } else {
        closeAll();
        out.push(it.node);
      }
    }
    closeAll();
    return out;
  }

  private assembleSections(items: Item[], bodySect: Element | null): PMNode[] {
    const sections: { items: Item[]; sect: Element | null }[] = [{ items: [], sect: null }];
    for (const it of items) {
      if ('sect' in it) {
        sections[sections.length - 1].sect = it.sect;
        sections.push({ items: [], sect: null });
      } else sections[sections.length - 1].items.push(it);
    }
    sections[sections.length - 1].sect = bodySect;
    const cols = (s: Element | null) => Math.max(1, intAttr(kid(s, 'cols'), 'num') || 1);
    const type = (s: Element | null) => val(s, 'type') || 'nextPage';
    const out: PMNode[] = [];
    const finalPage = bodySect ? this.pageFromSect(bodySect) : null;
    sections.forEach((sec, i) => {
      if (i > 0) {
        const prev = sections[i - 1];
        const kind = type(sec.sect);
        const columnBoundary = kind === 'continuous' && (cols(prev.sect) > 1 || cols(sec.sect) > 1);
        if (!columnBoundary) {
          const pg = prev.sect ? this.pageFromSect(prev.sect) : null;
          const differs = pg && finalPage && (pg.orientation !== finalPage.orientation || pg.width !== finalPage.width || pg.height !== finalPage.height);
          out.push(S.section_break.create({ kind: ['nextPage', 'continuous', 'evenPage', 'oddPage'].includes(kind) ? kind : 'nextPage', page: differs ? { width: pg!.width, height: pg!.height, orientation: pg!.orientation, margin: pg!.margin } : null }));
        }
      }
      const blocks = this.assemble(sec.items);
      const n = cols(sec.sect);
      if (n > 1 && blocks.length) {
        const colsEl = kid(sec.sect, 'cols');
        const space = ptAttr(colsEl, 'space');
        out.push(S.column_section.create({ count: n, gap: space ?? 36, rule: onOff(attr(colsEl, 'sep') ?? '0') }, blocks));
      } else out.push(...blocks);
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Styles -> settings.styles

  private ownStyleDef(st: WStyle): Partial<StyleDef> {
    const d: Partial<StyleDef> = { ...pPrToStyle(st.pPr), ...this.rPrToStyle(st.rPr) };
    return d;
  }

  private rPrToStyle(rPr: Element | null): Partial<StyleDef> {
    const d: Partial<StyleDef> = {};
    if (!rPr) return d;
    const font = this.fontOf(kid(rPr, 'rFonts'));
    if (font) d.font = font;
    const sz = val(rPr, 'sz');
    if (sz && parseFloat(sz) > 0) d.size = parseFloat(sz) / 2;
    const b = flag(rPr, 'b'); if (b != null) d.bold = b;
    const i = flag(rPr, 'i'); if (i != null) d.italic = i;
    const u = kid(rPr, 'u'); if (u) d.underline = (attr(u, 'val') || 'single') !== 'none';
    const c = val(rPr, 'color'); if (c) { const css = ooxmlColorToCss(c); if (css) d.color = css; }
    const caps = flag(rPr, 'caps'); if (caps != null) d.caps = caps;
    const sc = flag(rPr, 'smallCaps'); if (sc != null) d.smallCaps = sc;
    const sp = twAttr(kid(rPr, 'spacing'), 'val'); if (sp != null) d.spacing = round2(sp / 20);
    const hl = val(rPr, 'highlight'); if (hl && HIGHLIGHT_COLORS[hl]) d.highlight = '#' + HIGHLIGHT_COLORS[hl];
    const shd = ooxmlColorToCss(attr(kid(rPr, 'shd'), 'fill')); if (shd) (d as any).bg = shd;
    return d;
  }

  private effectiveDocxStyle(id: string, depth = 0): Partial<StyleDef> {
    const st = this.styles.get(id);
    if (!st || depth > 12) return {};
    // Paragraph styles sit on top of the document defaults; character styles only on their own chain.
    const base = st.basedOn && st.basedOn !== id ? this.effectiveDocxStyle(st.basedOn, depth + 1)
      : st.type === 'paragraph' ? { ...pPrToStyle(this.docDefaultsP), ...this.rPrToStyle(this.docDefaultsR) } : {};
    return { ...base, ...this.ownStyleDef(st) };
  }

  private buildStyleSettings(): void {
    // Close the used set over basedOn chains.
    const queue = [...this.usedStyles];
    if (this.defaultParaStyle) queue.push(this.defaultParaStyle);
    const used = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (used.has(id)) continue;
      used.add(id);
      const st = this.styles.get(id);
      if (st?.basedOn) queue.push(st.basedOn);
    }
    const qfSettings = defaultSettings();
    const qfMap = resolveStyles(qfSettings);
    for (const id of used) {
      const st = this.styles.get(id);
      if (!st || (st.type !== 'paragraph' && st.type !== 'character')) continue;
      if (/^(Default Paragraph Font|(Footnote|Endnote|Comment) Reference)$/.test(st.name)) continue;
      const type = st.type as 'paragraph' | 'character';
      if (isBuiltinStyleName(st.name)) {
        const ours = effectiveStyle(qfMap, st.name);
        const theirs = this.effectiveDocxStyle(id);
        const over: Partial<StyleDef> = {};
        for (const k of CMP_KEYS) {
          const tv = (theirs as any)[k];
          if (tv === undefined) continue;
          if (normStyleValue(k, tv, qfSettings) !== normStyleValue(k, (ours as any)[k], qfSettings)) (over as any)[k] = tv;
        }
        if (Object.keys(over).length) this.settings.styles[st.name] = { name: st.name, type: ours.type, ...over } as StyleDef;
      } else {
        const own = this.ownStyleDef(st);
        const def: StyleDef = { name: st.name, type, ...own };
        const based = st.basedOn ? this.styleName(st.basedOn) : null;
        if (based && based !== st.name) def.basedOn = based;
        else if (type === 'paragraph') {
          // Root custom styles inherit document defaults; Normal is the closest equivalent.
          def.basedOn = 'Normal';
          Object.assign(def, { ...pPrToStyle(this.docDefaultsP), ...this.rPrToStyle(this.docDefaultsR), ...own });
        }
        if (st.next && st.next !== st.id) def.next = this.styleName(st.next);
        if (st.qFormat) def.quick = true;
        this.settings.styles[st.name] = def;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------
// Property parsing helpers (shared by paragraphs and styles)

/**
 * Text-box options from a "qf:textbox:{json}" content-control tag. The tag is document data and
 * the values end up in a style attribute: only well-formed values of the known options pass.
 */
function textBoxOpts(raw: unknown): Record<string, unknown> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (o.float === 'left' || o.float === 'right' || o.float === 'none') out.float = o.float;
  for (const k of ['width', 'border', 'bg'] as const) { if (o[k] === null) out[k] = null; else { const v = safeCssValue(o[k]); if (v) out[k] = v; } }
  if (o.padding != null) out.padding = safeNum(o.padding, 6, 0, 200);
  if (o.radius != null) out.radius = safeNum(o.radius, 0, 0, 500);
  if (o.rotate != null) out.rotate = safeNum(o.rotate, 0, -360, 360);
  if (typeof o.shadow === 'boolean') out.shadow = o.shadow;
  if (typeof o.kind === 'string' && /^[a-z][\w-]{0,30}$/i.test(o.kind)) out.kind = o.kind;
  return out;
}

function bordersJson(pBdr: Element | null): string | null {
  if (!pBdr) return null;
  const b: Record<string, string> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const el = kid(pBdr, side) || kid(pBdr, side === 'left' ? 'start' : side === 'right' ? 'end' : side);
    const css = el ? ooxmlBorderToCss(attr(el, 'val'), attr(el, 'sz'), attr(el, 'color')) : null;
    if (css) b[side] = css;
  }
  return Object.keys(b).length ? JSON.stringify(b) : null;
}

function parseTabs(tabs: Element | null): string | null {
  if (!tabs) return null;
  const out: { pos: number; align: string; leader: string }[] = [];
  for (const t of kidsNamed(tabs, 'tab')) {
    const v = attr(t, 'val') || 'left';
    if (v === 'clear') continue;
    const pos = twAttr(t, 'pos');
    if (pos == null) continue;
    out.push({ pos: round2(pos / 20), align: v === 'start' ? 'left' : v === 'end' ? 'right' : v, leader: attr(t, 'leader') || 'none' });
  }
  return out.length ? JSON.stringify(out) : null;
}

/** Direct paragraph properties -> paragraph attrs (excluding style). */
function parsePPr(pPr: Element | null): Record<string, any> {
  const a: Record<string, any> = {};
  if (!pPr) return a;
  const jc = val(pPr, 'jc');
  if (jc) a.align = jc === 'both' ? 'justify' : jc === 'distribute' ? 'distribute' : jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left';
  // In a w:bidi paragraph left/start is the leading (right) side and right/end the trailing side.
  if (jc && flag(pPr, 'bidi') && (a.align === 'left' || a.align === 'right')) a.align = a.align === 'left' ? 'right' : 'left';
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = ptAttr(ind, 'left') ?? ptAttr(ind, 'start');
    const right = ptAttr(ind, 'right') ?? ptAttr(ind, 'end');
    const first = ptAttr(ind, 'firstLine');
    const hanging = ptAttr(ind, 'hanging');
    if (left != null) a.indentLeft = left;
    if (right != null) a.indentRight = right;
    if (hanging != null && hanging !== 0) a.indentFirst = -hanging;
    else if (first != null) a.indentFirst = first;
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = ptAttr(sp, 'before');
    const after = ptAttr(sp, 'after');
    if (before != null) a.spaceBefore = before;
    if (after != null) a.spaceAfter = after;
    const line = twAttr(sp, 'line');
    if (line != null && line > 0) {
      const rule = attr(sp, 'lineRule') || 'auto';
      if (rule === 'exact') a.lineHeight = `${round2(line / 20)}pt`;
      else if (rule === 'atLeast') a.lineHeight = `atleast:${round2(line / 20)}`;
      else a.lineHeight = String(round2(line / 240));
    }
  }
  const kn = flag(pPr, 'keepNext'); if (kn != null) a.keepNext = kn;
  const kl = flag(pPr, 'keepLines'); if (kl != null) a.keepLines = kl;
  const pbb = flag(pPr, 'pageBreakBefore'); if (pbb != null) a.pageBreakBefore = pbb;
  const wc = flag(pPr, 'widowControl'); if (wc != null) a.widowControl = wc;
  if (flag(pPr, 'bidi')) a.dir = 'rtl';
  const shd = kid(pPr, 'shd');
  const fill = attr(shd, 'val') === 'nil' ? null : ooxmlColorToCss(attr(shd, 'fill'));
  if (fill) a.bg = fill;
  const border = bordersJson(kid(pPr, 'pBdr'));
  if (border) a.border = border;
  const ol = val(pPr, 'outlineLvl');
  if (ol != null) { const n = parseInt(ol, 10); a.outlineLevel = n >= 0 && n < 9 ? n + 1 : null; }
  const tabs = parseTabs(kid(pPr, 'tabs'));
  if (tabs) a.tabs = tabs;
  if (flag(pPr, 'suppressLineNumbers')) a.suppressLineNumbers = true;
  if (flag(kid(pPr, 'rPr'), 'vanish')) a.hidden = true;
  return a;
}

function pPrToStyle(pPr: Element | null): Partial<StyleDef> {
  const a = parsePPr(pPr);
  const d: Partial<StyleDef> = {};
  for (const k of ['align', 'spaceBefore', 'spaceAfter', 'lineHeight', 'indentLeft', 'indentRight', 'indentFirst', 'keepNext', 'keepLines', 'pageBreakBefore', 'outlineLevel', 'bg'] as const) {
    if (a[k] !== undefined && a[k] !== null) (d as any)[k] = a[k];
  }
  if (a.border) {
    try {
      const b = JSON.parse(a.border);
      if (b.top) d.borderTop = b.top;
      if (b.bottom) d.borderBottom = b.bottom;
      if (b.left) d.borderLeft = b.left;
    } catch { /* */ }
  }
  return d;
}

const CMP_KEYS = ['font', 'size', 'bold', 'italic', 'underline', 'color', 'caps', 'smallCaps', 'spacing', 'align', 'spaceBefore', 'spaceAfter',
  'lineHeight', 'indentLeft', 'indentRight', 'indentFirst', 'keepNext', 'keepLines', 'pageBreakBefore', 'borderTop', 'borderBottom', 'borderLeft', 'bg'];

function normStyleValue(k: string, v: any, settings: DocSettings): string {
  if (v === undefined || v === null || v === '') {
    if (['bold', 'italic', 'underline', 'caps', 'smallCaps', 'keepNext', 'keepLines', 'pageBreakBefore'].includes(k)) return 'false';
    if (['size'].includes(k)) return '';
    if (['spacing', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirst'].includes(k)) return '0';
    if (k === 'align') return 'left';
    return '';
  }
  switch (k) {
    case 'font': {
      const fam = String(v).startsWith('+') ? fontStack(v, settings).split(',')[0].replace(/"/g, '').trim() : String(v);
      return exportFontName(fam).toLowerCase();
    }
    case 'color': case 'bg': return cssColorToHex(v, settings.theme.accent) || '';
    case 'borderTop': case 'borderBottom': case 'borderLeft': {
      const b = cssBorderToOoxml(v, settings.theme.accent);
      return b ? `${b.val}:${b.sz}:${b.color}` : '';
    }
    case 'lineHeight': {
      const s = String(v);
      if (/^[\d.]+$/.test(s)) return String(Math.round(parseFloat(s) * 100) / 100);
      return s.replace(/\s+/g, '');
    }
    case 'align': return v === 'justify' ? 'justify' : String(v);
    default:
      if (typeof v === 'number') return String(Math.round(v * 2) / 2);
      return String(v);
  }
}

// ------------------------------------------------------------------------------------------
// Assembly helpers

function buildList(kind: 'bullet' | 'ordered', attrs: Record<string, any>, items: PMNode[][]): PMNode {
  const fixed = items.map((c) => leadParagraph(c));
  if (kind === 'bullet' && attrs.bullet === 'none' && fixed.every((c) => isTaskParagraph(c[0]))) {
    return S.task_list.create(null, fixed.map((c) => {
      const p = c[0];
      const ctl = p.firstChild!;
      let content = p.content.cut(ctl.nodeSize);
      const first = content.firstChild;
      if (first && first.isText && first.text!.startsWith(' ')) content = content.cut(1);
      return S.task_item.create({ checked: ctl.attrs.value === 'true' }, [p.type.create(p.attrs, content, p.marks), ...c.slice(1)]);
    }));
  }
  const type: NodeType = kind === 'bullet' ? S.bullet_list : S.ordered_list;
  return type.create(attrs, fixed.map((c) => S.list_item.create(null, c)));
}

function isTaskParagraph(p: PMNode): boolean {
  const f = p.type === S.paragraph ? p.firstChild : null;
  return !!f && f.type === S.control && f.attrs.kind === 'checkbox';
}

function codeLine(p: PMNode): string {
  let s = '';
  p.forEach((c) => { s += c.isText ? c.text : c.type === S.hard_break ? '\n' : c.textContent; });
  return s;
}

function ruleFrom(p: PMNode): PMNode | null {
  try {
    const b = JSON.parse(p.attrs.border);
    if (!b.bottom || b.top || b.left || b.right) return null;
    const m = /^([\d.]+)pt\s+(\w+)\s+(\S+)$/.exec(b.bottom);
    if (!m) return null;
    return S.horizontal_rule.create({ style: m[2], weight: parseFloat(m[1]), color: m[3] === '#000000' ? null : m[3] });
  } catch {
    return null;
  }
}

/** Header/footer paragraph text with fields expressed as {TOKENS}. */
function tokenText(p: PMNode): string {
  let s = '';
  p.descendants((n) => {
    if (n.isText) s += n.text;
    else if (n.type === S.hard_break) s += ' ';
    else if (n.type === S.field) {
      const t = n.attrs.type as string;
      const fmt = n.attrs.format as string | null;
      const arg = (n.attrs.arg || '') as string;
      if (['PAGE', 'NUMPAGES', 'DATE', 'TIME', 'TITLE', 'AUTHOR', 'FILENAME', 'SUBJECT', 'SECTION'].includes(t)) s += fmt ? `{${t}:${fmt}}` : `{${t}}`;
      else if (t === 'DOCPROPERTY' && /^company$/i.test(arg)) s += '{COMPANY}';
      else s += n.attrs.value || '';
    } else if (n.isLeaf) s += n.textContent;
    return true;
  });
  return s;
}

/** Plain text of an element subtree (w:t, tabs and breaks), skipping deleted text and field codes. */
function plainText(el: Element | null): string {
  if (!el) return '';
  let s = '';
  const walk = (e: Element) => {
    for (const c of kids(e)) {
      switch (c.localName) {
        case 't': s += c.textContent || ''; break;
        case 'tab': case 'ptab': s += '\t'; break;
        case 'br': case 'cr': s += '\n'; break;
        case 'noBreakHyphen': s += '‑'; break;
        case 'softHyphen': s += '­'; break;
        case 'p': if (s && !s.endsWith('\n')) s += '\n'; walk(c); break;
        case 'delText': case 'instrText': case 'delInstrText': case 'rPr': case 'pPr': case 'del': case 'moveFrom': break;
        case 'AlternateContent': walk(chooseAlternate(c)); break;
        default: walk(c);
      }
    }
  };
  walk(el);
  return s;
}

const SUPPORTED_ALT = new Set(['wps', 'wpg', 'wpc', 'wp14', 'w14', 'w15', 'w16', 'w16se', 'w16cid', 'a14', 'v', 'o', 'w10', 'pic', 'm', 'mc', 'w', 'wp', 'a', 'r', 'cx', 'cx1', 'aink']);

/** Pick the mc:Choice we understand, else mc:Fallback. Returns the branch element. */
function chooseAlternate(alt: Element): Element {
  const choices = kidsNamed(alt, 'Choice');
  const fallback = kid(alt, 'Fallback');
  const renderable = (e: Element) => desc(e, 'blip').length + desc(e, 'imagedata').length + desc(e, 'txbxContent').length > 0;
  for (const ch of choices) {
    const req = (attr(ch, 'Requires') || '').split(/\s+/).filter(Boolean);
    if (!req.every((r) => SUPPORTED_ALT.has(r))) continue;
    // A drawing we cannot render (chart, SmartArt, plain shape) loses to a fallback that has a picture or text box.
    if (desc(ch, 'drawing').length && !renderable(ch) && fallback && renderable(fallback)) return fallback;
    return ch;
  }
  return fallback || choices[0] || alt;
}

/** Structural safety net: fix any content that does not fit the schema. */
function repair(node: PMNode): PMNode {
  if (node.isText || node.isLeaf) return node;
  const children: PMNode[] = [];
  node.forEach((c) => children.push(repair(c)));
  const fits = (content: PMNode[]) => {
    try { return node.type.validContent(Fragment.fromArray(content)); } catch { return false; }
  };
  if (fits(children)) return node.type.create(node.attrs, children, node.marks);
  let content: PMNode[];
  if (node.type === S.code_block) {
    content = [schema.text(node.textContent || ' ')];
    return node.type.create(node.attrs, node.textContent ? content : null, node.marks);
  }
  if (node.isTextblock) {
    content = children.filter((c) => c.isInline);
  } else {
    content = [];
    let inl: PMNode[] = [];
    const flushInl = () => { if (inl.length) content.push(S.paragraph.create(null, inl)); inl = []; };
    for (const c of children) {
      if (c.isInline) inl.push(c);
      else { flushInl(); content.push(c); }
    }
    flushInl();
    if (node.type === S.bullet_list || node.type === S.ordered_list) content = content.map((c) => (c.type === S.list_item ? c : S.list_item.create(null, leadParagraph([c]))));
    if (node.type === S.task_list) content = content.map((c) => (c.type === S.task_item ? c : S.task_item.create(null, leadParagraph([c]))));
    if (node.type === S.list_item || node.type === S.task_item) content = leadParagraph(content.filter((c) => c.type !== S.list_item));
  }
  if (fits(content)) return node.type.create(node.attrs, content, node.marks);
  const filled = node.type.createAndFill(node.attrs, content, node.marks);
  if (filled) return filled;
  if (node.type === S.doc) return S.doc.create(node.attrs, [S.paragraph.create(null, node.textContent ? schema.text(node.textContent) : null)]);
  return node.type.createAndFill(node.attrs) || S.paragraph.create(null, node.textContent ? schema.text(node.textContent) : null);
}

// ------------------------------------------------------------------------------------------
// OMML -> LaTeX

const NARY_TO_CMD: Record<string, string> = Object.fromEntries(Object.entries(NARY_CHARS).map(([k, v]) => [v, k]));
const ACC_TO_CMD: Record<string, string> = { '̂': 'hat', '̅': 'bar', '¯': 'bar', '⃗': 'vec', '̇': 'dot', '̈': 'ddot', '̃': 'tilde', '̌': 'check', '̆': 'breve', '́': 'acute', '̀': 'grave', '^': 'hat', '~': 'tilde', '→': 'vec' };

function latexChars(text: string): string {
  let s = '';
  for (const ch of text) {
    if (ch === '{' || ch === '}' || ch === '%' || ch === '#' || ch === '&' || ch === '$' || ch === '_') s += '\\' + ch;
    else if (ch === '\\') s += '\\backslash ';
    else if (ch === '−') s += '-';
    else if (ch === ' ') s += ' ';
    else if (UNICODE_TO_LATEX[ch] !== undefined) s += UNICODE_TO_LATEX[ch] ? `\\${UNICODE_TO_LATEX[ch]} ` : ch;
    else s += ch;
  }
  return s;
}

function grp(s: string): string {
  const t = s.trim();
  return t.length === 1 || /^\\[A-Za-z]+\s*$/.test(t) ? t : `{${t}}`;
}

export function ommlToLatex(el: Element): string {
  const inner = (e: Element | null): string => (e ? kids(e).map(conv).join('') : '');
  const part = (e: Element, name: string) => inner(kid(e, name)).trim();
  const conv = (e: Element): string => {
    switch (e.localName) {
      case 'r': {
        const t = kidsNamed(e, 't').map((x) => x.textContent || '').join('');
        const rPr = kid(e, 'rPr');
        const plain = !!kid(rPr, 'nor') || val(rPr, 'sty') === 'p';
        if (plain && /^[A-Za-z]{2,}$/.test(t)) return FUNCTION_NAMES.has(t) ? `\\${t} ` : `\\mathrm{${t}}`;
        if (plain && /\s/.test(t) && /[A-Za-z]/.test(t)) return `\\text{${t}}`;
        return latexChars(t);
      }
      case 'f': return `\\frac{${part(e, 'num')}}{${part(e, 'den')}}`;
      case 'sSup': return `${grp(part(e, 'e'))}^{${part(e, 'sup')}}`;
      case 'sSub': return `${grp(part(e, 'e'))}_{${part(e, 'sub')}}`;
      case 'sSubSup': return `${grp(part(e, 'e'))}_{${part(e, 'sub')}}^{${part(e, 'sup')}}`;
      case 'sPre': return `{}_{${part(e, 'sub')}}^{${part(e, 'sup')}}${grp(part(e, 'e'))}`;
      case 'rad': {
        const deg = part(e, 'deg');
        const hide = onOff(val(kid(e, 'radPr'), 'degHide') ?? '0');
        return !hide && deg ? `\\sqrt[${deg}]{${part(e, 'e')}}` : `\\sqrt{${part(e, 'e')}}`;
      }
      case 'nary': {
        const pr = kid(e, 'naryPr');
        const chr = val(pr, 'chr') || '∫';
        const cmd = NARY_TO_CMD[chr] ? `\\${NARY_TO_CMD[chr]}` : latexChars(chr);
        const sub = onOff(val(pr, 'subHide') ?? '0') ? '' : part(e, 'sub');
        const sup = onOff(val(pr, 'supHide') ?? '0') ? '' : part(e, 'sup');
        return `${cmd}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} ${grp(part(e, 'e'))}`;
      }
      case 'd': {
        const pr = kid(e, 'dPr');
        const beg = kid(pr, 'begChr') ? (attr(kid(pr, 'begChr'), 'val') ?? '') : '(';
        const end = kid(pr, 'endChr') ? (attr(kid(pr, 'endChr'), 'val') ?? '') : ')';
        const sep = kid(pr, 'sepChr') ? (attr(kid(pr, 'sepChr'), 'val') ?? '|') : '|';
        const d = (c: string) => (c === '' ? '.' : c === '{' ? '\\{' : c === '}' ? '\\}' : c === '⟨' ? '\\langle ' : c === '⟩' ? '\\rangle ' : c === '‖' ? '\\|' : c);
        const es = kidsNamed(e, 'e').map((x) => inner(x).trim());
        return `\\left${d(beg)}${es.join(` ${sep === '|' ? '\\mid' : latexChars(sep)} `)}\\right${d(end)}`;
      }
      case 'acc': {
        const chr = val(kid(e, 'accPr'), 'chr') || '̂';
        return `\\${ACC_TO_CMD[chr] || 'hat'}{${part(e, 'e')}}`;
      }
      case 'bar': return `\\${val(kid(e, 'barPr'), 'pos') === 'top' ? 'overline' : 'underline'}{${part(e, 'e')}}`;
      case 'func': {
        const name = plainMath(kid(e, 'fName')).trim();
        const arg = part(e, 'e');
        if (FUNCTION_NAMES.has(name)) return `\\${name} ${grp(arg)}`;
        return `${inner(kid(e, 'fName')).trim()} ${grp(arg)}`;
      }
      case 'limLow': {
        const base = plainMath(kid(e, 'e')).trim();
        if (FUNCTION_NAMES.has(base)) return `\\${base}_{${part(e, 'lim')}}`;
        return `\\underset{${part(e, 'lim')}}{${part(e, 'e')}}`;
      }
      case 'limUpp': return `\\overset{${part(e, 'lim')}}{${part(e, 'e')}}`;
      case 'groupChr': {
        const chr = val(kid(e, 'groupChrPr'), 'chr') || '⏟';
        return `\\${chr === '⏞' ? 'overbrace' : 'underbrace'}{${part(e, 'e')}}`;
      }
      case 'm': {
        const rows = kidsNamed(e, 'mr').map((r) => kidsNamed(r, 'e').map((x) => inner(x).trim()).join(' & '));
        return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
      }
      case 'eqArr': return `\\begin{aligned}${kidsNamed(e, 'e').map((x) => inner(x).trim()).join(' \\\\ ')}\\end{aligned}`;
      case 'oMath': case 'e': case 'num': case 'den': case 'sub': case 'sup': case 'deg': case 'lim': case 'fName':
      case 'box': case 'borderBox': case 'phant': case 'oMathPara':
        return inner(e);
      default:
        if (/Pr$/.test(e.localName) || e.localName === 'ctrlPr') return '';
        return inner(e);
    }
  };
  return conv(el).replace(/\s+/g, ' ').trim();
}

function plainMath(e: Element | null): string {
  return e ? desc(e, 't').map((t) => t.textContent || '').join('') : '';
}

// ------------------------------------------------------------------------------------------
// Entry point

/** Import a .docx / .docm / .dotx / .dotm file into an Anne's Pen document. */
export async function importDocx(data: ArrayBuffer, name: string): Promise<PMNode> {
  return importDocxZip(await loadZip(data), name);
}

/** Import an already-opened (or synthesized) WordprocessingML package. */
export async function importDocxZip(zip: JSZip, name: string): Promise<PMNode> {
  const imp = new DocxImporter(new Package(zip), name);
  return imp.convert();
}
