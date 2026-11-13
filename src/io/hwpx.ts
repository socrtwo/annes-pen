/**
 * Hangul Word Processor OWPML import (.hwpx documents, .hwpt templates; KS X 6101).
 *
 * An HWPX file is a ZIP (mimetype "application/hwp+zip") whose Contents/content.hpf (an OPF
 * package) lists Contents/header.xml (fonts, character/paragraph properties, border fills,
 * numbering, bullets, styles) and the body sections Contents/sectionN.xml. Paragraphs (hp:p)
 * reference a paragraph property and style by id; runs (hp:run) reference a character
 * property; text sits in hp:t with inline hp:tab / hp:lineBreak controls.
 *
 * Mapped: metadata, page size/margins/orientation (HWPUNIT = 1/7200 in), headers/footers,
 * styles (English names; "Outline N" → Heading N), paragraph alignment, indents, spacing,
 * line spacing, outline/number/bullet paragraph heads → lists, character font (per language
 * slot, Latin preferred), size, bold, italic, underline, strikeout, super/subscript, colour,
 * shade; tables (hp:tbl with cell spans, cell fills from border fills), pictures (hp:pic →
 * BinData), footnotes/endnotes, hyperlinks (field begin/end), page/column breaks.
 * Not mapped: drawing objects other than pictures, text art, equations (kept as their script
 * text), memo (comment) shapes, change tracking.
 */
import { loadZip } from './zip';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { PAGE_SIZES, type StyleDef } from '../editor/settings';
import { attr, kid, kids, kidsNamed, numAttr, parseXml, decodeXml, desc, firstDesc } from './xml-read';
import { InlineBuf, charMarks, headingStyle, hfFromBlocks, makeTable, paraAttrs, type CellSpec, type CharProps } from './runs';
import { buildNestedLists, finishDoc, normalizeImportedFormatting, mimeForName, newSettings, para, sniffImageMime, toDataUrl, type FlatListItem } from './serialize';

const S = schema.nodes;
const hu = (v: number | null | undefined) => (v == null ? null : Math.round((v / 100) * 100) / 100); // HWPUNIT → pt

interface ParaPr { attrs: Record<string, any>; heading: { type: string; idRef: string; level: number } | null }

const NUM_FORMAT: Record<string, string> = {
  DIGIT: 'decimal', CIRCLED_DIGIT: 'decimal', ROMAN_CAPITAL: 'upper-roman', ROMAN_SMALL: 'lower-roman', LATIN_CAPITAL: 'upper-alpha',
  LATIN_SMALL: 'lower-alpha', CIRCLED_LATIN_CAPITAL: 'upper-alpha', CIRCLED_LATIN_SMALL: 'lower-alpha', HANGUL_SYLLABLE: 'decimal',
  HANGUL_JAMO: 'decimal', IDEOGRAPH: 'decimal', DECAGON_CIRCLE: 'decimal',
};

class HwpxReader {
  settings = newSettings();
  fonts = new Map<string, Map<string, string>>(); // lang → id → face
  charPrs = new Map<string, CharProps>();
  paraPrs = new Map<string, ParaPr>();
  fills = new Map<string, string>();
  styles = new Map<string, { name: string; paraPr: string | null; charPr: string | null }>();
  numberings = new Map<string, Map<number, { format: string; start: number }>>();
  bullets = new Map<string, string>();
  bin = new Map<string, string>();

  constructor(private header: Document | null, private files: Map<string, Uint8Array>, private manifest: Map<string, string>) {}

  readHeader(): void {
    const h = this.header;
    if (!h) return;
    for (const ff of desc(h, 'fontface')) {
      const lang = (attr(ff, 'lang') || '').toUpperCase();
      const m = new Map<string, string>();
      for (const f of kidsNamed(ff, 'font')) m.set(attr(f, 'id') || '', attr(f, 'face') || '');
      this.fonts.set(lang, m);
    }
    for (const bf of desc(h, 'borderFill')) {
      const brush = firstDesc(bf, 'winBrush');
      const c = attr(brush, 'faceColor');
      if (c && c !== 'none' && !/^#?ffffffff?$/i.test(c)) this.fills.set(attr(bf, 'id') || '', c.length === 9 ? '#' + c.slice(3) : c);
    }
    for (const cp of desc(h, 'charPr')) {
      const id = attr(cp, 'id') || '';
      const fr = kid(cp, 'fontRef');
      const latin = this.fonts.get('LATIN')?.get(attr(fr, 'latin') || '0');
      const hangul = this.fonts.get('HANGUL')?.get(attr(fr, 'hangul') || '0');
      const u = kid(cp, 'underline');
      const so = kid(cp, 'strikeout');
      const height = numAttr(cp, 'height');
      const color = attr(cp, 'textColor');
      const shade = attr(cp, 'shadeColor');
      this.charPrs.set(id, {
        font: latin || hangul || null, size: height ? height / 100 : null,
        bold: !!kid(cp, 'bold'), italic: !!kid(cp, 'italic'),
        underline: u && attr(u, 'type') && attr(u, 'type') !== 'NONE' ? (attr(u, 'shape') === 'DOUBLE_SLIM' ? 'double' : attr(u, 'shape') === 'WAVE' ? 'wavy' : attr(u, 'shape') === 'DOT' ? 'dotted' : attr(u, 'shape') === 'DASH' ? 'dashed' : true) : false,
        strike: !!so && !!attr(so, 'shape') && attr(so, 'shape') !== 'NONE' && attr(so, 'shape') !== '3D',
        sup: !!kid(cp, 'supscript'), sub: !!kid(cp, 'subscript'),
        color: color && color !== 'none' ? color : null, highlight: shade && shade !== 'none' && !/^#?ffffff$/i.test(shade) ? shade : null,
      });
    }
    for (const pp of desc(h, 'paraPr')) {
      const id = attr(pp, 'id') || '';
      // Margins may sit inside hp:switch/hp:default (compatibility wrapper): take the first one found.
      const margin = firstDesc(pp, 'margin');
      const v = (n: string) => { const e = kid(margin, n); return e ? numAttr(e, 'value') : null; };
      const ls = firstDesc(pp, 'lineSpacing');
      const lsType = attr(ls, 'type');
      const lsVal = numAttr(ls, 'value');
      let lineHeight: string | null = null;
      if (lsType === 'PERCENT' && lsVal) lineHeight = String(Math.round(lsVal) / 100); // percent of the font size, like CSS
      else if (lsType === 'FIXED' && lsVal) lineHeight = `${hu(lsVal)}pt`;
      else if (lsType === 'AT_LEAST' && lsVal) lineHeight = `atleast:${hu(lsVal)}`;
      const al = attr(kid(pp, 'align'), 'horizontal');
      const hd = kid(pp, 'heading');
      const brk = kid(pp, 'breakSetting');
      this.paraPrs.set(id, {
        attrs: paraAttrs({
          align: al === 'JUSTIFY' ? 'justify' : al === 'DISTRIBUTE' || al === 'DISTRIBUTE_SPACE' ? 'distribute' : al ? al.toLowerCase() : null,
          indentLeft: hu(v('left')), indentRight: hu(v('right')), indentFirst: hu(v('intent') ?? v('indent')),
          spaceBefore: hu(v('prev')), spaceAfter: hu(v('next')), lineHeight,
          keepNext: attr(brk, 'keepWithNext') === '1', keepLines: attr(brk, 'keepLines') === '1', pageBreakBefore: attr(brk, 'pageBreakBefore') === '1',
        }),
        heading: hd && attr(hd, 'type') && attr(hd, 'type') !== 'NONE' ? { type: attr(hd, 'type')!, idRef: attr(hd, 'idRef') || '0', level: numAttr(hd, 'level') || 0 } : null,
      });
    }
    for (const n of desc(h, 'numbering')) {
      const lv = new Map<number, { format: string; start: number }>();
      for (const ph of kidsNamed(n, 'paraHead')) lv.set((numAttr(ph, 'level') || 1) - 1, { format: NUM_FORMAT[attr(ph, 'numFormat') || 'DIGIT'] || 'decimal', start: numAttr(ph, 'start') || numAttr(n, 'start') || 1 });
      this.numberings.set(attr(n, 'id') || '', lv);
    }
    for (const b of desc(h, 'bullet')) this.bullets.set(attr(b, 'id') || '', attr(b, 'char') || '•');
    const out: Record<string, StyleDef> = {};
    for (const s of desc(h, 'style')) {
      if ((attr(s, 'type') || 'PARA') !== 'PARA') continue;
      const eng = attr(s, 'engName') || '';
      const name = this.styleName(eng, attr(s, 'name') || '');
      this.styles.set(attr(s, 'id') || '', { name, paraPr: attr(s, 'paraPrIDRef'), charPr: attr(s, 'charPrIDRef') });
      const cp = this.charPrs.get(attr(s, 'charPrIDRef') || '') || {};
      const pp = this.paraPrs.get(attr(s, 'paraPrIDRef') || '')?.attrs || {};
      const def: StyleDef = { name, type: 'paragraph' };
      if (cp.font) def.font = cp.font;
      if (cp.size) def.size = cp.size;
      if (cp.bold) def.bold = true;
      if (cp.italic) def.italic = true;
      if (cp.color && cp.color !== '#000000') def.color = cp.color;
      for (const k of ['align', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirst', 'lineHeight'] as const) if (pp[k] != null) (def as any)[k] = pp[k];
      if (!out[name]) out[name] = def;
    }
    this.settings.styles = out;
    const normal = out.Normal;
    if (normal?.font) this.settings.theme = { ...this.settings.theme, bodyFont: normal.font, headingFont: normal.font };
  }

  private styleName(eng: string, local: string): string {
    const m = /^Outline (\d)$/i.exec(eng);
    if (m) return headingStyle(parseInt(m[1], 10));
    if (/^(Normal|바탕글)$/i.test(eng || local)) return 'Normal';
    if (/^Body$/i.test(eng)) return 'Body Text';
    if (/^Header$/i.test(eng)) return 'Header';
    if (/^Footnote$/i.test(eng)) return 'Footnote Text';
    return eng || local || 'Normal';
  }

  image(binId: string): string | null {
    if (this.bin.has(binId)) return this.bin.get(binId)!;
    const href = this.manifest.get(binId);
    const candidates = [href, ...[...this.files.keys()].filter((p) => p.startsWith('BinData/') && p.split('/').pop()!.replace(/\.[^.]+$/, '') === binId)].filter(Boolean) as string[];
    for (const p of candidates) {
      const b = this.files.get(p);
      if (!b) continue;
      const mime = sniffImageMime(b) || mimeForName(p);
      const src = toDataUrl(b, mime);
      this.bin.set(binId, src);
      return src;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // Body

  section(sec: Element, out: PMNode[], first: boolean): void {
    if (!first) out.push(S.section_break.create({ kind: 'nextPage' }));
    this.blocks(sec, out, first);
  }

  blocks(container: Element, out: PMNode[], applySection = false): void {
    let run: FlatListItem[] = [];
    const flush = () => { if (run.length) { out.push(...buildNestedLists(run)); run = []; } };
    for (const p of kidsNamed(container, 'p')) {
      const r = this.paragraph(p, applySection);
      if (r.list) for (const n of r.nodes) run.push({ ...r.list, blocks: [n] });
      else { flush(); out.push(...r.nodes); }
      if (r.after.length) { flush(); out.push(...r.after); }
    }
    flush();
  }

  private paragraph(p: Element, applySection: boolean): { nodes: PMNode[]; after: PMNode[]; list: { level: number; ordered: boolean; format: string; start: number } | null } {
    const style = this.styles.get(attr(p, 'styleIDRef') || '');
    const ppId = attr(p, 'paraPrIDRef') || style?.paraPr || '';
    const pp = this.paraPrs.get(ppId);
    const attrs: Record<string, any> = { ...(pp?.attrs || {}), style: style?.name || 'Normal' };
    if (attr(p, 'pageBreak') === '1') attrs.pageBreakBefore = true;
    const nodes: PMNode[] = [];
    const after: PMNode[] = [];
    const buf = new InlineBuf();
    let link: string | null = null;
    const flushPara = (force = false) => { if (!buf.empty || force) nodes.push(S.paragraph.create(attrs, buf.take())); };
    for (const r of kidsNamed(p, 'run')) {
      const cp = this.charPrs.get(attr(r, 'charPrIDRef') || '') || {};
      const marks = (): Mark[] => charMarks({ ...cp, link });
      for (const c of kids(r)) {
        switch (c.localName) {
          case 'secPr': if (applySection) this.secPr(c); break;
          case 't': this.text(c, marks(), buf); break;
          case 'ctrl': {
            for (const k of kids(c)) {
              if (k.localName === 'header' || k.localName === 'footer') {
                if (!applySection) continue;
                const blocks: PMNode[] = [];
                const sub = kid(k, 'subList');
                if (sub) this.blocks(sub, blocks);
                const hf = hfFromBlocks(blocks);
                const type = attr(k, 'applyPageType') || 'BOTH';
                const key = k.localName === 'header' ? (type === 'EVEN' ? 'evenHeader' : 'header') : (type === 'EVEN' ? 'evenFooter' : 'footer');
                if (hf) (this.settings as any)[key] = hf;
                if (type === 'EVEN' || type === 'ODD') this.settings.differentOddEven = true;
              } else if (k.localName === 'footNote' || k.localName === 'endNote') {
                const blocks: PMNode[] = [];
                const sub = kid(k, 'subList');
                if (sub) this.blocks(sub, blocks);
                buf.node(S.footnote.create({ text: blocks.map((b) => b.textContent).join('\n').trim(), kind: k.localName === 'endNote' ? 'end' : 'foot' }));
              } else if (k.localName === 'fieldBegin') {
                if ((attr(k, 'type') || '').toUpperCase() === 'HYPERLINK') {
                  const params = desc(k, 'stringParam');
                  const cmd = params.find((x) => /^(Command|Path)$/i.test(attr(x, 'name') || ''))?.textContent || '';
                  link = cmd.replace(/;\d*;\d*;\d*;?$/, '').replace(/\\:/g, ':').trim() || null;
                }
              } else if (k.localName === 'fieldEnd') link = null;
              else if (k.localName === 'pageNum') buf.node(S.field.create({ type: 'PAGE' }));
              else if (k.localName === 'colPr' || k.localName === 'pageHiding' || k.localName === 'pageNumCtrl' || k.localName === 'bookmark') { /* layout controls */ }
            }
            break;
          }
          case 'tbl': { flushPara(); const t = this.table(c); if (t) after.push(t); break; }
          case 'pic': {
            const img = firstDesc(c, 'img');
            const src = this.image(attr(img, 'binaryItemIDRef') || '');
            const sz = kid(c, 'sz') || kid(c, 'curSz');
            if (src) buf.node(S.image.create({ src, width: hu(numAttr(sz, 'width')), height: hu(numAttr(sz, 'height')), alt: (kid(c, 'shapeComment')?.textContent || '').trim() }));
            break;
          }
          case 'rect': case 'ellipse': case 'container': {
            // Text inside drawing objects (text boxes).
            const sub = firstDesc(c, 'subList');
            if (sub) { const inner: PMNode[] = []; this.blocks(sub, inner); if (inner.length) after.push(S.text_box.create({ float: 'none' }, inner)); }
            break;
          }
          case 'equation': {
            const script = (kid(c, 'script')?.textContent || '').trim();
            if (script) buf.text(script, marks());
            break;
          }
          default: break;
        }
      }
    }
    if (attr(p, 'columnBreak') === '1') after.unshift(S.column_break.create());
    // The paragraph that only carries the section definition is not part of the text.
    const onlySection = !!firstDesc(p, 'secPr') && buf.empty && !nodes.length;
    flushPara(nodes.length === 0 && !after.length && !onlySection);
    let list = null;
    const hd = pp?.heading;
    if (hd && (hd.type === 'NUMBER' || hd.type === 'BULLET')) {
      if (hd.type === 'BULLET') list = { level: hd.level, ordered: false, format: this.bullet(hd.idRef), start: 1 };
      else { const lv = this.numberings.get(hd.idRef)?.get(hd.level); list = { level: hd.level, ordered: true, format: lv?.format || 'decimal', start: lv?.start || 1 }; }
    } else if (hd && hd.type === 'OUTLINE' && attrs.style === 'Normal') {
      attrs.style = headingStyle(hd.level + 1);
      nodes.splice(0, nodes.length, ...nodes.map((n) => S.paragraph.create({ ...n.attrs, style: attrs.style }, n.content)));
    }
    return { nodes, after, list };
  }

  private bullet(id: string): string {
    const c = this.bullets.get(id) || '•';
    return c === '•' || c === '●' ? 'disc' : c === '○' ? 'circle' : c === '■' || c === '▪' ? 'square' : c;
  }

  private text(t: Element, marks: Mark[], buf: InlineBuf): void {
    for (const n of Array.from(t.childNodes)) {
      if (n.nodeType === 3 || n.nodeType === 4) { buf.text(n.nodeValue || '', marks); continue; }
      if (n.nodeType !== 1) continue;
      switch ((n as Element).localName) {
        case 'tab': buf.text('\t', marks); break;
        case 'lineBreak': buf.node(S.hard_break.create()); break;
        case 'nbSpace': buf.text('\u00a0', marks); break;
        case 'fwSpace': buf.text('\u3000', marks); break;
        case 'hyphen': buf.text('-', marks); break;
        default: buf.text((n as Element).textContent || '', marks);
      }
    }
  }

  private secPr(sp: Element): void {
    const pg = kid(sp, 'pagePr');
    if (!pg) return;
    const page = this.settings.page;
    const w = hu(numAttr(pg, 'width')), h = hu(numAttr(pg, 'height'));
    if (w && h) {
      page.width = Math.min(w, h); page.height = Math.max(w, h);
      page.orientation = w > h ? 'landscape' : 'portrait';
      page.sizeName = 'Custom';
      for (const [n, [pw, ph]] of Object.entries(PAGE_SIZES)) if (Math.abs(pw - page.width) < 2 && Math.abs(ph - page.height) < 2) { page.sizeName = n; break; }
    }
    const m = kid(pg, 'margin');
    if (m) {
      const g = (n: string) => hu(numAttr(m, n)) ?? 0;
      // Hangul measures the header/footer areas inside the top/bottom margins.
      page.margin = { top: g('top') + g('header'), bottom: g('bottom') + g('footer'), left: g('left'), right: g('right') };
      page.headerDist = g('top') || page.headerDist;
      page.footerDist = g('bottom') || page.footerDist;
      page.gutter = g('gutter');
    }
  }

  private table(tbl: Element): PMNode | null {
    const rows: CellSpec[][] = [];
    for (const tr of kidsNamed(tbl, 'tr')) {
      const row: CellSpec[] = [];
      for (const tc of kidsNamed(tr, 'tc')) {
        const span = kid(tc, 'cellSpan');
        const sz = kid(tc, 'cellSz');
        const blocks: PMNode[] = [];
        const sub = kid(tc, 'subList');
        if (sub) this.blocks(sub, blocks);
        row.push({
          blocks, colspan: numAttr(span, 'colSpan') || 1, rowspan: numAttr(span, 'rowSpan') || 1, header: attr(tc, 'header') === '1',
          background: this.fills.get(attr(tc, 'borderFillIDRef') || '') || null, width: hu(numAttr(sz, 'width')),
          valign: (attr(sub, 'vertAlign') || '').toLowerCase() === 'center' ? 'middle' : (attr(sub, 'vertAlign') || '').toLowerCase() === 'bottom' ? 'bottom' : null,
        });
      }
      rows.push(row);
    }
    const headerRows = rows.findIndex((r) => !r.every((c) => c.header));
    return makeTable(rows, { headerRows: headerRows > 0 ? headerRows : 0 });
  }
}

export async function importHwpx(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const zip = await loadZip(data);
  const files = new Map<string, Uint8Array>();
  const tasks: Promise<void>[] = [];
  zip.forEach((p, f) => { if (!f.dir) tasks.push(f.async('uint8array').then((b) => { files.set(p, b); })); });
  await Promise.all(tasks);
  const xml = (p: string) => { const b = files.get(p); return b ? parseXml(decodeXml(b)) : null; };
  // Package manifest: ids → paths, spine order of sections.
  const container = xml('META-INF/container.xml');
  const hpfPath = attr(firstDesc(container, 'rootfile'), 'full-path') || 'Contents/content.hpf';
  const hpf = xml(hpfPath);
  const manifest = new Map<string, string>();
  for (const it of desc(hpf, 'item')) manifest.set(attr(it, 'id') || '', attr(it, 'href') || '');
  const spine = desc(hpf, 'itemref').map((r) => manifest.get(attr(r, 'idref') || '') || '').filter((p) => /section\d+\.xml$/i.test(p));
  const sections = spine.length ? spine : [...files.keys()].filter((p) => /^Contents\/section\d+\.xml$/i.test(p)).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
  const headerPath = [...manifest.values()].find((p) => /header\.xml$/i.test(p)) || 'Contents/header.xml';
  const reader = new HwpxReader(xml(headerPath), files, manifest);
  reader.readHeader();
  const props = reader.settings.properties;
  const md = firstDesc(hpf, 'metadata');
  for (const m of kids(md)) {
    const v = (m.textContent || '').trim();
    if (m.localName === 'title' && v) props.title = v;
    if (m.localName === 'meta') {
      const n = (attr(m, 'name') || '').toLowerCase();
      if (n === 'creator' && v) props.author = v;
      else if (n === 'subject' && v) props.subject = v;
      else if (n === 'description' && v) props.comments = v;
      else if (n === 'keyword' && v) props.keywords = v;
    }
  }
  const blocks: PMNode[] = [];
  sections.forEach((p, i) => { const d = xml(p); if (d?.documentElement) reader.section(d.documentElement, blocks, i === 0); });
  if (!sections.length) throw new Error('No body sections found: not an HWPX document');
  return finishDoc(blocks.length ? normalizeImportedFormatting(blocks, reader.settings, reader.settings.styles.Normal?.font || null) : [para()], reader.settings);
}

