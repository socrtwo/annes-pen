/**
 * File format registry.
 *
 * Contract for converter modules (src/io/<format>.ts):
 *   import:  (data: ArrayBuffer, name: string) => Promise<PMNode>   // a `doc` node; settings in doc.attrs.settings
 *   export:  (doc: PMNode, opts: ExportOptions) => Promise<Blob>
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { RecoveryReport } from './recover';
import { normalizeTables } from '../editor/normalize';
import { sniff, registerSniffer, PLAIN_TEXT_EXTS, type SniffCategory, type SniffResult } from './sniff';
import { LEGACY_FORMATS } from './formats-legacy';
import { FORMATS_B } from './formats-b';
import { snifferRulesB } from './sniff-b';
import { decodeAuto } from './encoding';
import { ZipLimitError } from './zip';

export { sniff, registerSniffer, sniffRules, type SniffResult, type SniffRule, type SniffCategory } from './sniff';

// The XML, archive and text-markup formats bring their own detection rules (one rule per format:
// a registered rule replaces the built-in rule for the same format).
// A message that went through a mail system (transport headers) is email even when its body is
// multipart/related; browser-saved web archives never carry these headers.
const MAIL_TRANSPORT = /^(Received|Message-ID|Delivered-To|Return-Path|To|Cc):/im;
for (const r of snifferRulesB()) {
  if (r.format !== 'mhtml') { registerSniffer(r); continue; }
  registerSniffer({
    ...r,
    test: (ctx) => {
      const ext = (ctx.name.split('.').pop() || '').toLowerCase();
      if (ext !== 'mht' && ext !== 'mhtml' && MAIL_TRANSPORT.test(ctx.head.slice(0, 8192).split(/\r?\n\r?\n/)[0])) return 0;
      return r.test(ctx);
    },
  });
}

export interface ExportOptions {
  fileName: string;
  author: string;
  /** Title for formats that carry one (EPUB, HTML). */
  title?: string;
}

export interface FormatDef {
  id: string;
  label: string;
  ext: string[];
  mime: string;
  canImport: boolean;
  canExport: boolean;
  import?: (data: ArrayBuffer, name: string) => Promise<PMNode>;
  export?: (doc: PMNode, opts: ExportOptions) => Promise<Blob>;
  note?: string;
  /** What the file holds; anything but 'document' opens through the cross-category choice. */
  category?: SniffCategory;
  /** How closely an import matches the original program (see docs/FORMATS.md). */
  fidelity?: 'full' | 'high' | 'basic' | 'text';
}

const lazy = <T>(loader: () => Promise<T>) => loader;

export const FORMATS: FormatDef[] = [
  {
    id: 'docx', label: 'Word Document (.docx)', ext: ['docx', 'docm', 'dotx', 'dotm'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', canImport: true, canExport: true,
    import: async (d, n) => (await import('./docx-import')).importDocx(d, n),
    export: async (doc, o) => (await import('./docx-export')).exportDocx(doc, o),
  },
  {
    id: 'doc', label: 'Word 97-2003 Document (.doc)', ext: ['doc', 'dot', 'wbk', 'asd'], mime: 'application/msword', canImport: true, canExport: false,
    import: async (d, n) => {
      // Formatted reader first; the text-only piece-table reader is the fallback for unusual files.
      const rec = await import('./recover');
      try {
        const doc = await (await import('./legacy/word')).importWord97(d, n);
        // A formatted import that lost much of the piece-table text means unusual structures: keep the text instead.
        const plain = (await import('./recover/doc97')).extractDoc97(new Uint8Array(d));
        const want = plain && !plain.encrypted ? plain.main.replace(/\s+/g, '').length : 0;
        if (want > 200 && doc.textContent.replace(/\s+/g, '').length < want * 0.6) return rec.importDoc97(d, n);
        return doc;
      } catch { return rec.importDoc97(d, n); }
    },
    fidelity: 'high',
    note: 'Text, character and paragraph formatting, styles, lists, tables, notes, pictures, headers and footers',
  },
  {
    id: 'odt', label: 'OpenDocument Text (.odt)', ext: ['odt', 'ott'], mime: 'application/vnd.oasis.opendocument.text', canImport: true, canExport: true,
    import: async (d, n) => (await import('./odt')).importOdt(d, n),
    export: async (doc, o) => (await import('./odt')).exportOdt(doc, o),
  },
  {
    id: 'rtf', label: 'Rich Text Format (.rtf)', ext: ['rtf'], mime: 'application/rtf', canImport: true, canExport: true,
    import: async (d, n) => (await import('./rtf')).importRtf(d, n),
    export: async (doc, o) => (await import('./rtf')).exportRtf(doc, o),
  },
  {
    id: 'html', label: 'Web Page (.html)', ext: ['html', 'htm', 'xhtml'], mime: 'text/html', canImport: true, canExport: true,
    import: async (d, n) => (await import('./html')).importHtml(d, n),
    export: async (doc, o) => (await import('./html')).exportHtml(doc, o),
  },
  {
    id: 'md', label: 'Markdown (.md)', ext: ['md', 'markdown', 'mdown', 'txt.md'], mime: 'text/markdown', canImport: true, canExport: true,
    import: async (d, n) => (await import('./markdown')).importMarkdown(d, n),
    export: async (doc, o) => (await import('./markdown')).exportMarkdown(doc, o),
  },
  {
    id: 'txt', label: 'Plain Text (.txt)', ext: ['txt', 'text', 'log', 'csv'], mime: 'text/plain', canImport: true, canExport: true,
    import: async (d, n) => (await import('./text')).importText(d, n),
    export: async (doc, o) => (await import('./text')).exportText(doc, o),
  },
  {
    id: 'epub', label: 'EPUB e-book (.epub)', ext: ['epub'], mime: 'application/epub+zip', canImport: true, canExport: true,
    import: async (d, n) => (await import('./epub')).importEpub(d, n),
    export: async (doc, o) => (await import('./epub')).exportEpub(doc, o),
  },
  {
    id: 'fodt', label: 'Flat OpenDocument (.fodt)', ext: ['fodt'], mime: 'application/vnd.oasis.opendocument.text-flat-xml', canImport: true, canExport: true,
    import: async (d, n) => (await import('./odt')).importFodt(d, n),
    export: async (doc, o) => (await import('./odt')).exportFodt(doc, o),
  },
  {
    id: 'qpd', label: 'Anne\'s Pen Document (.qpd)', ext: ['qpd', 'qfd', 'json'], mime: 'application/json', canImport: true, canExport: true, // rename:keep — Anne's Pen was named QuillForge; its .qfd/.qfde files still open
    import: async (d) => (await import('./native')).importNative(d),
    export: async (doc) => (await import('./native')).exportNative(doc),
  },
  ...FORMATS_B,
  ...LEGACY_FORMATS,
  { id: 'pdf', label: 'PDF (via Print ▸ Save as PDF)', ext: ['pdf'], mime: 'application/pdf', canImport: false, canExport: true, note: 'Uses the system print service' },
];
void lazy;

export function formatForName(name: string): FormatDef | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return FORMATS.find((f) => f.ext.includes(ext));
}

export function formatById(id: string): FormatDef | undefined {
  return FORMATS.find((f) => f.id === id);
}

/** The format that opens this file, chosen by content (the extension only breaks ties). */
export function sniffFormat(data: ArrayBuffer, name: string): FormatDef | undefined {
  return formatForSniff(sniff(data, name), name);
}

/** The importer for a sniff result: the detected format, else the extension's, else plain text for text. */
export function formatForSniff(s: SniffResult, name: string): FormatDef | undefined {
  const byId = formatById(s.format);
  const byName = formatForName(name);
  // A .txt name beats a guess: extension-only results and light-markup/table guesses below 0.8
  // (only a binary or container signature overrides a plain-text extension).
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (byName?.id === 'txt' && PLAIN_TEXT_EXTS.includes(ext) && s.format !== 'txt' && (s.confidence < 0.3 || (s.confidence < 0.8 && TEXTUAL.includes(s.format)))) return byName;
  if (byId?.canImport) return byId;
  if (s.confidence < 0.3 && byName?.canImport) return byName;
  if (s.format === 'txt' || s.format === 'unknown') return byName?.canImport && s.format === 'unknown' ? byName : s.format === 'txt' ? formatById('txt') : undefined;
  return undefined;
}

export interface ImportResult {
  doc: PMNode;
  format: FormatDef;
  /** Present when the file was damaged and had to be recovered (or Open and Repair was used). */
  recovery?: RecoveryReport;
  /** What the content was identified as. */
  sniffed?: SniffResult;
  /** Short note for the user, e.g. when the file name's extension disagreed with the content. */
  note?: string;
}

/** Formats detected from text heuristics only. */
const TEXTUAL = ['md', 'rst', 'textile', 'asciidoc', 'org', 'man', 'latex', 'csv', 'tsv', 'html', 'mbox', 'eml', 'sam', 't602'];

/** Formats whose damaged files go through the recovery pipeline instead of failing. */
const RECOVERABLE = ['docx', 'doc', 'odt', 'rtf', 'epub', 'fodt', ...LEGACY_FORMATS.filter((f) => !f.category).map((f) => f.id)];

export interface ImportOptions { repair?: boolean; textOnly?: boolean; sniffed?: SniffResult }

export async function importFile(data: ArrayBuffer, name: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const sniffed = opts.sniffed || sniff(data, name);
  const r = await importRaw(data, name, opts, sniffed);
  return { ...r, doc: normalizeTables(r.doc), sniffed, note: r.note ?? sniffed.note };
}

async function importRaw(data: ArrayBuffer, name: string, opts: ImportOptions, sniffed: SniffResult): Promise<ImportResult> {
  const fmt = formatForSniff(sniffed, name);
  const recover = async (cause: unknown, force: boolean) => {
    const { recoverDocument } = await import('./recover');
    const report = await recoverDocument(data, name, { force, textOnly: opts.textOnly, format: sniffed.format });
    if (!report.doc) {
      const why = report.notes.join(' ') || 'No recoverable content was found.';
      throw new Error(cause instanceof Error ? `${cause.message}. ${why}` : why);
    }
    if (cause instanceof Error) report.notes.unshift(`Normal open failed: ${friendlyOpenError(cause.message)}`);
    const kind = report.repaired?.kind || (fmt && RECOVERABLE.includes(fmt.id) ? fmt.id : 'docx');
    return { doc: report.doc, format: formatById(kind) || formatById('docx')!, recovery: report };
  };
  if (opts.repair || opts.textOnly) return recover(null, true);
  if (!fmt || !fmt.import) {
    const what = sniffed.format !== 'unknown' && sniffed.format !== 'txt' ? `${sniffed.label} files cannot be opened yet` : `Unsupported file type: ${name}`;
    const r = await recover(new Error(what), false);
    return { ...r, note: sniffed.format !== 'unknown' ? `${sniffed.label}: only its text could be recovered.` : undefined };
  }
  let doc: PMNode;
  try {
    doc = await fmt.import(data, name);
  } catch (e) {
    // A package over the size limits must not be inflated again by the salvage readers.
    if (e instanceof ZipLimitError) throw e;
    if (!RECOVERABLE.includes(fmt.id)) {
      const asText = await textFallback(data, fmt, e);
      if (asText) return asText;
      throw e;
    }
    return recover(e, false);
  }
  // A package that "opens" but yields nothing from a sizable file is usually damaged inside.
  // (.doc runs its own checks: an empty main story there is a genuinely empty document.)
  if (['docx', 'odt', 'rtf', 'epub', 'fodt'].includes(fmt.id) && data.byteLength > 4096 && !doc.textContent.trim() && !hasAtoms(doc)) {
    try {
      const r = await recover(null, true);
      if (r.doc.textContent.trim()) return r;
    } catch { /* keep the empty document */ }
  }
  return { doc, format: fmt };
}

/** A file whose importer failed but whose bytes are readable text opens as plain text, with a note. */
async function textFallback(data: ArrayBuffer, fmt: FormatDef, cause: unknown): Promise<ImportResult | null> {
  if (fmt.id === 'txt' || !data.byteLength) return null;
  const text = decodeAuto(new Uint8Array(data, 0, Math.min(data.byteLength, 65536)));
  let ok = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x20 && c !== 0x7f && c !== 0xfffd && (c < 0x80 || c >= 0xa0)) || c === 9 || c === 10 || c === 13 || c === 12) ok++;
  }
  if (!text.length || ok < text.length * 0.95) return null;
  const txt = formatById('txt')!;
  const doc = await txt.import!(data, 'text.txt');
  const why = friendlyOpenError(cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, '');
  return { doc, format: txt, note: `Could not read as ${fmt.label}: ${why}; opened as plain text.` };
}

/** Translate low-level ZIP/inflate errors into plain language for the recovery report. */
export function friendlyOpenError(msg: string): string {
  // JSZip: "End of data reached (data length = …)", "Corrupted zip: missing 12 bytes", "Corrupted zip: can't find end of central directory".
  if (/end of data reached|corrupted zip ?:? ?missing|corrupted zip \?/i.test(msg)) return 'the file is cut short or its ZIP structure is damaged.';
  if (/corrupted zip.*central directory|can't find end of central/i.test(msg)) return 'the file\'s table of contents (ZIP central directory) is missing or damaged.';
  if (/size mismatch|invalid (distance|code|block|stored)|too far back|incorrect header|unexpected end|crc32|corrupt/i.test(msg)) return 'compressed data inside the file is damaged.';
  if (/end of central directory|is this a zip/i.test(msg)) return 'the file\'s table of contents (ZIP central directory) is missing or damaged.';
  if (/document\.xml is missing or unreadable/i.test(msg)) return 'the main document part could not be read.';
  return msg;
}

function hasAtoms(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => { if (found) return false; if (n.isAtom && n.type.name !== 'hard_break') found = true; return !found; });
  return found;
}

export async function exportFile(doc: PMNode, formatId: string, opts: ExportOptions): Promise<Blob> {
  const fmt = formatById(formatId);
  if (!fmt || !fmt.export) throw new Error(`Cannot export as ${formatId}`);
  return fmt.export(normalizeTables(doc), opts);
}

/** Decode text bytes (BOM, UTF-16, UTF-8, then the legacy code page detector). */
export function decodeText(data: ArrayBuffer): string {
  return decodeAuto(data);
}
