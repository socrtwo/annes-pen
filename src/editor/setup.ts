/** Assemble ProseMirror plugins for a document tab. */
import { Plugin, PluginKey, TextSelection, type Command as PMCommand, type EditorState } from 'prosemirror-state';
import { keymap, keydownHandler } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap, chainCommands, exitCode, newlineInCode, createParagraphNear, liftEmptyBlock, splitBlockAs, deleteSelection, joinBackward, selectNodeBackward, joinForward, selectNodeForward } from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing, goToNextCell, fixTables, addRowAfter, isInTable } from 'prosemirror-tables';
import { Fragment } from 'prosemirror-model';
import { schema, PARA_DEFAULTS } from './schema';
import { buildInputRules, autocorrectPlugin, type AutoFormatPrefs } from './autoformat';
import { trackPlugin } from './plugins/trackChanges';
import { paginationPlugin, type PageConfig } from './plugins/pagination';
import { decoPlugins, completeKey } from './plugins/decorations';
import { resolveStyles } from './styles';
import { normalizeSettings } from './settings';

const S = schema;

export interface SetupHooks {
  autoformat: () => AutoFormatPrefs;
  replacements: () => Record<string, string>;
  pageConfig: () => PageConfig;
  /** Dynamic user/command key bindings, resolved per key press. */
  commandKey: (key: string) => boolean;
  author: () => string;
  wordCompletion: () => boolean;
  onAutocorrect?: (from: string, to: string) => void;
  slashMenu: (view: import('prosemirror-view').EditorView) => void;
  slashEnabled: () => boolean;
}

function withMeta(cmd: PMCommand, key: string, value: any): PMCommand {
  return (state, dispatch, view) => cmd(state, dispatch ? (tr) => dispatch(tr.setMeta(key, value)) : undefined, view);
}

/** Enter: split paragraph using the style's "next" style when at the end; keep inline formatting. */
const splitParagraph: PMCommand = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type !== S.nodes.paragraph) return false;
  const map = resolveStyles(normalizeSettings(state.doc.attrs.settings));
  const style = $from.parent.attrs.style || 'Normal';
  const marks = state.storedMarks || $from.marks();
  const keepMarks = marks.filter((m) => !['link', 'comment', 'insertion', 'deletion', 'formatChange'].includes(m.type.name));
  const ok = splitBlockAs((node, atEnd) => {
    if (node.type !== S.nodes.paragraph) return null;
    const def = map[style];
    if (atEnd && def?.next && def.next !== style) return { type: S.nodes.paragraph, attrs: { ...PARA_DEFAULTS, style: def.next } };
    return { type: S.nodes.paragraph, attrs: { ...node.attrs, id: null, pageBreakBefore: false, dropCap: 0 } };
  })(state, dispatch && ((tr) => {
    if (keepMarks.length && !(map[style]?.next && $from.parentOffset === $from.parent.content.size)) tr.ensureMarks(keepMarks);
    dispatch(tr.scrollIntoView());
  }));
  return ok;
};

/** Typing ---, ***, ___, ===, ~~~ or ### then Enter draws a border line (AutoFormat). */
function borderLineOnEnter(prefs: () => AutoFormatPrefs): PMCommand {
  return (state, dispatch) => {
    if (!prefs().borderLines) return false;
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type !== S.nodes.paragraph) return false;
    const t = $from.parent.textContent;
    const map: Record<string, string> = { '---': 'solid', '***': 'dotted', '___': 'thick', '===': 'double', '~~~': 'wavy', '###': 'triple' };
    if (!(t in map) || $from.parentOffset !== t.length) return false;
    const style = map[t];
    const start = $from.before(), end = $from.after();
    const hr = S.nodes.horizontal_rule.create({ style: style === 'thick' ? 'solid' : style === 'triple' ? 'double' : style, weight: style === 'thick' ? 3 : style === 'double' || style === 'triple' ? 3 : 1 });
    const content = Fragment.from([hr, S.nodes.paragraph.create()]);
    // Only where a rule can replace the paragraph as is (not as the first paragraph of a list item).
    if (!$from.node(-1).canReplace($from.index(-1), $from.index(-1) + 1, content)) return false;
    if (dispatch) {
      const tr = state.tr.replaceWith(start, end, content);
      tr.setSelection(TextSelection.near(tr.doc.resolve(start + hr.nodeSize + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

const insertTab: PMCommand = (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code) {
    if (dispatch) dispatch(state.tr.insertText('  '));
    return true;
  }
  if (dispatch) dispatch(state.tr.insertText('\t'));
  return true;
};

const outdentPara: PMCommand = (state, dispatch) => {
  const $f = state.selection.$from;
  if ($f.parent.type !== S.nodes.paragraph) return false;
  const left = $f.parent.attrs.indentLeft || 0;
  if (!left) return false;
  if (dispatch) dispatch(state.tr.setNodeMarkup($f.before(), undefined, { ...$f.parent.attrs, indentLeft: Math.max(0, left - 36) || null }));
  return true;
};

/** Toggle a task item's check box with Mod-Enter. */
const toggleTask: PMCommand = (state, dispatch) => {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) {
    const n = $f.node(d);
    if (n.type === S.nodes.task_item) {
      if (dispatch) dispatch(state.tr.setNodeMarkup($f.before(d), undefined, { checked: !n.attrs.checked }));
      return true;
    }
  }
  return false;
};

export const slashKey = new PluginKey('slash');

export function buildPlugins(hooks: SetupHooks): Plugin[] {
  const backspace = chainCommands(deleteSelection, joinBackward, selectNodeBackward);
  const del = chainCommands(deleteSelection, joinForward, selectNodeForward);
  const enter = chainCommands(newlineInCode, borderLineOnEnter(hooks.autoformat), splitListItem(S.nodes.list_item), splitListItem(S.nodes.task_item), createParagraphNear, liftEmptyBlock, splitParagraph);

  const coreKeys: Record<string, PMCommand> = {
    Enter: enter,
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(S.nodes.hard_break.create()).scrollIntoView()); return true; }),
    'Mod-Enter': chainCommands(toggleTask, (state, dispatch) => {
      if (dispatch) {
        const { $from } = state.selection;
        const tr = state.tr;
        const pos = $from.depth >= 1 ? $from.after(1) : $from.pos;
        tr.insert(pos, [S.nodes.page_break.create(), S.nodes.paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }),
    Backspace: withMeta(backspace, 'trackDir', 'back'),
    'Mod-Backspace': withMeta(backspace, 'trackDir', 'back'),
    Delete: withMeta(del, 'trackDir', 'forward'),
    'Mod-Delete': withMeta(del, 'trackDir', 'forward'),
    Tab: chainCommands(goToNextCell(1), (state, dispatch, view) => {
      if (!isInTable(state)) return false;
      if (!dispatch || !view) return true;
      addRowAfter(state, dispatch);
      return goToNextCell(1)(view.state, view.dispatch);
    }, sinkListItem(S.nodes.list_item), sinkListItem(S.nodes.task_item), insertTab),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(S.nodes.list_item), liftListItem(S.nodes.task_item), outdentPara),
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
  };

  // Slash menu trigger: "/" at the start of an empty paragraph.
  const slash = new Plugin({
    key: slashKey,
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '/' || !hooks.slashEnabled()) return false;
        const $f = view.state.doc.resolve(from);
        if ($f.parent.type !== S.nodes.paragraph || $f.parent.content.size !== 0) return false;
        setTimeout(() => hooks.slashMenu(view), 0);
        return false;
      },
    },
  });

  // Commands registered with key bindings (user-customizable) take precedence over defaults.
  const commandKeys = new Plugin({
    props: {
      handleKeyDown(view, event) {
        const name = keyName(event);
        if (!name) return false;
        return hooks.commandKey(name);
      },
    },
  });

  const tableFix = new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      return fixTables(state) || null;
    },
  });

  const decos = decoPlugins({ wordCompletion: hooks.wordCompletion });
  // Word completion accepts with Tab/Enter, so it must see keys before the keymaps (it passes
  // every key through when no suggestion is showing).
  const completion = decos.filter((p) => p.spec.key === completeKey);

  return [
    commandKeys,
    ...completion,
    buildInputRules(hooks.autoformat),
    autocorrectPlugin(hooks.autoformat, hooks.replacements, hooks.onAutocorrect),
    slash,
    keymap(coreKeys),
    keymap(baseKeymap),
    history({ depth: 500, newGroupDelay: 600 }),
    dropCursor({ color: '#2b579a', width: 2 }),
    gapCursor(),
    columnResizing({ cellMinWidth: 24 }),
    tableEditing(),
    tableFix,
    trackPlugin({ author: hooks.author(), getAuthor: hooks.author }),
    paginationPlugin(hooks.pageConfig),
    ...decos.filter((p) => !completion.includes(p)),
  ];
}

/** Normalize a keyboard event to ProseMirror key-name syntax, e.g. "Mod-Shift-b". */
export function keyName(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let base = e.key;
  if (base === ' ') base = 'Space';
  if (base.length === 1) base = base.toLowerCase();
  // Use the physical key for Shift+digit/symbol combinations so bindings stay layout-stable.
  if (e.shiftKey && e.code && /^Digit\d$/.test(e.code)) base = e.code.slice(5);
  if (e.code === 'Period') base = '.';
  if (e.code === 'Comma') base = ',';
  if (e.code === 'Equal') base = '=';
  if (e.code === 'Minus') base = '-';
  const mac = isMac();
  // AltGr (reported as Ctrl+Alt on Windows) and macOS Option type characters such as \ ] } @ ≠:
  // when the key produced something other than its layout-stable base, it is text, not a shortcut.
  const ch = e.key;
  const altGr = !!e.getModifierState?.('AltGraph') || (!e.shiftKey && !e.metaKey && e.altKey && (mac ? !e.ctrlKey : e.ctrlKey));
  if (altGr && ch.length === 1 && ch !== ' ' && ch !== base) return null;
  const parts: string[] = [];
  // On macOS Cmd is Mod and Ctrl stays a separate modifier (Ctrl+A/E/K are native line-editing keys).
  if (e.metaKey && mac) parts.push('Mod');
  if (e.ctrlKey) parts.push(mac ? 'Ctrl' : 'Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(base);
  // Canonical order used by bindings: Mod-Alt-Shift-key
  return parts.join('-');
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function canonicalKey(k: string): string {
  const parts = k.split('-');
  const base = parts.pop()!;
  // Ctrl means Mod everywhere except macOS, where it is its own modifier.
  const mac = isMac();
  const mods = new Set(parts.map((p) => (p === 'Cmd' || p === 'Meta' || (p === 'Ctrl' && !mac) ? 'Mod' : p)));
  const out: string[] = [];
  for (const m of ['Mod', 'Ctrl', 'Alt', 'Shift']) if (mods.has(m)) out.push(m);
  out.push(base.length === 1 ? base.toLowerCase() : base);
  return out.join('-');
}

export function prettyKey(k: string): string {
  const mac = isMac();
  return k.split('-').map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl') : p === 'Ctrl' && mac ? '⌃' : p === 'Alt' ? (mac ? '⌥' : 'Alt') : p === 'Shift' ? (mac ? '⇧' : 'Shift') : p.length === 1 ? p.toUpperCase() : p)).join(mac ? '' : '+');
}

export { keydownHandler };
export type { EditorState };
