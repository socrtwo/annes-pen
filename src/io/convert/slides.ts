/**
 * Presentations into documents: one section per slide (a page break between slides), the slide
 * title as a heading, then the slide's text (bulleted paragraphs keep their outline level),
 * tables and pictures, and the speaker notes.
 *
 * Readers: PowerPoint Office Open XML (pptx), OpenDocument (odp/fodp) and the PowerPoint 97-2003
 * binary format (ppt; text only, from the slide list's text atoms).
 */
import JSZip from 'jszip';
import { loadZip } from '../zip';
import type { Node as PMNode } from 'prosemirror-model';
import { openCfb, le } from '../cfb';
import { DocBuilder, type CharProps } from '../legacy/builder';
import { bytesToBase64 } from '../serialize';

const u8a = (d: ArrayBuffer | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(d));
const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el: Element | Document, local: string) => Array.from(el.getElementsByTagNameNS('*', local));
const child = (el: Element, local: string) => Array.from(el.children).find((e) => e.localName === local) || null;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' };

export interface SlideText { level: number; bullet: boolean; runs: { text: string; cp: CharProps }[] }
export interface Slide { title: string; body: SlideText[]; tables: string[][][]; images: { src: string; w: number | null; h: number | null }[]; notes: string }

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}

async function rels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const p = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const f = zip.file(p);
  const out = new Map<string, string>();
  if (!f) return out;
  for (const r of kids(xml(await f.async('string')), 'Relationship')) out.set(r.getAttribute('Id') || '', resolve(part, r.getAttribute('Target') || ''));
  return out;
}

async function imageSrc(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (!f || !MIME[ext]) return null;
  return `data:${MIME[ext]};base64,${bytesToBase64(await f.async('uint8array'))}`;
}

/** DrawingML paragraphs (a:p) of a text body. */
function drawingParas(body: Element): SlideText[] {
  const out: SlideText[] = [];
  for (const p of Array.from(body.children).filter((e) => e.localName === 'p')) {
    const ppr = child(p, 'pPr');
    const level = Number(ppr?.getAttribute('lvl') || 0);
    const bullet = !!ppr && !child(ppr, 'buNone') && (!!child(ppr, 'buChar') || !!child(ppr, 'buAutoNum'));
    const runs: SlideText['runs'] = [];
    for (const r of Array.from(p.children)) {
      if (r.localName === 'r' || r.localName === 'fld') {
        const rp = child(r, 'rPr');
        const sz = Number(rp?.getAttribute('sz') || 0);
        const cp: CharProps = { bold: rp?.getAttribute('b') === '1', italic: rp?.getAttribute('i') === '1', underline: !!rp?.getAttribute('u') && rp.getAttribute('u') !== 'none', strike: !!rp?.getAttribute('strike') && rp.getAttribute('strike') !== 'noStrike', size: sz ? sz / 100 : null };
        const fill = rp && child(rp, 'solidFill');
        const rgb = fill && child(fill, 'srgbClr')?.getAttribute('val');
        if (rgb && /^[0-9a-f]{6}$/i.test(rgb)) cp.color = '#' + rgb.toLowerCase();
        const latin = rp && child(rp, 'latin')?.getAttribute('typeface');
        if (latin && !latin.startsWith('+')) cp.font = latin;
        runs.push({ text: child(r, 't')?.textContent || '', cp });
      } else if (r.localName === 'br') runs.push({ text: '\n', cp: {} });
    }
    out.push({ level, bullet, runs });
  }
  return out;
}

export async function readPptx(data: ArrayBuffer | Uint8Array): Promise<Slide[]> {
  const zip = await loadZip(data);
  const pres = 'ppt/presentation.xml';
  const pr = await rels(zip, pres);
  const doc = xml((await zip.file(pres)?.async('string')) || '<p/>');
  const ids = kids(doc, 'sldId').map((s) => s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id') || '');
  const slides: Slide[] = [];
  for (const id of ids) {
    const path = pr.get(id);
    const f = path && zip.file(path);
    if (!f) continue;
    const sx = xml(await f.async('string'));
    const sr = await rels(zip, path!);
    const slide: Slide = { title: '', body: [], tables: [], images: [], notes: '' };
    const tree = kids(sx, 'spTree')[0];
    const walk = async (el: Element) => {
      for (const c of Array.from(el.children)) {
        if (c.localName === 'sp') {
          const ph = kids(c, 'ph')[0];
          const type = ph?.getAttribute('type') || '';
          const tb = child(c, 'txBody');
          if (!tb) continue;
          const paras = drawingParas(tb);
          if (/^(title|ctrTitle)$/.test(type) && !slide.title) slide.title = paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim();
          else if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
          else slide.body.push(...paras);
        } else if (c.localName === 'grpSp') await walk(c);
        else if (c.localName === 'pic') {
          const blip = kids(c, 'blip')[0];
          const rid = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') || blip?.getAttribute('r:embed');
          const src = rid && sr.get(rid) ? await imageSrc(zip, sr.get(rid)!) : null;
          const ext = kids(c, 'ext')[0];
          const emu = (v: string | null | undefined) => (v ? Number(v) / 12700 : null);
          if (src) slide.images.push({ src, w: emu(ext?.getAttribute('cx')), h: emu(ext?.getAttribute('cy')) });
        } else if (c.localName === 'graphicFrame') {
          const tbl = kids(c, 'tbl')[0];
          if (tbl) slide.tables.push(kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => kids(tc, 'p').map((p) => kids(p, 't').map((t) => t.textContent || '').join('')).join('\n'))));
        }
      }
    };
    if (tree) await walk(tree);
    const notesRel = [...sr.values()].find((t) => /notesSlide/.test(t));
    const nf = notesRel && zip.file(notesRel);
    if (nf) {
      const nx = xml(await nf.async('string'));
      slide.notes = kids(nx, 'sp').filter((s) => kids(s, 'ph')[0]?.getAttribute('type') === 'body').map((s) => kids(s, 'p').map((p) => kids(p, 't').map((t) => t.textContent || '').join('')).join('\n')).join('\n').trim();
    }
    slides.push(slide);
  }
  return slides;
}

export async function readOdp(data: ArrayBuffer | Uint8Array): Promise<Slide[]> {
  const u8 = u8a(data);
  let content: string, zip: JSZip | null = null;
  if (u8[0] === 0x50 && u8[1] === 0x4b) { zip = await loadZip(u8); content = (await zip.file('content.xml')?.async('string')) || ''; }
  else content = new TextDecoder().decode(u8);
  const d = xml(content);
  const P = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0', X = 'http://www.w3.org/1999/xlink', SVG = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
  const slides: Slide[] = [];
  const len = (v: string | null) => { const m = /^([\d.]+)(cm|mm|in|pt)$/.exec(v || ''); if (!m) return null; const n = +m[1]; return m[2] === 'cm' ? n / 2.54 * 72 : m[2] === 'mm' ? n / 25.4 * 72 : m[2] === 'in' ? n * 72 : n; };
  for (const page of kids(d, 'page').filter((e) => e.namespaceURI?.includes('drawing'))) {
    const slide: Slide = { title: '', body: [], tables: [], images: [], notes: '' };
    for (const frame of Array.from(page.children)) {
      if (frame.localName === 'notes') { slide.notes = kids(frame, 'p').map((p) => p.textContent || '').join('\n').trim(); continue; }
      const cls = frame.getAttributeNS(P, 'class') || '';
      const paras = (el: Element, level = 0, bullet = false): SlideText[] => {
        const out: SlideText[] = [];
        for (const c of Array.from(el.children)) {
          if (c.localName === 'p' || c.localName === 'h') out.push({ level, bullet, runs: [{ text: c.textContent || '', cp: {} }] });
          else if (c.localName === 'list') for (const li of Array.from(c.children)) out.push(...paras(li, level + (bullet ? 1 : 0), true));
          else if (c.localName === 'list-item' || c.localName === 'text-box') out.push(...paras(c, level, bullet));
        }
        return out;
      };
      const img = kids(frame, 'image')[0];
      if (img && zip) {
        const src = await imageSrc(zip, img.getAttributeNS(X, 'href') || '');
        if (src) slide.images.push({ src, w: len(frame.getAttributeNS(SVG, 'width')), h: len(frame.getAttributeNS(SVG, 'height')) });
        continue;
      }
      const tbl = kids(frame, 'table')[0];
      if (tbl) { slide.tables.push(kids(tbl, 'table-row').map((r) => kids(r, 'table-cell').map((c) => c.textContent || ''))); continue; }
      const box = kids(frame, 'text-box')[0];
      if (!box) continue;
      const ps = paras(box);
      if (cls === 'title' && !slide.title) slide.title = ps.map((p) => p.runs[0].text).join(' ').trim();
      else if (cls !== 'page-number' && cls !== 'footer' && cls !== 'date-time') slide.body.push(...ps);
    }
    slides.push(slide);
  }
  return slides;
}

/** PowerPoint 97-2003: titles and body text from the slide list's text atoms. */
export function readPpt(data: ArrayBuffer | Uint8Array): Slide[] {
  const cfb = openCfb(u8a(data));
  const s = cfb?.read('PowerPoint Document');
  if (!s) throw new Error('No PowerPoint Document stream (PowerPoint 4 and older are not supported)');
  const slides: Slide[] = [];
  let cur: Slide | null = null, kind = 1, inList = false, listEnd = 0;
  for (let p = 0; p + 8 <= s.length; ) {
    const verInst = le.u16(s, p), type = le.u16(s, p + 2), len = le.u32(s, p + 4);
    const start = p + 8;
    if (type === 0x0ff0) { inList = le.u16(s, p) >> 4 === 0; listEnd = start + len; p = start; continue; }
    if ((verInst & 0xf) === 0xf) { p = start; continue; }
    if (inList && p >= listEnd) inList = false;
    if (inList && type === 0x03f3) { cur = { title: '', body: [], tables: [], images: [], notes: '' }; slides.push(cur); }
    else if (inList && type === 0x0f9f) { if (start + 4 <= s.length) kind = le.u32(s, start); }
    else if (inList && cur && (type === 0x0fa0 || type === 0x0fa8)) {
      // The atom length is file-supplied: never read past the stream.
      const end = Math.min(s.length, start + len);
      const cs: string[] = [];
      if (type === 0x0fa0) for (let i = start; i + 1 < end; i += 2) cs.push(String.fromCharCode(le.u16(s, i)));
      else for (let i = start; i < end; i++) cs.push(String.fromCharCode(s[i]));
      const t = cs.join('').replace(/\r/g, '\n').replace(/\x0b/g, '\n');
      if ((kind === 0 || kind === 6) && !cur.title) cur.title = t.trim();
      else for (const line of t.split('\n')) cur.body.push({ level: 0, bullet: kind === 1 || kind === 5 || kind === 7, runs: [{ text: line, cp: {} }] });
    }
    p = start + len;
  }
  return slides;
}

export function slidesToDoc(slides: Slide[], title: string): PMNode {
  // A slide without a title placeholder: its first short, unbulleted line serves as the title.
  for (const s of slides) {
    if (s.title || !s.body.length || s.body[0].bullet) continue;
    const t = s.body[0].runs.map((r) => r.text).join('').trim();
    if (t && t.length <= 80 && !t.includes('\n')) { s.title = t; s.body.shift(); }
  }
  const b = new DocBuilder();
  b.property('title', title);
  b.page({ width: 792, height: 612, top: 54, bottom: 54, left: 54, right: 54, landscape: true });
  slides.forEach((s, i) => {
    if (i > 0) b.sectionBreak('nextPage');
    b.text(s.title || `Slide ${i + 1}`);
    b.endParagraph({ style: 'Heading 1' });
    for (const p of s.body) {
      const text = p.runs.map((r) => r.text).join('');
      if (!text.trim()) continue;
      for (const r of p.runs) b.text(r.text, r.cp);
      b.endParagraph(p.bullet ? { list: { ordered: false, level: p.level } } : { indentLeft: p.level ? p.level * 18 : null });
    }
    for (const t of s.tables) {
      b.startTable();
      for (const row of t) { b.startRow(); for (const c of row) { b.startCell(); b.text(c); b.endParagraph(); b.endCell(); } b.endRow(); }
      b.endTable();
    }
    for (const im of s.images) {
      const scale = im.w && im.w > 600 ? 600 / im.w : 1;
      b.image(im.src, { width: im.w ? im.w * scale : null, height: im.h ? im.h * scale : null });
      b.endParagraph({ align: 'center' });
    }
    if (s.notes) { b.text('Notes: ', { italic: true, bold: true }); b.text(s.notes, { italic: true }); b.endParagraph(); }
  });
  if (!slides.length) { b.text('The presentation has no slides.', { italic: true }); b.endParagraph(); }
  return b.build();
}

export async function importPresentation(data: ArrayBuffer, name: string, kind: string): Promise<PMNode> {
  const slides = kind === 'pptx' ? await readPptx(data) : kind === 'odp' ? await readOdp(data) : readPpt(data);
  return slidesToDoc(slides, name.replace(/\.[^.]+$/, ''));
}
