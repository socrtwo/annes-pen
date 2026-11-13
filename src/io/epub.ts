/**
 * EPUB 3 import / export.
 *
 * Export: mimetype (stored, first), META-INF/container.xml, OEBPS/content.opf (dc:title,
 * dc:creator, dc:language, dc:identifier urn:uuid, dcterms:modified), nav.xhtml generated from the
 * headings, toc.ncx for EPUB 2 readers, one XHTML chapter per Heading 1 (or a single chapter),
 * styles.css (stylesCss + base CSS), images extracted from data URLs into OEBPS/images/, and
 * footnotes as EPUB 3 pop-up notes (epub:type="noteref" / aside epub:type="footnote").
 *
 * Import: container.xml → OPF → spine order; every XHTML document's body is merged into one HTML
 * document (ids/links rewritten so cross-file footnotes and links keep working, images resolved
 * to data URLs) and converted with the HTML importer. Title/author/language come from the OPF.
 */
import JSZip from 'jszip';
import { loadZip } from './zip';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { styleLevel } from '../editor/schema';
import { stylesCss } from '../editor/styles';
import type { ExportOptions } from './index';
import { cleanHtmlDom, domToBlocks, parseHtmlDocument } from './html';
import {
  baseCss, collectFootnotes, normalizeImportedFormatting, docSettings, docTitle, escapeXml, extForMime, finishDoc, isoNow, makeBlob, mimeForName, newSettings,
  parseDataUrl, prepareDoc, renderHtml, sniffImageMime, toDataUrl, toXhtml, uuid,
} from './serialize';

const x = escapeXml;
const safeDecode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
const EPUB_MIME = 'application/epub+zip';

interface Chapter { title: string; blocks: PMNode[]; file: string }
interface TocEntry { level: number; title: string; href: string; children: TocEntry[] }

function splitChapters(doc: PMNode, title: string): Chapter[] {
  const chapters: Chapter[] = [];
  let cur: Chapter = { title, blocks: [], file: '' };
  const isH1 = (n: PMNode) => n.type.name === 'paragraph' && styleLevel(n.attrs.style, n.attrs.outlineLevel) === 1;
  const meaningful = (bs: PMNode[]) => bs.some((b) => !(b.type.name === 'paragraph' && !b.textContent.trim() && b.childCount === 0) && b.type.name !== 'page_break' && b.type.name !== 'section_break');
  doc.forEach((b) => {
    if (isH1(b) && cur.blocks.length) {
      if (meaningful(cur.blocks)) chapters.push(cur);
      cur = { title: b.textContent.trim() || title, blocks: [], file: '' };
    } else if (isH1(b)) cur.title = b.textContent.trim() || title;
    cur.blocks.push(b);
  });
  if (meaningful(cur.blocks) || !chapters.length) chapters.push(cur);
  chapters.forEach((c, i) => { c.file = `chapter${i + 1}.xhtml`; });
  return chapters;
}

function buildToc(chapters: Chapter[], docTitleText: string): TocEntry[] {
  const root: TocEntry = { level: 0, title: '', href: '', children: [] };
  const stack: TocEntry[] = [root];
  for (const ch of chapters) {
    let any = false;
    for (const b of ch.blocks) {
      if (b.type.name !== 'paragraph') continue;
      const lvl = styleLevel(b.attrs.style, b.attrs.outlineLevel);
      if (lvl < 1 || lvl > 3) continue;
      const text = b.textContent.trim();
      if (!text) continue;
      any = true;
      const e: TocEntry = { level: lvl, title: text, href: `${ch.file}#${b.attrs.id}`, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= lvl) stack.pop();
      stack[stack.length - 1].children.push(e);
      stack.push(e);
    }
    if (!any) {
      while (stack.length > 1) stack.pop();
      root.children.push({ level: 1, title: ch.title || docTitleText, href: ch.file, children: [] });
    }
  }
  return root.children;
}

function navOl(entries: TocEntry[]): string {
  if (!entries.length) return '';
  return `<ol>${entries.map((e) => `<li><a href="${x(e.href)}">${x(e.title)}</a>${navOl(e.children)}</li>`).join('')}</ol>`;
}

function ncxPoints(entries: TocEntry[], counter: { n: number }): string {
  return entries.map((e) => {
    const n = ++counter.n;
    return `<navPoint id="navPoint-${n}" playOrder="${n}"><navLabel><text>${x(e.title)}</text></navLabel><content src="${x(e.href)}"/>${ncxPoints(e.children, counter)}</navPoint>`;
  }).join('');
}

function xhtmlPage(title: string, lang: string, body: string, css = 'styles.css'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${x(lang)}" lang="${x(lang)}">
<head>
<meta charset="UTF-8"/>
<title>${x(title)}</title>
<link rel="stylesheet" type="text/css" href="${css}"/>
</head>
<body>
${body}
</body>
</html>
`;
}

export async function exportEpubBytes(doc: PMNode, opts: ExportOptions): Promise<Uint8Array> {
  const settings = docSettings(doc);
  const title = docTitle(doc, opts);
  const author = settings.properties.author || opts.author || '';
  const lang = settings.language || 'en';
  const id = `urn:uuid:${uuid()}`;
  const prepared = prepareDoc(doc, { headingIds: true });
  const notes = collectFootnotes(prepared);
  const chapters = splitChapters(prepared, title);
  const images = new Map<string, { path: string; bytes: Uint8Array; mime: string; id: string }>();
  let remote = false;
  const imageSrc = (src: string) => {
    const d = parseDataUrl(src);
    if (!d) { if (/^https?:/i.test(src)) remote = true; return src; }
    let img = images.get(src);
    if (!img) {
      // The data URL's own type is document data: keep it only when it is a plain image type.
      const mime = sniffImageMime(d.bytes) || (/^image\/[\w.+-]+$/.test(d.mime) ? d.mime : 'application/octet-stream');
      const n = images.size + 1;
      img = { path: `images/image${n}.${extForMime(mime)}`, bytes: d.bytes, mime, id: `img${n}` };
      images.set(src, img);
    }
    return img.path;
  };
  const htmlDoc = document.implementation.createHTMLDocument('');
  const chapterXml: { file: string; xml: string; remote: boolean }[] = [];
  for (const ch of chapters) {
    remote = false;
    const { container, notes: used } = renderHtml(Fragment.fromArray(ch.blocks), notes, {
      document: htmlDoc, epub: true, imageSrc,
      noteHref: (n) => `#fn${n.index}`, noteRefId: (n) => `fnref${n.index}`,
    });
    let body = toXhtml(container).replace(/ data-epub-noteref="1"/g, ' epub:type="noteref"');
    const asides = used.map((n) => {
      const paras = n.text.split(/\n+/).filter((p) => p.trim());
      const first = paras.shift() || '';
      return `<aside epub:type="${n.kind === 'end' ? 'endnote' : 'footnote'}" id="fn${n.index}" role="doc-${n.kind === 'end' ? 'endnote' : 'footnote'}" class="footnote"><p><a href="#fnref${n.index}" role="doc-backlink">${x(n.label)}</a> ${x(first)}</p>${paras.map((p) => `<p>${x(p)}</p>`).join('')}</aside>`;
    }).join('\n');
    body = `<section epub:type="chapter" role="doc-chapter"><div class="qf-doc"><div class="ProseMirror">${body}</div></div></section>${asides ? '\n' + asides : ''}`;
    chapterXml.push({ file: ch.file, xml: xhtmlPage(ch.title || title, lang, body), remote });
  }
  const toc = buildToc(chapters, title);
  const nav = xhtmlPage(title, lang, `<nav epub:type="toc" id="toc" role="doc-toc"><h1>Contents</h1>${navOl(toc) || `<ol><li><a href="${chapters[0].file}">${x(title)}</a></li></ol>`}</nav>`);
  const counter = { n: 0 };
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${x(lang)}">
<head><meta name="dtb:uid" content="${x(id)}"/><meta name="dtb:depth" content="3"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${x(title)}</text></docTitle>${author ? `<docAuthor><text>${x(author)}</text></docAuthor>` : ''}
<navMap>${ncxPoints(toc.length ? toc : [{ level: 1, title, href: chapters[0].file, children: [] }], counter)}</navMap>
</ncx>
`;
  const p = settings.properties;
  const meta = [
    `<dc:identifier id="bookid">${x(id)}</dc:identifier>`,
    `<dc:title>${x(title)}</dc:title>`,
    `<dc:language>${x(lang)}</dc:language>`,
    author ? `<dc:creator id="creator">${x(author)}</dc:creator>` : '',
    p.subject ? `<dc:subject>${x(p.subject)}</dc:subject>` : '',
    ...(p.keywords ? p.keywords.split(/\s*[,;]\s*/).filter(Boolean).map((k) => `<dc:subject>${x(k)}</dc:subject>`) : []),
    p.comments ? `<dc:description>${x(p.comments)}</dc:description>` : '',
    p.company ? `<dc:publisher>${x(p.company)}</dc:publisher>` : '',
    `<meta property="dcterms:modified">${isoNow()}</meta>`,
    '<meta name="generator" content="Anne\'s Pen"/>',
  ].filter(Boolean).join('\n    ');
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    ...chapterXml.map((c, i) => `<item id="chapter${i + 1}" href="${c.file}" media-type="application/xhtml+xml"${c.remote ? ' properties="remote-resources"' : ''}/>`),
    ...[...images.values()].map((im) => `<item id="${im.id}" href="${im.path}" media-type="${x(im.mime)}"/>`),
  ].join('\n    ');
  const spine = chapterXml.map((_c, i) => `<itemref idref="chapter${i + 1}"/>`).join('\n    ');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${x(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${meta}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>
`;
  const css = `${baseCss(settings, true)}\n${stylesCss(settings)}`;
  const zip = new JSZip();
  zip.file('mimetype', EPUB_MIME, { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`);
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/nav.xhtml', nav);
  zip.file('OEBPS/toc.ncx', ncx);
  zip.file('OEBPS/styles.css', css);
  for (const c of chapterXml) zip.file(`OEBPS/${c.file}`, c.xml);
  for (const im of images.values()) zip.file(`OEBPS/${im.path}`, im.bytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: EPUB_MIME });
}

export async function exportEpub(doc: PMNode, opts: ExportOptions): Promise<Blob> {
  return makeBlob(await exportEpubBytes(doc, opts), EPUB_MIME);
}

// =============================================================================================
// Import

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function resolvePath(base: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
  const parts = (rel.startsWith('/') ? rel.slice(1) : base + rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function parseXmlDoc(text: string, type: DOMParserSupportedType = 'application/xml'): Document | null {
  try {
    const d = new DOMParser().parseFromString(text, type);
    if (type !== 'text/html' && d.getElementsByTagName('parsererror').length) return null;
    return d;
  } catch {
    return null;
  }
}

const byLocal = (root: Document | Element, name: string): Element[] => Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name);

export async function importEpub(data: ArrayBuffer, name: string): Promise<PMNode> {
  void name;
  const settings = newSettings();
  let zip: JSZip;
  try { zip = await loadZip(data); } catch { return finishDoc([], settings); }
  const read = async (p: string): Promise<string | null> => {
    const f = zip.file(p) || zip.file(safeDecode(p));
    return f ? f.async('string') : null;
  };
  const readBytes = async (p: string): Promise<Uint8Array | null> => {
    const f = zip.file(p) || zip.file(safeDecode(p));
    return f ? f.async('uint8array') : null;
  };
  try {
    const container = await read('META-INF/container.xml');
    let opfPath = '';
    if (container) {
      const d = parseXmlDoc(container);
      const rf = d ? byLocal(d, 'rootfile').find((r) => !r.getAttribute('media-type') || r.getAttribute('media-type') === 'application/oebps-package+xml') : null;
      opfPath = rf?.getAttribute('full-path') || '';
    }
    if (!opfPath) opfPath = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf')) || '';
    const opfText = opfPath ? await read(opfPath) : null;
    const opf = opfText ? parseXmlDoc(opfText) : null;
    if (!opf) return finishDoc([], settings);
    const base = dirOf(opfPath);
    const text = (n: string) => byLocal(opf, n)[0]?.textContent?.trim() || '';
    if (text('title')) settings.properties.title = text('title');
    if (text('creator')) settings.properties.author = text('creator');
    if (text('language')) settings.language = text('language');
    if (text('description')) settings.properties.comments = text('description').replace(/<[^>]+>/g, '');
    const subjects = byLocal(opf, 'subject').map((s) => (s.textContent || '').trim()).filter(Boolean);
    if (subjects.length) settings.properties.keywords = subjects.join(', ');
    if (text('publisher')) settings.properties.company = text('publisher');
    const manifest = new Map<string, { href: string; type: string; props: string }>();
    for (const it of byLocal(opf, 'item')) {
      manifest.set(it.getAttribute('id') || '', { href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
    }
    let spineIds = byLocal(opf, 'itemref').map((r) => r.getAttribute('idref') || '');
    if (!spineIds.length) spineIds = [...manifest.entries()].filter(([, v]) => /html/.test(v.type)).map(([k]) => k);
    const files = spineIds.map((sid) => manifest.get(sid)).filter((m): m is { href: string; type: string; props: string } => !!m && /html|xml/.test(m.type) && !/\bnav\b/.test(m.props))
      .map((m) => resolvePath(base, safeDecode(m.href.split('#')[0])));
    const index = new Map(files.map((f, i) => [f, i]));
    const parts: string[] = [];
    const imageCache = new Map<string, string>();
    const ser = new XMLSerializer();
    for (let ci = 0; ci < files.length; ci++) {
      const path = files[ci];
      const src = await read(path);
      if (!src) continue;
      let d = parseXmlDoc(src, 'application/xhtml+xml');
      if (!d || !d.getElementsByTagName('body').length) d = parseXmlDoc(src, 'text/html');
      if (!d) continue;
      const body = d.getElementsByTagName('body')[0] || d.documentElement;
      const dir = dirOf(path);
      const pre = `c${ci + 1}-`;
      // Rewrite ids and links so the merged document stays consistent.
      for (const el of Array.from(body.getElementsByTagName('*'))) {
        const id = el.getAttribute('id');
        if (id) el.setAttribute('id', pre + id);
        if (el.localName === 'a' && el.getAttribute('name') && !el.getAttribute('href')) el.setAttribute('name', pre + el.getAttribute('name'));
        const href = el.localName === 'a' ? el.getAttribute('href') : null;
        if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          const [file, frag] = href.split('#');
          if (!file) el.setAttribute('href', `#${pre}${frag || ''}`);
          else {
            const target = index.get(resolvePath(dir, safeDecode(file)));
            if (target != null) el.setAttribute('href', frag ? `#c${target + 1}-${frag}` : `#c${target + 1}-top`);
          }
        }
      }
      // Images (XHTML <img> and SVG <image>).
      const imgs = Array.from(body.getElementsByTagName('*')).filter((e) => e.localName === 'img' || e.localName === 'image');
      for (const im of imgs) {
        const ref = im.localName === 'img' ? im.getAttribute('src') : (im.getAttribute('xlink:href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || im.getAttribute('href'));
        if (!ref || /^(data|https?):/i.test(ref)) continue;
        const p = resolvePath(dir, safeDecode(ref));
        let url = imageCache.get(p);
        if (!url) {
          const bytes = await readBytes(p);
          if (!bytes) continue;
          url = toDataUrl(bytes, sniffImageMime(bytes) || mimeForName(p));
          imageCache.set(p, url);
        }
        if (im.localName === 'img') im.setAttribute('src', url);
        else {
          // Replace an SVG cover wrapper with a plain image.
          const svg = im.closest ? im.closest('svg') : null;
          const img = d.createElementNS('http://www.w3.org/1999/xhtml', 'img');
          img.setAttribute('src', url);
          img.setAttribute('alt', '');
          (svg || im).parentNode?.replaceChild(img, svg || im);
        }
      }
      let html = d.contentType === 'text/html' ? (body as HTMLElement).innerHTML : Array.from(body.childNodes).map((n) => ser.serializeToString(n)).join('');
      // Namespace declarations come off the tags only: the same characters in text are content.
      html = html.replace(/<[^>]*>/g, (tag) => tag.replace(/ xmlns(:\w+)?="[^"]*"/g, ''));
      parts.push(`<div class="epub-chapter" id="${pre}top">${html}</div>`);
    }
    const merged = parseHtmlDocument(`<!DOCTYPE html><html><body>${parts.join('\n')}</body></html>`);
    cleanHtmlDom(merged.body);
    // Remove EPUB navigation leftovers (page-list, landmarks) that may live in content documents.
    merged.body.querySelectorAll('nav').forEach((n) => n.remove());
    return finishDoc(normalizeImportedFormatting(domToBlocks(merged.body), settings, null), settings);
  } catch {
    return finishDoc([], settings);
  }
}
