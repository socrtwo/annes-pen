/** Clipboard, editing, selection, find/replace and navigation commands. */
import { def, getCommand } from './registry';
import type { App } from '../app';
import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { TextSelection, NodeSelection, Selection } from 'prosemirror-state';
import { Slice, Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, styleLevel } from '../editor/schema';
import {
  selectAll, selectParagraph, selectRange, wordAt, sentenceAt, moveBlocks, duplicateBlocks, deleteBlocks,
  topLevelRange, currentParagraph, textblocks, selectedText,
} from '../editor/ops';
import { setFind, selectMatch, findKey, buildMatcher, findMatches } from '../editor/plugins/decorations';
import { pageInfo } from '../editor/plugins/pagination';
import { listChanges } from '../editor/plugins/trackChanges';
import { openDialog, toast, promptDialog } from '../ui/dialog';

const N = schema.nodes;
const v = (app: App) => app.view;

async function readClipboard(): Promise<{ html?: string; text?: string } | null> {
  const nav = navigator as any;
  try {
    if (nav.clipboard?.read) {
      const items = await nav.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/html')) return { html: await (await it.getType('text/html')).text(), text: it.types.includes('text/plain') ? await (await it.getType('text/plain')).text() : undefined };
        if (it.types.includes('text/plain')) return { text: await (await it.getType('text/plain')).text() };
      }
    }
  } catch { /* fall through */ }
  try {
    if (nav.clipboard?.readText) return { text: await nav.clipboard.readText() };
  } catch { /* */ }
  return null;
}

async function pasteWith(app: App, mode: 'keep' | 'merge' | 'text' | 'html' | 'markdown' | 'unformatted-keep-paragraphs') {
  const clip = await readClipboard();
  const view = v(app);
  if (!clip) { toast('Clipboard access was denied. Long-press in the document and choose Paste.'); return; }
  if (mode === 'text' || (!clip.html && mode !== 'markdown')) {
    view.pasteText(clip.text || '');
    return;
  }
  if (mode === 'markdown') {
    const { importMarkdown } = await import('../io/markdown');
    const doc = await importMarkdown(new TextEncoder().encode(clip.text || '').buffer, 'clip.md');
    view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 1, 1)).scrollIntoView());
    return;
  }
  let html = clip.html!;
  try { const { cleanPastedHtml } = await import('../io/html'); html = cleanPastedHtml(html); } catch { /* */ }
  if (mode === 'merge') {
    // Keep structure (paragraphs, lists, tables, links, bold/italic) but drop fonts, sizes, colors.
    // An inert document: nothing in the pasted HTML loads or runs while it is rewritten.
    const div = document.implementation.createHTMLDocument('').body;
    div.innerHTML = html;
    div.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
      el.style.removeProperty('font-family'); el.style.removeProperty('font-size'); el.style.removeProperty('color');
      el.style.removeProperty('background-color'); el.style.removeProperty('background'); el.style.removeProperty('line-height');
    });
    div.querySelectorAll('font').forEach((f) => f.replaceWith(...[...f.childNodes]));
    html = div.innerHTML;
  }
  view.pasteHTML(html);
}

def([
  { id: 'edit.undo', label: 'Undo', icon: 'undo', tab: 'Home', group: 'Clipboard', keys: ['Mod-z'], popular: true, noRecord: false, run: (app) => undo(app.state, app.view.dispatch), isEnabled: (app) => undoDepth(app.state) > 0 },
  { id: 'edit.redo', label: 'Redo', icon: 'redo', tab: 'Home', group: 'Clipboard', keys: ['Mod-y', 'Mod-Shift-z'], popular: true, run: (app) => redo(app.state, app.view.dispatch), isEnabled: (app) => redoDepth(app.state) > 0 },
  {
    id: 'edit.repeat', label: 'Repeat Last Action', icon: 'repeat', tab: 'Home', group: 'Clipboard', keys: ['F4'],
    run: (app) => { const l = app.lastCommand; if (!l) { toast('Nothing to repeat.'); return; } app.exec(l.id, l.arg); },
  },
  {
    id: 'edit.cut', label: 'Cut', icon: 'content_cut', tab: 'Home', group: 'Clipboard', popular: true, edits: true,
    run: (app) => { app.focus(); app.rememberClipboard(); if (!document.execCommand('cut')) { navigator.clipboard?.writeText(selectedText(app.state)); app.view.dispatch(app.state.tr.deleteSelection()); } },
    isEnabled: (app) => !app.state.selection.empty,
  },
  {
    id: 'edit.copy', label: 'Copy', icon: 'content_copy', tab: 'Home', group: 'Clipboard', popular: true,
    run: (app) => { app.focus(); app.rememberClipboard(); if (!document.execCommand('copy')) navigator.clipboard?.writeText(selectedText(app.state)); toast('Copied'); },
    isEnabled: (app) => !app.state.selection.empty,
  },
  {
    id: 'edit.paste', label: 'Paste', icon: 'content_paste', tab: 'Home', group: 'Clipboard', kind: 'split', popular: true, edits: true,
    run: (app, arg) => pasteWith(app, arg || app.prefs.pasteDefault),
    menu: () => [
      { id: 'edit.paste', arg: 'keep', label: 'Keep Source Formatting', icon: 'content_paste' },
      { id: 'edit.paste', arg: 'merge', label: 'Merge Formatting', icon: 'content_paste_go' },
      { id: 'edit.paste', arg: 'text', label: 'Keep Text Only', icon: 'content_paste_off' },
      { id: 'edit.paste', arg: 'markdown', label: 'Paste as Markdown', icon: 'markdown' },
      { separator: true },
      { id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_search' },
      { id: 'edit.clipboardPane', label: 'Clipboard History', icon: 'assignment' },
      { id: 'edit.setDefaultPaste', label: 'Set Default Paste…', icon: 'settings' },
    ],
  },
  { id: 'edit.pasteText', label: 'Paste as Plain Text', icon: 'content_paste_off', tab: 'Home', group: 'Clipboard', keys: ['Mod-Shift-v'], edits: true, run: (app) => pasteWith(app, 'text') },
  { id: 'edit.pasteMerge', label: 'Paste and Merge Formatting', icon: 'content_paste_go', tab: 'Home', group: 'Clipboard', edits: true, run: (app) => pasteWith(app, 'merge') },
  { id: 'edit.pasteMarkdown', label: 'Paste Markdown as Formatted Text', icon: 'markdown', tab: 'Home', group: 'Clipboard', edits: true, origin: 'Markdown editors', run: (app) => pasteWith(app, 'markdown') },
  {
    id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_search', tab: 'Home', group: 'Clipboard', keys: ['Mod-Alt-v'], edits: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Paste Special', fields: [{ key: 'as', label: 'As', type: 'list', rows: 6, value: 'keep', options: [
        { value: 'keep', label: 'Formatted Text (HTML)' }, { value: 'merge', label: 'Formatted Text, Merge Formatting' }, { value: 'text', label: 'Unformatted Text' },
        { value: 'markdown', label: 'Markdown → Formatted' }, { value: 'link', label: 'Hyperlink (clipboard URL)' }, { value: 'image', label: 'Picture (from clipboard)' },
      ] }] });
      if (!r) return;
      if (r.as === 'link') { const c = await readClipboard(); if (c?.text) app.exec('insert.link', { href: c.text.trim(), text: c.text.trim() }); return; }
      if (r.as === 'image') {
        try {
          const items = await (navigator as any).clipboard.read();
          for (const it of items) for (const t of it.types) if (t.startsWith('image/')) {
            const blob = await it.getType(t);
            const { readFileAsDataURL } = await import('../ui/dom');
            app.exec('insert.imageFromSrc', await readFileAsDataURL(blob));
            return;
          }
          toast('No picture on the clipboard.');
        } catch { toast('Clipboard access was denied.'); }
        return;
      }
      await pasteWith(app, r.as);
    },
  },
  {
    id: 'edit.setDefaultPaste', label: 'Set Default Paste…', icon: 'settings', tab: 'Home', group: 'Clipboard',
    run: async (app) => {
      const r = await openDialog({ title: 'Default Paste', fields: [{ key: 'm', label: 'When pasting with the Paste button', type: 'radio', options: [{ value: 'keep', label: 'Keep source formatting' }, { value: 'merge', label: 'Merge formatting' }, { value: 'text', label: 'Keep text only' }], value: app.prefs.pasteDefault }] });
      if (r) { app.prefs.pasteDefault = r.m; app.savePrefs(); }
    },
  },
  { id: 'edit.clipboardPane', label: 'Clipboard History', icon: 'assignment', tab: 'Home', group: 'Clipboard', origin: 'Office Clipboard / clipboard managers', run: (app) => app.ui.togglePane('clipboard') },
  {
    id: 'edit.spikeCut', label: 'Spike (Cut to Collection)', icon: 'playlist_add', tab: 'Home', group: 'Clipboard', keys: ['Mod-F3'], edits: true, origin: 'Classic word processor "Spike"',
    run: (app) => {
      const st = app.state;
      if (st.selection.empty) { toast('Select text to add to the Spike.'); return; }
      app.spike.push(st.selection.content().toJSON());
      app.view.dispatch(st.tr.deleteSelection());
      toast(`Spike holds ${app.spike.length} item(s)`);
    },
  },
  {
    id: 'edit.spikeInsert', label: 'Insert Spike Contents', icon: 'playlist_add_check', tab: 'Home', group: 'Clipboard', keys: ['Mod-Shift-F3'], edits: true,
    run: (app) => {
      if (!app.spike.length) { toast('The Spike is empty.'); return; }
      const nodes: PMNode[] = [];
      for (const j of app.spike) {
        const sl = Slice.fromJSON(schema, j);
        sl.content.forEach((n) => nodes.push(n.isInline ? N.paragraph.create(null, [n]) : n));
      }
      const tr = app.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0));
      app.view.dispatch(tr.scrollIntoView());
      app.spike = [];
    },
  },
]);

// Selection ---------------------------------------------------------------------------------
def([
  { id: 'edit.selectAll', label: 'Select All', icon: 'select_all', tab: 'Home', group: 'Editing', keys: ['Mod-a'], popular: true, run: (app) => selectAll(v(app)) },
  { id: 'edit.selectWord', label: 'Select Word', icon: 'text_select_start', tab: 'Home', group: 'Editing', run: (app) => { const w = wordAt(app.state.selection.$head); if (w) selectRange(v(app), w.from, w.to); } },
  { id: 'edit.selectSentence', label: 'Select Sentence', icon: 'text_select_end', tab: 'Home', group: 'Editing', run: (app) => { const s = sentenceAt(app.state.selection.$head); if (s) selectRange(v(app), s.from, s.to); } },
  { id: 'edit.selectParagraph', label: 'Select Paragraph', icon: 'format_paragraph', tab: 'Home', group: 'Editing', run: (app) => selectParagraph(v(app)) },
  {
    id: 'edit.selectLine', label: 'Select Line', icon: 'segment', tab: 'Home', group: 'Editing',
    run: (app) => {
      const view = v(app);
      const c = view.coordsAtPos(view.state.selection.head);
      const r = (view.dom as HTMLElement).getBoundingClientRect();
      const a = view.posAtCoords({ left: r.left + 2, top: (c.top + c.bottom) / 2 });
      const b = view.posAtCoords({ left: r.right - 2, top: (c.top + c.bottom) / 2 });
      if (a && b) selectRange(view, a.pos, b.pos);
    },
  },
  {
    id: 'edit.extendSelection', label: 'Extend Selection', icon: 'expand', tab: 'Home', group: 'Editing', keys: ['F8'], origin: 'Classic Extend mode (word → sentence → paragraph → document)',
    run: (app) => {
      const st = app.state;
      const sel = st.selection;
      const w = wordAt(sel.$from);
      const s = sentenceAt(sel.$from);
      const $f = sel.$from;
      if (sel.empty && w) return selectRange(v(app), w.from, w.to);
      if (s && (sel.from > s.from || sel.to < s.to)) return selectRange(v(app), s.from, s.to);
      if ($f.parent.isTextblock && (sel.from > $f.start() || sel.to < $f.end())) return selectRange(v(app), $f.start(), $f.end());
      selectAll(v(app));
    },
  },
  { id: 'edit.shrinkSelection', label: 'Shrink Selection', icon: 'compress', tab: 'Home', group: 'Editing', keys: ['Shift-F8'], run: (app) => { const s = app.state.selection; app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, s.head))); } },
  { id: 'edit.selectToStart', label: 'Select to Start of Document', icon: 'vertical_align_top', tab: 'Home', group: 'Editing', keys: ['Mod-Shift-Home'], run: (app) => selectRange(v(app), Selection.atStart(app.state.doc).from, app.state.selection.to) },
  { id: 'edit.selectToEnd', label: 'Select to End of Document', icon: 'vertical_align_bottom', tab: 'Home', group: 'Editing', keys: ['Mod-Shift-End'], run: (app) => selectRange(v(app), app.state.selection.from, Selection.atEnd(app.state.doc).to) },
  {
    id: 'edit.selectSimilar', label: 'Select Text with Similar Formatting', icon: 'select', tab: 'Home', group: 'Editing',
    run: async (app, arg) => {
      const style = arg?.style || currentParagraph(app.state)?.attrs.style || 'Normal';
      const find = (d: PMNode) => {
        const out: { from: number; to: number }[] = [];
        d.descendants((n, pos) => { if (n.type === N.paragraph && (n.attrs.style || 'Normal') === style) { out.push({ from: pos + 1, to: pos + n.nodeSize - 1 }); return false; } return true; });
        return out;
      };
      let ranges = find(app.state.doc);
      const r = await openDialog({ title: 'Select Similar Formatting', help: `${ranges.length} paragraph(s) use the style "${style}". Choose what to do with all of them:`, fields: [
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'style', label: 'Apply another style' }, { value: 'clear', label: 'Clear direct formatting' }, { value: 'highlight', label: 'Highlight them' }, { value: 'delete', label: 'Delete them' }, { value: 'copy', label: 'Copy their text to clipboard' }], value: 'style' },
        { key: 'style', label: 'Style', type: 'text', value: 'Normal', visibleIf: (x) => x.act === 'style' },
      ] });
      if (!r) return;
      // The paragraphs as they are now: the document may have changed while the dialog was open.
      const st = app.state;
      ranges = find(st.doc);
      const tr = st.tr;
      const sorted = [...ranges].sort((a, b) => b.from - a.from);
      for (const rg of sorted) {
        const node = tr.doc.nodeAt(rg.from - 1)!;
        if (r.act === 'style') tr.setNodeMarkup(rg.from - 1, undefined, { ...node.attrs, style: r.style });
        if (r.act === 'clear') { for (const m of Object.values(schema.marks)) if (!['link', 'comment', 'insertion', 'deletion'].includes(m.name)) tr.removeMark(rg.from, rg.to, m); }
        if (r.act === 'highlight') tr.addMark(rg.from, rg.to, schema.marks.highlight.create({ color: '#ffff00' }));
        if (r.act === 'delete') tr.delete(rg.from - 1, rg.to + 1);
      }
      if (r.act === 'copy') { await navigator.clipboard?.writeText(ranges.map((rg) => st.doc.textBetween(rg.from, rg.to)).join('\n')); toast('Copied'); return; }
      if (tr.doc.childCount === 0) tr.insert(0, N.paragraph.create());
      app.view.dispatch(tr);
    },
  },
  { id: 'edit.selectObjects', label: 'Select Objects (Selection Pane)', icon: 'category', tab: 'Home', group: 'Editing', run: (app) => app.ui.togglePane('selection') },
]);

// Editing ------------------------------------------------------------------------------------
def([
  {
    id: 'edit.deleteWordBack', label: 'Delete Previous Word', icon: 'backspace', tab: 'Home', group: 'Editing', edits: true,
    run: (app) => {
      const st = app.state; const $h = st.selection.$head;
      const before = $h.parent.textBetween(0, $h.parentOffset, '￼', '￼');
      const m = /(\S+\s*|\s+)$/.exec(before);
      if (m) app.view.dispatch(st.tr.delete($h.pos - m[0].length, $h.pos).setMeta('trackDir', 'back'));
    },
  },
  {
    id: 'edit.deleteWordFwd', label: 'Delete Next Word', icon: 'backspace', tab: 'Home', group: 'Editing', edits: true,
    run: (app) => {
      const st = app.state; const $h = st.selection.$head;
      const after = $h.parent.textBetween($h.parentOffset, $h.parent.content.size, '￼', '￼');
      const m = /^(\s*\S+|\s+)/.exec(after);
      if (m) app.view.dispatch(st.tr.delete($h.pos, $h.pos + m[0].length));
    },
  },
  { id: 'edit.deleteBlock', label: 'Delete Paragraph', icon: 'delete_sweep', tab: 'Home', group: 'Editing', keys: ['Mod-Shift-Backspace'], edits: true, run: (app) => deleteBlocks(v(app)) },
  { id: 'edit.duplicate', label: 'Duplicate Paragraph', icon: 'content_copy', tab: 'Home', group: 'Editing', keys: ['Mod-Shift-u'], edits: true, origin: 'Code editors', run: (app) => duplicateBlocks(v(app)) },
  { id: 'edit.moveUp', label: 'Move Paragraph Up', icon: 'arrow_upward', tab: 'Home', group: 'Editing', keys: ['Alt-Shift-ArrowUp'], edits: true, run: (app) => moveBlocks(v(app), -1) },
  { id: 'edit.moveDown', label: 'Move Paragraph Down', icon: 'arrow_downward', tab: 'Home', group: 'Editing', keys: ['Alt-Shift-ArrowDown'], edits: true, run: (app) => moveBlocks(v(app), 1) },
  {
    id: 'edit.transpose', label: 'Transpose Characters', icon: 'swap_horiz', tab: 'Home', group: 'Editing', edits: true, origin: 'Emacs / macOS text system',
    run: (app) => {
      const st = app.state; const $h = st.selection.$head;
      if ($h.parentOffset < 1 || $h.parentOffset >= $h.parent.content.size) return;
      const a = st.doc.textBetween($h.pos - 1, $h.pos), b = st.doc.textBetween($h.pos, $h.pos + 1);
      if (a.length !== 1 || b.length !== 1) return;
      app.view.dispatch(st.tr.insertText(b + a, $h.pos - 1, $h.pos + 1));
    },
  },
  {
    id: 'edit.transposeWords', label: 'Transpose Words', icon: 'swap_horiz', tab: 'Home', group: 'Editing', edits: true,
    run: (app) => {
      const st = app.state; const $h = st.selection.$head;
      const text = $h.parent.textBetween(0, $h.parent.content.size, '￼', '￼');
      const re = /[\p{L}\p{N}'’]+/gu; let m; const words: { s: number; e: number }[] = [];
      while ((m = re.exec(text))) words.push({ s: m.index, e: m.index + m[0].length });
      const i = words.findIndex((w) => w.e >= $h.parentOffset);
      if (i < 1) return;
      const a = words[i - 1], b = words[i]; const base = $h.start();
      const tr = st.tr;
      const ta = text.slice(a.s, a.e), tb = text.slice(b.s, b.e);
      tr.insertText(ta, base + b.s, base + b.e).insertText(tb, base + a.s, base + a.e);
      app.view.dispatch(tr);
    },
  },
  {
    id: 'edit.joinParagraphs', label: 'Join Paragraphs', icon: 'merge', tab: 'Home', group: 'Editing', edits: true,
    run: (app) => {
      const st = app.state;
      const { from, to } = topLevelRange(st);
      const blocks = textblocks(st.doc.cut(from, to)).filter((b) => b.node.type === N.paragraph);
      if (blocks.length < 2 && st.selection.empty) {
        const $h = st.selection.$head; const after = $h.after();
        const next = st.doc.resolve(after).nodeAfter;
        if (after < st.doc.content.size && next && next.type === N.paragraph && $h.parent.type === N.paragraph) { app.view.dispatch(st.tr.join(after).insertText(' ', after - 1)); }
        else toast('The next block is not a plain paragraph.');
        return;
      }
      const paras: PMNode[] = [];
      let nonPara = false;
      st.doc.nodesBetween(from, to, (n) => { if (n.type === N.paragraph) { paras.push(n); return false; } if (n.isBlock && n.type !== N.paragraph) nonPara = true; return false; });
      if (nonPara || paras.length < 2) { toast('Select two or more plain paragraphs to join.'); return; }
      const content: PMNode[] = [];
      paras.forEach((p, i) => { if (i) content.push(schema.text(' ')); p.content.forEach((c) => content.push(c)); });
      app.view.dispatch(st.tr.replaceWith(from, to, N.paragraph.create(paras[0].attrs, content)));
    },
  },
  { id: 'edit.lineBreak', label: 'Insert Line Break', icon: 'keyboard_return', tab: 'Insert', group: 'Text', keys: ['Shift-Enter'], edits: true, run: (app) => app.view.dispatch(app.state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView()) },
  { id: 'edit.typeText', label: 'Type Text', icon: 'keyboard', tab: 'Home', group: 'Editing', internal: true, edits: true, run: (app, text) => app.view.dispatch(app.state.tr.insertText(String(text ?? '')).scrollIntoView()) },
  {
    // Replays an editing key recorded in a macro (Enter, Backspace, Delete, Tab...) through the editor's keymaps.
    id: 'edit.key', label: 'Press Key', icon: 'keyboard', tab: 'Home', group: 'Editing', internal: true, edits: true, noRecord: true,
    run: (app, key: string) => {
      const parts = String(key || '').split('-');
      const base = parts.pop() || '';
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const has = (m: string) => parts.includes(m);
      const ev = new KeyboardEvent('keydown', { key: base, bubbles: true, cancelable: true, ctrlKey: has('Ctrl') || (has('Mod') && !mac), metaKey: has('Mod') && mac, altKey: has('Alt'), shiftKey: has('Shift') });
      const view = app.view;
      if (view.someProp('handleKeyDown', (f) => f(view, ev))) return true;
      // Deleting a character (or word) at a collapsed cursor is the browser's job, so it is done here.
      const st = view.state, $h = st.selection.$head, back = base === 'Backspace';
      if (!st.selection.empty || (!back && base !== 'Delete')) return false;
      if (has('Mod') || has('Alt')) return getCommand(back ? 'edit.deleteWordBack' : 'edit.deleteWordFwd')!.run(app);
      const off = $h.parentOffset;
      if (back ? off === 0 : off === $h.parent.content.size) return false;
      const near = back ? $h.parent.textBetween(Math.max(0, off - 2), off, undefined, '\ufffc') : $h.parent.textBetween(off, Math.min($h.parent.content.size, off + 2), undefined, '\ufffc');
      const n = (back ? /[\ud800-\udbff][\udc00-\udfff]$/ : /^[\ud800-\udbff][\udc00-\udfff]/).test(near) ? 2 : 1;
      view.dispatch(st.tr.delete(back ? $h.pos - n : $h.pos, back ? $h.pos : $h.pos + n).setMeta('trackDir', back ? 'back' : 'forward').scrollIntoView());
      return true;
    },
  },
  {
    id: 'edit.collapseSelection', label: 'Collapse Selection', icon: 'deselect', tab: 'Home', group: 'Editing', noRecord: true,
    run: (app) => app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, app.state.selection.head))),
  },
]);

// Find & replace ---------------------------------------------------------------------------
def([
  { id: 'edit.find', label: 'Find', icon: 'search', tab: 'Home', group: 'Editing', keys: ['Mod-f'], popular: true, noRecord: true, run: (app, arg) => app.ui.openPane('find', { query: arg ?? selectedText(app.state).slice(0, 200) }) },
  { id: 'edit.replace', label: 'Replace', icon: 'find_replace', tab: 'Home', group: 'Editing', keys: ['Mod-h'], popular: true, noRecord: true, run: (app) => app.ui.openPane('find', { replace: true, query: selectedText(app.state).slice(0, 200) }) },
  { id: 'edit.advancedFind', label: 'Advanced Find (Regex, Wildcards)', icon: 'manage_search', tab: 'Home', group: 'Editing', origin: 'LibreOffice regex search', run: (app) => app.ui.openPane('find', { replace: true, advanced: true }) },
  { id: 'edit.findNext', label: 'Find Next', icon: 'keyboard_arrow_down', tab: 'Home', group: 'Editing', keys: ['Mod-g'], noRecord: true, run: (app) => { const s = findKey.getState(app.state)!; if (!s.query) return app.exec('edit.find'); selectMatch(v(app), nextMatchIndex(app, 1)); } },
  { id: 'edit.findPrev', label: 'Find Previous', icon: 'keyboard_arrow_up', tab: 'Home', group: 'Editing', noRecord: true, run: (app) => { const s = findKey.getState(app.state)!; if (!s.query) return app.exec('edit.find'); selectMatch(v(app), nextMatchIndex(app, -1)); } },
  {
    id: 'edit.replaceAll', label: 'Replace All', icon: 'find_replace', tab: 'Home', group: 'Editing', edits: true,
    run: (app, arg: { find: string; replace: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; wildcards?: boolean; inSelection?: boolean; style?: string }) => {
      if (!arg?.find) return app.exec('edit.replace');
      return replaceAll(app, arg);
    },
  },
  { id: 'edit.clearFind', label: 'Clear Find Highlights', icon: 'search_off', tab: 'Home', group: 'Editing', noRecord: true, run: (app) => setFind(v(app), { query: '' }) },
  {
    id: 'edit.highlightAll', label: 'Highlight All Matches (Reading Highlight)', icon: 'highlight', tab: 'Home', group: 'Editing', edits: true,
    run: async (app) => {
      const q = await promptDialog('Highlight All', 'Text to highlight everywhere:', selectedText(app.state));
      if (!q) return;
      const ms = findMatches(app.state.doc, buildMatcher(q, false, false, false));
      const tr = app.state.tr;
      for (const m of ms) tr.addMark(m.from, m.to, schema.marks.highlight.create({ color: '#ffff00' }));
      app.view.dispatch(tr);
      toast(`${ms.length} match(es) highlighted`);
    },
  },
]);

function nextMatchIndex(app: App, dir: 1 | -1): number {
  const s = findKey.getState(app.state)!;
  const pos = app.state.selection.from;
  if (!s.matches.length) return -1;
  if (dir > 0) { const i = s.matches.findIndex((m) => m.from > pos); return i < 0 ? 0 : i; }
  for (let i = s.matches.length - 1; i >= 0; i--) if (s.matches[i].from < pos) return i;
  return s.matches.length - 1;
}

export function replaceAll(app: App, o: { find: string; replace: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; wildcards?: boolean; inSelection?: boolean; style?: string; preserveCase?: boolean; quiet?: boolean }): number {
  const st = app.state;
  const re = buildMatcher(o.find, !!o.regex, !!o.caseSensitive, !!o.wholeWord, !!o.wildcards);
  if (!re) { toast('Invalid search expression.'); return 0; }
  let matches = findMatches(st.doc, re);
  if (o.inSelection && !st.selection.empty) matches = matches.filter((m) => m.from >= st.selection.from && m.to <= st.selection.to);
  const tr = st.tr;
  // Block text built exactly like findMatches (one char per position) so regex replacements
  // see the same context (lookaround, \b, ^) the search did.
  const blocks = new Map<number, { start: number; text: string; posMap: number[] }>();
  const blockText = (pos: number) => {
    const $p = st.doc.resolve(pos);
    const start = $p.start();
    let b = blocks.get(start);
    if (!b) {
      let text = '';
      const posMap: number[] = [];
      $p.parent.forEach((child, off) => {
        if (child.isText) { for (let k = 0; k < child.text!.length; k++) posMap.push(start + off + k); text += child.text; }
        else { posMap.push(start + off); text += child.type === N.hard_break ? '\n' : '￼'; }
      });
      b = { start, text, posMap };
      blocks.set(start, b);
    }
    return b;
  };
  const sticky = (o.regex || o.wildcards) ? new RegExp(re.source, re.flags.replace('g', '') + 'y') : null;
  const tmpl = o.replace.replace(/\\(\d)/g, '$$$1');
  let skipped = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const b = blockText(m.from);
    const idx = b.posMap[m.from - b.start] === m.from ? m.from - b.start : b.posMap.indexOf(m.from);
    const text = idx < 0 ? '' : b.text.slice(idx, idx + (m.to - m.from));
    // Matches spanning pictures, fields or other inline objects would destroy them; leave those alone.
    if (idx < 0 || text.includes('￼')) { matches.splice(i, 1); skipped++; continue; }
    let rep = o.replace.replace(/\^p/g, '\n').replace(/\^t/g, '\t').replace(/\^&/g, () => text);
    if (sticky) {
      sticky.lastIndex = idx;
      const mm = sticky.exec(b.text);
      if (!mm || mm[0].length !== text.length) { matches.splice(i, 1); skipped++; continue; }
      sticky.lastIndex = idx;
      const out = b.text.replace(sticky, tmpl);
      rep = out.slice(idx, out.length - (b.text.length - idx - text.length));
    }
    if (o.preserveCase) {
      if (text === text.toUpperCase()) rep = rep.toUpperCase();
      else if (text[0] === text[0].toUpperCase()) rep = rep.charAt(0).toUpperCase() + rep.slice(1);
    }
    const marks = st.doc.resolve(m.from + 1 <= m.to ? m.from + 1 : m.from).marks();
    const parts = rep.split('\n');
    if (parts.length === 1) {
      if (rep) tr.replaceWith(m.from, m.to, schema.text(rep, marks)); else tr.delete(m.from, m.to);
    } else if (sticky) {
      // In regex/wildcard mode a newline can only come from matched line breaks: keep them as line breaks.
      tr.replaceWith(m.from, m.to, parts.flatMap((part, j) => [...(j ? [N.hard_break.create()] : []), ...(part ? [schema.text(part, marks)] : [])]));
    } else {
      tr.delete(m.from, m.to);
      let p = m.from;
      parts.forEach((part, j) => {
        if (j > 0) { tr.split(p); p += 2; }
        if (part) { tr.insert(p, schema.text(part, marks)); p += part.length; }
      });
    }
    if (o.style) {
      const $p = tr.doc.resolve(tr.mapping.map(m.from));
      if ($p.parent.type === N.paragraph) tr.setNodeMarkup($p.before(), undefined, { ...$p.parent.attrs, style: o.style });
    }
  }
  if (matches.length) app.view.dispatch(tr);
  if (!o.quiet || skipped) toast(`${matches.length} replacement(s) made` + (skipped ? `; ${skipped} skipped (match spans a picture or other object)` : ''));
  return matches.length;
}

// Navigation ---------------------------------------------------------------------------------
function collectTargets(app: App, kind: string): { pos: number; label: string }[] {
  const st = app.state;
  const out: { pos: number; label: string }[] = [];
  st.doc.descendants((n, pos) => {
    switch (kind) {
      case 'heading': if (n.type === N.paragraph && styleLevel(n.attrs.style, n.attrs.outlineLevel)) out.push({ pos, label: n.textContent }); break;
      case 'bookmark': if (n.type === N.bookmark) out.push({ pos, label: n.attrs.name }); break;
      case 'table': if (n.type === N.table) out.push({ pos, label: `Table (${n.childCount} rows)` }); break;
      case 'image': if (n.type === N.image) out.push({ pos, label: n.attrs.alt || 'Picture' }); break;
      case 'footnote': if (n.type === N.footnote) out.push({ pos, label: n.attrs.text.slice(0, 60) }); break;
      case 'field': if (n.type === N.field) out.push({ pos, label: `${n.attrs.type} ${n.attrs.arg || ''}` }); break;
      case 'equation': if (n.type === N.math_inline || n.type === N.math_block) out.push({ pos, label: n.attrs.latex }); break;
      case 'section': if (n.type === N.section_break) out.push({ pos, label: 'Section break' }); break;
      case 'comment': if (n.isText) { const m = n.marks.find((x) => x.type === schema.marks.comment); if (m && !out.some((o) => o.label === m.attrs.id)) out.push({ pos, label: m.attrs.id }); } break;
      case 'citation': if (n.type === N.citation) out.push({ pos, label: n.attrs.cache }); break;
      case 'control': if (n.type === N.control) out.push({ pos, label: n.attrs.label || n.attrs.kind }); break;
    }
    return true;
  });
  return out;
}

function gotoRelative(app: App, kind: string, dir: 1 | -1) {
  const pos = app.state.selection.from;
  const list = kind === 'change' ? listChanges(app.state.doc).map((c) => ({ pos: c.from, label: c.text })) : collectTargets(app, kind);
  if (!list.length) { toast(`No ${kind}s in the document.`); return; }
  const t = dir > 0 ? list.find((x) => x.pos > pos) || list[0] : [...list].reverse().find((x) => x.pos < pos) || list[list.length - 1];
  app.selectPos(t.pos + (kind === 'heading' ? 1 : 0));
}

const GOTO_KINDS = ['page', 'line', 'heading', 'bookmark', 'comment', 'footnote', 'table', 'image', 'field', 'equation', 'section', 'citation', 'control', 'change'];
def([
  {
    id: 'nav.goto', label: 'Go To…', icon: 'move_down', tab: 'Home', group: 'Editing', keys: ['Mod-Alt-g', 'F5'], noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Go To', fields: [
        { key: 'kind', label: 'Go to what', type: 'list', rows: 8, options: GOTO_KINDS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })), value: 'page' },
        { key: 'target', label: 'Number, name, or +/- offset (blank = next)', type: 'text', value: '' },
      ] });
      if (!r) return;
      const t = String(r.target || '').trim();
      if (r.kind === 'page') {
        const info = pageInfo(app.state);
        let n = parseInt(t, 10);
        if (/^[+-]/.test(t)) { const cur = info.starts.filter((s) => s <= app.state.selection.from).length; n = cur + parseInt(t, 10); }
        if (!n) n = 1;
        if (app.tab.viewMode !== 'print') toast('Page navigation is exact in Print Layout.');
        app.selectPos((info.starts[Math.max(0, Math.min(info.pages, n) - 1)] || 0) + 1);
        return;
      }
      if (r.kind === 'line') {
        const n = Math.max(1, parseInt(t, 10) || 1);
        const blocks = textblocks(app.state.doc);
        app.selectPos((blocks[Math.min(blocks.length, n) - 1]?.pos ?? 0) + 1);
        return;
      }
      if (!t) return gotoRelative(app, r.kind, 1);
      if (/^[+-]\d+$/.test(t)) { const k = parseInt(t, 10); for (let i = 0; i < Math.abs(k); i++) gotoRelative(app, r.kind, k > 0 ? 1 : -1); return; }
      const list = collectTargets(app, r.kind);
      const n = parseInt(t, 10);
      const hit = !isNaN(n) && String(n) === t ? list[n - 1] : list.find((x) => x.label.toLowerCase().includes(t.toLowerCase()));
      if (hit) app.selectPos(hit.pos + 1); else toast('Not found.');
    },
  },
  { id: 'nav.nextHeading', label: 'Next Heading', icon: 'south', tab: 'View', group: 'Navigate', keys: ['Mod-Alt-ArrowDown'], noRecord: true, run: (app) => gotoRelative(app, 'heading', 1) },
  { id: 'nav.prevHeading', label: 'Previous Heading', icon: 'north', tab: 'View', group: 'Navigate', keys: ['Mod-Alt-ArrowUp'], noRecord: true, run: (app) => gotoRelative(app, 'heading', -1) },
  { id: 'nav.nextTable', label: 'Next Table', icon: 'table', tab: 'View', group: 'Navigate', noRecord: true, run: (app) => gotoRelative(app, 'table', 1) },
  { id: 'nav.nextImage', label: 'Next Picture', icon: 'image', tab: 'View', group: 'Navigate', noRecord: true, run: (app) => gotoRelative(app, 'image', 1) },
  { id: 'nav.nextFootnote', label: 'Next Footnote', icon: 'notes', tab: 'References', group: 'Footnotes', noRecord: true, run: (app) => gotoRelative(app, 'footnote', 1) },
  { id: 'nav.prevFootnote', label: 'Previous Footnote', icon: 'notes', tab: 'References', group: 'Footnotes', noRecord: true, run: (app) => gotoRelative(app, 'footnote', -1) },
  { id: 'nav.nextField', label: 'Next Field', icon: 'data_object', tab: 'Insert', group: 'Text', keys: ['F11'], noRecord: true, run: (app) => gotoRelative(app, 'field', 1) },
  { id: 'nav.prevField', label: 'Previous Field', icon: 'data_object', tab: 'Insert', group: 'Text', keys: ['Shift-F11'], noRecord: true, run: (app) => gotoRelative(app, 'field', -1) },
  { id: 'nav.nextBookmark', label: 'Next Bookmark', icon: 'bookmark', tab: 'Insert', group: 'Links', noRecord: true, run: (app) => gotoRelative(app, 'bookmark', 1) },
  { id: 'nav.nextControl', label: 'Next Form Field', icon: 'check_box', tab: 'Developer', group: 'Controls', noRecord: true, run: (app) => gotoRelative(app, 'control', 1) },
  { id: 'nav.docStart', label: 'Go to Start of Document', icon: 'first_page', tab: 'View', group: 'Navigate', noRecord: true, run: (app) => app.selectPos(0) },
  { id: 'nav.docEnd', label: 'Go to End of Document', icon: 'last_page', tab: 'View', group: 'Navigate', noRecord: true, run: (app) => app.selectPos(app.state.doc.content.size) },
  {
    id: 'nav.goBack', label: 'Go Back (Previous Edit Location)', icon: 'history', tab: 'View', group: 'Navigate', keys: ['Shift-F5'], noRecord: true, origin: 'Return to last edit point',
    run: (app) => {
      const st = app.state;
      const last = app.editPositions;
      if (!last || !last.length) { toast('No previous edit location.'); return; }
      const p = last.pop()!;
      app.selectPos(Math.min(p, st.doc.content.size));
    },
  },
  {
    id: 'nav.gotoAnchor', label: 'Go to Anchor', icon: 'anchor', tab: 'View', group: 'Navigate', internal: true, noRecord: true,
    run: (app, id: string) => {
      const name = decodeURIComponent(id).replace(/^bm-/, '');
      let target = -1;
      app.state.doc.descendants((n, pos) => {
        if (target >= 0) return false;
        if (n.type === N.bookmark && n.attrs.name === name) target = pos;
        if (n.type === N.paragraph && n.attrs.id === name) target = pos + 1;
        return true;
      });
      if (target < 0) {
        // headings by slug
        app.state.doc.descendants((n, pos) => { if (target < 0 && n.type === N.paragraph && slug(n.textContent) === name) target = pos + 1; return target < 0; });
      }
      if (target >= 0) app.selectPos(target); else toast(`Anchor "${name}" not found.`);
    },
  },
  {
    id: 'nav.selectNode', label: 'Select Object at Cursor', icon: 'highlight_alt', tab: 'Home', group: 'Editing', internal: true, noRecord: true,
    run: (app, pos: number) => app.view.dispatch(app.state.tr.setSelection(NodeSelection.create(app.state.doc, pos)).scrollIntoView()),
  },
]);

export function slug(t: string): string {
  return t.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}
