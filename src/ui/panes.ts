/** Side panes (task panes). On phones they appear as bottom sheets. */
import type { App } from '../app';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { TextSelection, NodeSelection } from 'prosemirror-state';
import { h, icon, clear, esc } from './dom';
import { toast, openDialog, confirmDialog } from './dialog';
import { schema, styleLevel } from '../editor/schema';
import { allStyles, resolveStyles, effectiveStyle, fontStack } from '../editor/styles';
import { setFind, selectMatch, findKey, proofKey } from '../editor/plugins/decorations';
import { listChanges, resolveChanges } from '../editor/plugins/trackChanges';
import { pageOfPos, pageInfo, pageKey } from '../editor/plugins/pagination';
import { replaceAll } from '../commands/edit';
import { commentRanges, updateComment, refuseIfProtected } from '../commands/review';
import { currentParagraph, setParagraphStyle } from '../editor/ops';
import { modifyStyle } from '../commands/format';
import { kvKeys, kvGet, kvDel } from '../util/store';
import { compareDocs } from '../editor/compare';
import { suggest, addWord } from '../proof/proofing';
import { aiPaneDef } from './aiPane';

export interface PaneDef {
  id: string;
  title: string;
  render: (app: App, el: HTMLElement, opts: any) => void;
  update?: (app: App, el: HTMLElement, opts: any) => void;
  onOpen?: (app: App, el: HTMLElement, opts: any) => void;
  onClose?: (app: App) => void;
}

const N = schema.nodes;
const M = schema.marks;

/** True while the user is typing in a text field of the pane: redrawing it then would destroy the field
 *  (on phones the on-screen keyboard resizes the window, which refreshes every pane). */
const typingIn = (el: HTMLElement) => { const a = document.activeElement as HTMLElement | null; return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };

function headings(doc: PMNode) {
  const out: { level: number; text: string; pos: number }[] = [];
  doc.forEach((n, pos) => { if (n.type === N.paragraph) { const l = styleLevel(n.attrs.style, n.attrs.outlineLevel); if (l && n.textContent.trim()) out.push({ level: l, text: n.textContent, pos }); } });
  return out;
}

// ------------------------------------------------------------------------------------------
const navigation: PaneDef = {
  id: 'navigation', title: 'Navigation',
  render(app, el) {
    const search = h('input', { class: 'qf-pane-search', placeholder: 'Search document', 'aria-label': 'Search document' }) as HTMLInputElement;
    const tabs = h('div', { class: 'qf-seg' });
    const list = h('div', { class: 'qf-nav-list' });
    let mode: 'headings' | 'pages' | 'results' = 'headings';
    const setMode = (m: typeof mode) => { mode = m; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('qf-on', b.dataset.m === m)); draw(); };
    for (const [m, l] of [['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']] as const) tabs.appendChild(h('button', { 'data-m': m, class: m === mode ? 'qf-on' : '', onclick: () => setMode(m) }, l));
    search.addEventListener('input', () => { setFind(app.view, { query: search.value, current: -1 }); setMode(search.value ? 'results' : 'headings'); });
    const draw = () => {
      clear(list);
      const st = app.state;
      if (mode === 'headings') {
        const hs = headings(st.doc);
        if (!hs.length) list.appendChild(h('p', { class: 'qf-help' }, 'Apply heading styles (Home ▸ Styles) to build an outline you can navigate and reorganize.'));
        const curIdx = st.selection.$from.index(0);
        let curHead = -1;
        hs.forEach((x, i) => { if (st.doc.resolve(x.pos).index(0) <= curIdx) curHead = i; });
        hs.forEach((x, i) => {
          const row = h('div', { class: 'qf-nav-item' + (i === curHead ? ' qf-on' : ''), style: `padding-left:${(x.level - 1) * 14 + 6}px`, draggable: 'true' },
            h('span', { class: 'qf-nav-text', onclick: () => app.selectPos(x.pos + 1) }, x.text),
            h('span', { class: 'qf-nav-acts' },
              h('button', { class: 'qf-iconbtn qf-sm', title: 'Move up', onclick: () => { app.selectPos(x.pos + 1); app.exec('outline.moveUp'); } }, icon('arrow_upward')),
              h('button', { class: 'qf-iconbtn qf-sm', title: 'Move down', onclick: () => { app.selectPos(x.pos + 1); app.exec('outline.moveDown'); } }, icon('arrow_downward')),
              h('button', { class: 'qf-iconbtn qf-sm', title: 'Promote', onclick: () => { app.selectPos(x.pos + 1); app.exec('outline.promote'); } }, icon('chevron_left')),
              h('button', { class: 'qf-iconbtn qf-sm', title: 'Demote', onclick: () => { app.selectPos(x.pos + 1); app.exec('outline.demote'); } }, icon('chevron_right'))));
          list.appendChild(row);
        });
      } else if (mode === 'pages') {
        const info = pageInfo(st);
        if (app.tab.viewMode !== 'print') list.appendChild(h('p', { class: 'qf-help' }, 'Switch to Print Layout to see pages.'));
        info.starts.forEach((pos, i) => {
          const text = st.doc.textBetween(Math.min(pos, st.doc.content.size), Math.min(st.doc.content.size, pos + 120), ' ', ' ');
          list.appendChild(h('div', { class: 'qf-nav-page', onclick: () => app.selectPos(pos + 1) }, h('b', null, `Page ${i + 1}`), h('div', { class: 'qf-help' }, text.slice(0, 100) || '(blank)')));
        });
      } else {
        const fs = findKey.getState(st)!;
        list.appendChild(h('p', { class: 'qf-help' }, `${fs.matches.length} result(s)`));
        fs.matches.slice(0, 300).forEach((m, i) => {
          const $p = st.doc.resolve(m.from);
          const t = $p.parent.textContent;
          const off = m.from - $p.start();
          const snippet = h('div', { class: 'qf-nav-result' + (i === fs.current ? ' qf-on' : ''), onclick: () => selectMatch(app.view, i) }, t.slice(Math.max(0, off - 30), off), h('mark', null, t.slice(off, off + (m.to - m.from))), t.slice(off + (m.to - m.from), off + (m.to - m.from) + 40));
          list.appendChild(snippet);
        });
      }
    };
    (el as any)._draw = draw;
    el.append(search, tabs, list);
    draw();
  },
  update(app, el) {
    // Redraw only when something the list shows changed: the document, the heading the
    // selection is in, find results, pagination or the view mode.
    const st = app.state;
    const key = [st.doc, st.selection.$from.index(0), findKey.getState(st), pageKey.getState(st)?.info, app.tab.viewMode];
    const prev = (el as any)._navKey as unknown[] | undefined;
    if (prev && prev.length === key.length && prev.every((x, i) => x === key[i])) return;
    (el as any)._navKey = key;
    (el as any)._draw?.();
  },
  onClose(app) { setFind(app.view, { query: '' }); },
};

// ------------------------------------------------------------------------------------------
const styles: PaneDef = {
  id: 'styles', title: 'Styles',
  render(app, el) {
    const filter = h('select', { class: 'qf-pane-select', 'aria-label': 'Show' }, h('option', { value: 'recommended' }, 'Recommended'), h('option', { value: 'paragraph' }, 'Paragraph styles'), h('option', { value: 'character' }, 'Character styles'), h('option', { value: 'table' }, 'Table styles'), h('option', { value: 'all' }, 'All styles')) as HTMLSelectElement;
    const preview = h('label', { class: 'qf-check' }, h('input', { type: 'checkbox', checked: true }), ' Show preview');
    const list = h('div', { class: 'qf-style-list' });
    const draw = () => {
      clear(list);
      const s = app.settings;
      const map = resolveStyles(s);
      const cur = currentParagraph(app.state)?.attrs.style || 'Normal';
      const showPrev = (preview.querySelector('input') as HTMLInputElement).checked;
      let items = allStyles(s);
      if (filter.value === 'recommended') items = items.filter((x) => x.quick || x.name === cur);
      else if (filter.value !== 'all') items = items.filter((x) => x.type === filter.value || (filter.value === 'paragraph' && x.type === 'linked'));
      for (const st of items.sort((a, b) => (a.quick === b.quick ? a.name.localeCompare(b.name) : a.quick ? -1 : 1))) {
        const e = effectiveStyle(map, st.name);
        const css = showPrev ? `font-family:${fontStack(e.font || '+body', s)};font-weight:${e.bold ? 700 : 400};font-style:${e.italic ? 'italic' : 'normal'};${e.color && !String(e.color).startsWith('var') ? 'color:' + e.color : ''};font-size:${Math.min(20, Math.max(11, (e.size || 11) * 1.05))}px` : '';
        const row = h('div', { class: 'qf-style-row' + (st.name === cur ? ' qf-on' : '') },
          h('button', { class: 'qf-style-name', style: css, onclick: () => { if (st.type === 'table') app.exec('table.style', st.name); else setParagraphStyle(app.view, st.name); app.focus(); } }, st.name),
          h('span', { class: 'qf-style-kind', title: st.type }, st.type === 'character' ? 'a' : st.type === 'table' ? '⊞' : '¶'),
          h('button', { class: 'qf-iconbtn qf-sm', title: 'Modify', onclick: () => modifyStyle(app, st.name) }, icon('edit')));
        list.appendChild(row);
      }
    };
    filter.addEventListener('change', draw);
    preview.addEventListener('change', draw);
    const actions = h('div', { class: 'qf-pane-actions' },
      h('button', { class: 'qf-btn', onclick: () => app.exec('style.create') }, icon('add'), ' New Style'),
      h('button', { class: 'qf-btn', onclick: () => app.exec('style.inspector') }, icon('frame_inspect'), ' Inspector'),
      h('button', { class: 'qf-btn', onclick: () => app.exec('style.manage') }, icon('settings'), ' Manage'));
    (el as any)._draw = draw;
    el.append(h('div', { class: 'qf-row' }, filter, preview), list, actions);
    draw();
  },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
function describeMarks(marks: readonly Mark[]): string[] {
  return marks.map((m) => {
    switch (m.type.name) {
      case 'font': return `Font: ${m.attrs.family}`;
      case 'size': return `Size: ${m.attrs.pt} pt`;
      case 'color': return `Color: ${m.attrs.color}`;
      case 'highlight': return `Highlight: ${m.attrs.color}`;
      case 'underline': return `Underline: ${m.attrs.style}`;
      case 'link': return `Link: ${m.attrs.href}`;
      case 'charStyle': return `Character style: ${m.attrs.name}`;
      case 'spacing': return `Spacing: ${m.attrs.pt} pt`;
      case 'insertion': return `Inserted by ${m.attrs.author}`;
      case 'deletion': return `Deleted by ${m.attrs.author}`;
      case 'comment': return 'Comment';
      default: return m.type.name[0].toUpperCase() + m.type.name.slice(1);
    }
  });
}

const inspector: PaneDef = {
  id: 'inspector', title: 'Style Inspector',
  render(app, el) { (el as any)._draw = () => { clear(el); const p = currentParagraph(app.state); const map = resolveStyles(app.settings); const e = effectiveStyle(map, p?.attrs.style || 'Normal'); const marks = app.state.selection.$head.marks();
    const direct = p ? Object.entries(p.attrs).filter(([k, v]) => v != null && v !== false && v !== 0 && k !== 'style' && !(k === 'widowControl' && v === true)).map(([k, v]) => `${k}: ${v}`) : [];
    el.append(
      h('h3', null, 'Paragraph'), h('p', null, h('b', null, p?.attrs.style || 'Normal'), e.basedOn ? ` (based on ${e.basedOn})` : ''),
      h('p', { class: 'qf-help' }, `Font ${e.font || '+body'} ${e.size || 11} pt${e.bold ? ', bold' : ''}${e.italic ? ', italic' : ''} · Before ${e.spaceBefore ?? 0} pt · After ${e.spaceAfter ?? 0} pt · Line ${e.lineHeight || 'single'}${e.align ? ' · ' + e.align : ''}`),
      h('h4', null, 'Direct paragraph formatting'), direct.length ? h('ul', null, ...direct.map((d) => h('li', null, d))) : h('p', { class: 'qf-help' }, 'None'),
      h('button', { class: 'qf-btn', onclick: () => app.exec('fmt.clearPara') }, 'Clear paragraph formatting'),
      h('h3', null, 'Text level'), marks.length ? h('ul', null, ...describeMarks(marks).map((d) => h('li', null, d))) : h('p', { class: 'qf-help' }, 'Default paragraph font'),
      h('button', { class: 'qf-btn', onclick: () => app.exec('fmt.clearChar') }, 'Clear character formatting'),
    ); }; (el as any)._draw(); },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const clipboard: PaneDef = {
  id: 'clipboard', title: 'Clipboard',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      el.append(h('div', { class: 'qf-pane-actions' }, h('button', { class: 'qf-btn', onclick: () => { for (const c of [...app.clipboard].reverse()) app.view.pasteHTML(c.html || esc(c.text)); } }, 'Paste All'), h('button', { class: 'qf-btn', onclick: () => { app.clipboard = []; app.refresh(); } }, 'Clear All')));
      if (!app.clipboard.length) el.append(h('p', { class: 'qf-help' }, 'Items you cut or copy appear here. Tap an item to paste it.'));
      app.clipboard.forEach((c, i) => el.append(h('div', { class: 'qf-clip' },
        h('button', { class: 'qf-clip-text', onclick: () => { app.view.pasteHTML(c.html || esc(c.text)); app.focus(); } }, c.text.slice(0, 200) || '(formatted content)'),
        h('button', { class: 'qf-iconbtn qf-sm', title: 'Paste as text', onclick: () => app.view.pasteText(c.text) }, icon('content_paste_off')),
        h('button', { class: 'qf-iconbtn qf-sm', title: 'Delete', onclick: () => { app.clipboard.splice(i, 1); app.refresh(); } }, icon('delete')))));
    };
    (el as any)._draw();
  },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const find: PaneDef = {
  id: 'find', title: 'Find and Replace',
  render(app, el, opts) {
    const q = h('input', { placeholder: 'Find', 'aria-label': 'Find', value: opts.query || '' }) as HTMLInputElement;
    const r = h('input', { placeholder: 'Replace with', 'aria-label': 'Replace with' }) as HTMLInputElement;
    const chk = (label: string, title = '') => { const i = h('input', { type: 'checkbox' }) as HTMLInputElement; return { i, el: h('label', { class: 'qf-check', title }, i, ' ', label) }; };
    const cs = chk('Match case'), ww = chk('Whole words'), re = chk('Regular expressions', 'JavaScript regex; $1 in replacement'), wc = chk('Wildcards (? * ^#)', '? or ^? any char, * any run, ^# digit, ^$ letter, ^p paragraph, ^t tab'), sel = chk('In selection only'), pc = chk('Preserve case');
    const count = h('div', { class: 'qf-help' });
    const style = h('input', { placeholder: 'Apply style to matches (optional)', 'aria-label': 'Replace style' }) as HTMLInputElement;
    const apply = () => {
      // Same matcher as Replace All (buildMatcher), so highlights and replacements agree.
      setFind(app.view, { query: q.value, regex: re.i.checked, wildcards: wc.i.checked && !re.i.checked, caseSensitive: cs.i.checked, wholeWord: ww.i.checked, current: -1 });
      count.textContent = q.value ? `${findKey.getState(app.state)!.matches.length} match(es)` : '';
    };
    for (const x of [q, cs.i, ww.i, re.i, wc.i]) x.addEventListener('input', apply);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); app.exec(e.shiftKey ? 'edit.findPrev' : 'edit.findNext'); } });
    const replaceOne = () => {
      const st = app.state;
      const fs = findKey.getState(st)!;
      const m = fs.matches.find((x) => x.from === st.selection.from && x.to === st.selection.to);
      if (!m) { app.exec('edit.findNext'); return; }
      // Same engine as Replace All (^p ^t ^& codes, regex context and groups, wildcards, case, style), on this match only.
      replaceAll(app, { find: q.value, replace: r.value, regex: re.i.checked, caseSensitive: cs.i.checked, wholeWord: ww.i.checked, wildcards: wc.i.checked, inSelection: true, style: style.value || undefined, preserveCase: pc.i.checked, quiet: true });
      apply();
      app.exec('edit.findNext');
    };
    const row = (...k: (HTMLElement | null)[]) => h('div', { class: 'qf-row' }, ...k);
    const btn = (label: string, fn: () => void, ic?: string) => h('button', { class: 'qf-btn', type: 'button', onclick: fn }, ic ? icon(ic) : null, ' ', label);
    el.append(
      q, row(btn('Previous', () => app.exec('edit.findPrev'), 'keyboard_arrow_up'), btn('Next', () => app.exec('edit.findNext'), 'keyboard_arrow_down')), count,
      r, row(btn('Replace', replaceOne), btn('Replace All', () => { replaceAll(app, { find: q.value, replace: r.value, regex: re.i.checked, caseSensitive: cs.i.checked, wholeWord: ww.i.checked, wildcards: wc.i.checked, inSelection: sel.i.checked, style: style.value || undefined, preserveCase: pc.i.checked }); apply(); })),
      h('details', { open: !!opts.advanced }, h('summary', null, 'Options'), cs.el, ww.el, re.el, wc.el, sel.el, pc.el, style,
        h('p', { class: 'qf-help' }, 'Special: ^p paragraph mark, ^t tab, ^& found text. Regex groups: $1, $2…')),
    );
    if (opts.query) apply();
    setTimeout(() => (opts.replace && opts.query ? r : q).focus(), 30);
    (el as any)._q = q;
    (el as any)._apply = apply;
  },
  onOpen(app, el, opts) { const q = (el as any)._q as HTMLInputElement; if (opts?.query != null && q) { q.value = opts.query; (el as any)._apply(); } },
  onClose(app) { setFind(app.view, { query: '' }); },
};

// ------------------------------------------------------------------------------------------
const comments: PaneDef = {
  id: 'comments', title: 'Comments',
  render(app, el) {
    const filterSel = h('select', { class: 'qf-pane-select' }, h('option', { value: 'all' }, 'All comments'), h('option', { value: 'open' }, 'Open only'), h('option', { value: 'resolved' }, 'Resolved')) as HTMLSelectElement;
    const list = h('div', { class: 'qf-comments' });
    filterSel.addEventListener('change', () => (el as any)._draw());
    (el as any)._draw = () => {
      clear(list);
      const s = app.settings;
      const ranges = commentRanges(app.state.doc);
      const items = Object.values(s.comments).filter((c) => filterSel.value === 'all' || (filterSel.value === 'open' ? !c.resolved : c.resolved)).sort((a, b) => (ranges.get(a.id)?.from ?? 1e9) - (ranges.get(b.id)?.from ?? 1e9));
      if (!items.length) list.appendChild(h('p', { class: 'qf-help' }, 'No comments. Select text and use New Comment.'));
      const activeM = app.state.selection.$head.marks().find((m) => m.type === M.comment);
      for (const c of items) {
        const rg = ranges.get(c.id);
        const replyInput = h('input', { placeholder: 'Reply…', 'aria-label': 'Reply', 'data-reply': c.id }) as HTMLInputElement;
        replyInput.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || !replyInput.value) return;
          app.exec('review.replyComment', { id: c.id, text: replyInput.value });
          replyInput.value = '';
          (el as any)._draw();
          [...el.querySelectorAll<HTMLInputElement>('input[data-reply]')].find((x) => x.dataset.reply === c.id)?.focus();
        });
        const card = h('div', { class: 'qf-comment-card' + (c.resolved ? ' qf-resolved' : '') + (activeM?.attrs.id === c.id ? ' qf-on' : '') },
          h('div', { class: 'qf-comment-head' }, h('span', { class: 'qf-avatar' }, (c.author || '?')[0]), h('b', null, c.author), h('span', { class: 'qf-help' }, new Date(c.date).toLocaleString())),
          rg ? h('div', { class: 'qf-comment-quote', onclick: () => { app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, rg.from, rg.to)).scrollIntoView()); app.focus(); } }, '“' + rg.text.slice(0, 80) + '”') : h('div', { class: 'qf-help' }, '(anchor text was deleted)'),
          h('div', { class: 'qf-comment-text' }, c.text),
          ...c.replies.map((r) => h('div', { class: 'qf-comment-reply' }, h('b', null, r.author + ': '), r.text)),
          h('div', { class: 'qf-comment-reactions' }, ...['👍', '❤️', '✅', '❓'].map((em) => h('button', { class: 'qf-react', title: 'React', onclick: () => updateComment(app, c.id, (x) => { x.reactions = x.reactions || {}; x.reactions[em] = (x.reactions[em] || 0) + 1; }) }, em + (c.reactions?.[em] ? ' ' + c.reactions[em] : '')))),
          replyInput,
          h('div', { class: 'qf-row' },
            h('button', { class: 'qf-btn', onclick: () => app.exec('review.resolveComment', { id: c.id }) }, c.resolved ? 'Reopen' : 'Resolve'),
            h('button', { class: 'qf-btn', onclick: async () => { const t = await (await import('./dialog')).promptDialog('Edit Comment', 'Text:', c.text, { type: 'textarea' as any } as any); if (t != null) updateComment(app, c.id, (x) => { x.text = t; }); } }, 'Edit'),
            h('button', { class: 'qf-btn', onclick: () => app.exec('review.deleteComment', { id: c.id }) }, 'Delete')));
        list.appendChild(card);
      }
    };
    el.append(h('div', { class: 'qf-row' }, filterSel, h('button', { class: 'qf-btn qf-primary', onclick: () => app.exec('review.newComment') }, icon('add_comment'), ' New')), list);
    (el as any)._draw();
  },
  update(app, el) { if (!typingIn(el)) (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const revisions: PaneDef = {
  id: 'revisions', title: 'Revisions',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      const ch = listChanges(app.state.doc);
      const ins = ch.filter((c) => c.kind === 'insertion').length, del = ch.filter((c) => c.kind === 'deletion').length;
      el.append(h('p', null, h('b', null, `${ch.length} revisions`), ` — ${ins} insertions, ${del} deletions`),
        h('div', { class: 'qf-row' }, h('button', { class: 'qf-btn', onclick: () => app.exec('review.acceptAll') }, 'Accept All'), h('button', { class: 'qf-btn', onclick: () => app.exec('review.rejectAll') }, 'Reject All')));
      for (const c of ch.slice(0, 400)) {
        el.appendChild(h('div', { class: 'qf-rev qf-rev-' + c.kind },
          h('div', { class: 'qf-help' }, `${c.kind === 'insertion' ? 'Inserted' : c.kind === 'deletion' ? 'Deleted' : 'Formatted'} · ${c.author} · ${c.date ? new Date(c.date).toLocaleString() : ''}`),
          h('div', { class: 'qf-rev-text', onclick: () => { app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, c.from, c.to)).scrollIntoView()); app.focus(); } }, c.text.slice(0, 160)),
          h('div', { class: 'qf-row' }, h('button', { class: 'qf-btn qf-sm', onclick: () => { if (!refuseIfProtected(app)) app.view.dispatch(resolveChanges(app.state, [c], true)); } }, '✓ Accept'), h('button', { class: 'qf-btn qf-sm', onclick: () => { if (!refuseIfProtected(app)) app.view.dispatch(resolveChanges(app.state, [c], false)); } }, '✗ Reject'))));
      }
    };
    (el as any)._draw();
  },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const spelling: PaneDef = {
  id: 'spelling', title: 'Editor: Spelling & Grammar',
  render(app, el) {
    let idx = 0, seq = 0, timer: any = null;
    // The issue shown belongs to one version of one document: its positions are used only while that version
    // is current, and the pane redraws (without moving the cursor) when the document or the results change.
    let shown: { doc: PMNode; issues: unknown } | null = null;
    const draw = async (select: boolean) => {
      const token = ++seq;
      const st = app.state;
      const found = proofKey.getState(st)?.issues;
      shown = { doc: st.doc, issues: found };
      const issues = [...(found || [])].sort((a, b) => a.from - b.from);
      if (!issues.length) { clear(el); el.append(h('p', null, '✓ No spelling or grammar issues found.'), h('button', { class: 'qf-btn', onclick: () => app.proofer.run(app.tab) }, 'Recheck')); return; }
      idx = Math.min(idx, issues.length - 1);
      const is = issues[idx];
      const word = st.doc.textBetween(is.from, is.to);
      const sugs = is.kind === 'spell' ? await suggest(word, is.dialect) : is.suggestions;
      if (token !== seq) return;
      clear(el);
      const act = (fn: () => void) => () => { if (app.state.doc === st.doc) fn(); else void draw(true); };
      const counts = { spell: issues.filter((i) => i.kind === 'spell').length, grammar: issues.filter((i) => i.kind === 'grammar').length, style: issues.filter((i) => i.kind === 'style').length };
      el.append(
        h('p', { class: 'qf-help' }, `Spelling ${counts.spell} · Grammar ${counts.grammar} · Refinements ${counts.style}`),
        h('div', { class: 'qf-proof-card' }, h('div', { class: 'qf-help' }, is.kind === 'spell' ? 'Spelling' : is.kind === 'grammar' ? 'Grammar' : 'Clarity'), h('h3', null, word), h('p', null, is.message)),
        h('div', { class: 'qf-suggestions' }, ...(sugs.length ? sugs : []).map((s) => h('button', { class: 'qf-btn', onclick: act(() => { app.view.dispatch(app.state.tr.insertText(s, is.from, is.to)); setTimeout(() => void draw(true), 50); }) }, s)), sugs.length ? null : h('p', { class: 'qf-help' }, 'No suggestions')),
        h('div', { class: 'qf-row' },
          h('button', { class: 'qf-btn', onclick: act(() => { app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, is.from, is.to)).scrollIntoView()); }) }, 'Show'),
          h('button', { class: 'qf-btn', onclick: () => { idx++; void draw(true); } }, 'Ignore Once'),
          is.kind === 'spell' ? h('button', { class: 'qf-btn', onclick: () => { app.prefs.ignoredWords.push(word); app.savePrefs(); app.proofer.run(app.tab).then(() => draw(true)); } }, 'Ignore All') : null,
          is.kind === 'spell' ? h('button', { class: 'qf-btn', onclick: async () => { app.prefs.dictionary.push(word); app.savePrefs(); await addWord(word); app.proofer.run(app.tab).then(() => draw(true)); } }, 'Add to Dictionary') : null,
          sugs[0] ? h('button', { class: 'qf-btn', onclick: act(() => { replaceAll(app, { find: word, replace: sugs[0], wholeWord: true, caseSensitive: true }); app.proofer.run(app.tab).then(() => draw(true)); }) }, `Change All to “${sugs[0]}”`) : null),
        h('div', { class: 'qf-row' }, h('button', { class: 'qf-iconbtn', onclick: () => { idx = Math.max(0, idx - 1); void draw(true); } }, icon('chevron_left')), h('span', null, `${idx + 1} / ${issues.length}`), h('button', { class: 'qf-iconbtn', onclick: () => { idx++; void draw(true); } }, icon('chevron_right'))),
      );
      if (select && app.state.doc === st.doc) app.view.dispatch(app.state.tr.setSelection(TextSelection.create(app.state.doc, is.from, is.to)).scrollIntoView());
    };
    (el as any)._draw = draw;
    (el as any)._stale = () => !shown || shown.doc !== app.state.doc || shown.issues !== proofKey.getState(app.state)?.issues;
    (el as any)._later = () => { clearTimeout(timer); timer = setTimeout(() => void draw(false), 200); };
    void draw(true);
  },
  update(app, el) { if ((el as any)._stale?.()) (el as any)._later(); },
};

// ------------------------------------------------------------------------------------------
const thesaurus: PaneDef = {
  id: 'thesaurus', title: 'Thesaurus & Dictionary',
  render(app, el, opts) {
    const q = h('input', { placeholder: 'Look up a word', value: opts.word || '' }) as HTMLInputElement;
    const out = h('div', { class: 'qf-thesaurus' });
    const look = async () => {
      const w = q.value.trim();
      clear(out);
      if (!w) return;
      out.append(h('p', { class: 'qf-help' }, 'Looking up online…'));
      try {
        const [syn, ant, def] = await Promise.all([
          fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(w)}&max=40`).then((r) => r.json()),
          fetch(`https://api.datamuse.com/words?rel_ant=${encodeURIComponent(w)}&max=15`).then((r) => r.json()),
          fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        clear(out);
        const chip = (word: string) => h('button', { class: 'qf-chipbtn', title: 'Tap to replace; long-press to look up', onclick: () => { const st = app.state; if (!st.selection.empty) app.view.dispatch(st.tr.insertText(word)); else { const { wordAt } = require_ops(); const r = wordAt(st.selection.$head); if (r) app.view.dispatch(st.tr.insertText(word, r.from, r.to)); } }, oncontextmenu: (e: Event) => { e.preventDefault(); q.value = word; look(); } }, word);
        if (Array.isArray(def) && def[0]?.meanings) {
          for (const m of def[0].meanings.slice(0, 4)) out.append(h('h4', null, m.partOfSpeech), h('ol', null, ...m.definitions.slice(0, 3).map((d: any) => h('li', null, d.definition))));
        }
        out.append(h('h4', null, 'Synonyms'), syn.length ? h('div', { class: 'qf-chips' }, ...syn.map((x: any) => chip(x.word))) : h('p', { class: 'qf-help' }, 'None found'));
        if (ant.length) out.append(h('h4', null, 'Antonyms'), h('div', { class: 'qf-chips' }, ...ant.map((x: any) => chip(x.word))));
        out.append(h('p', { class: 'qf-help' }, 'Sources: Datamuse API and Free Dictionary API (online).'));
      } catch {
        clear(out);
        out.append(h('p', { class: 'qf-help' }, 'The thesaurus needs an internet connection.'));
      }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') look(); });
    el.append(h('div', { class: 'qf-row' }, q, h('button', { class: 'qf-btn', onclick: look }, icon('search'))), out);
    (el as any)._look = (w: string) => { q.value = w; look(); };
    if (opts.word) look();
  },
  onOpen(app, el, opts) { if (opts?.word) (el as any)._look?.(opts.word); },
};
function require_ops() { return { wordAt: (globalThis as any).__qfWordAt as (p: any) => { from: number; to: number } | null }; }

// ------------------------------------------------------------------------------------------
interface A11yIssue { level: 'error' | 'warning' | 'tip'; message: string; pos: number; fix?: () => void }
function accessibilityIssues(app: App): A11yIssue[] {
  const out: A11yIssue[] = [];
  const st = app.state;
  let lastLevel = 0;
  let sawH1 = false;
  st.doc.descendants((n, pos) => {
    if (n.type === N.image && !n.attrs.alt && n.attrs.title !== 'decorative') out.push({ level: 'error', message: 'Picture is missing alternative text', pos, fix: () => { app.view.dispatch(app.state.tr.setSelection(NodeSelection.create(app.state.doc, pos))); app.exec('picture.altText'); } });
    if (n.type === N.table) {
      if (!(n.firstChild?.firstChild?.type === N.table_header)) out.push({ level: 'warning', message: 'Table has no header row', pos, fix: () => { app.selectPos(pos + 3); app.exec('table.toggleHeaderRow'); } });
      let merged = false; n.descendants((c) => { if ((c.attrs.colspan || 1) > 1 || (c.attrs.rowspan || 1) > 1) merged = true; return !merged; });
      if (merged) out.push({ level: 'tip', message: 'Table uses merged cells, which can be hard to navigate with a screen reader', pos });
    }
    if (n.type === N.paragraph) {
      const l = styleLevel(n.attrs.style, n.attrs.outlineLevel);
      if (l) {
        if (l === 1) sawH1 = true;
        if (lastLevel && l > lastLevel + 1) out.push({ level: 'warning', message: `Heading level skipped (Heading ${lastLevel} → Heading ${l})`, pos });
        if (!n.textContent.trim()) out.push({ level: 'warning', message: 'Empty heading', pos });
        lastLevel = l;
      }
      const t = n.textContent;
      if (/(click here|read more|here)$/i.test(t) && n.content.size < 40) out.push({ level: 'tip', message: 'Link text such as “click here” is not descriptive', pos });
      if (!t.trim() && n.content.size === 0) { /* repeated blank paragraphs */ }
      n.forEach((c) => { const col = c.marks.find((m) => m.type === M.color)?.attrs.color; if (col && /^#(f[0-9a-f]|e[0-9a-f]|d[0-9a-f])[0-9a-f]{4}$/i.test(col)) out.push({ level: 'warning', message: `Very light text color (${col}) may be hard to read`, pos }); });
    }
    return true;
  });
  let blanks = 0, firstBlank = 0;
  st.doc.forEach((n, pos) => { if (n.type === N.paragraph && n.content.size === 0) { if (!blanks) firstBlank = pos; blanks++; if (blanks === 4) out.push({ level: 'tip', message: 'Several blank paragraphs are used for spacing; use Spacing Before/After or a page break', pos: firstBlank }); } else blanks = 0; });
  if (!app.settings.properties.title) out.push({ level: 'tip', message: 'Document title property is empty', pos: 0, fix: () => app.exec('file.properties') });
  if (!sawH1 && st.doc.childCount > 15) out.push({ level: 'tip', message: 'Long document without Heading 1 structure', pos: 0 });
  return out;
}

const accessibility: PaneDef = {
  id: 'accessibility', title: 'Accessibility',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      const issues = accessibilityIssues(app);
      el.append(h('p', null, issues.length ? `${issues.filter((i) => i.level === 'error').length} errors, ${issues.filter((i) => i.level === 'warning').length} warnings, ${issues.filter((i) => i.level === 'tip').length} tips` : '✓ No accessibility issues found.'));
      for (const i of issues) el.append(h('div', { class: `qf-a11y qf-a11y-${i.level}` }, h('span', { class: 'qf-help' }, i.level.toUpperCase()), h('div', { onclick: () => app.selectPos(i.pos + 1) }, i.message), i.fix ? h('button', { class: 'qf-btn qf-sm', onclick: i.fix }, 'Fix') : null));
    };
    (el as any)._draw();
  },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
// Reveal Codes (formatting codes around the cursor, editable by deletion)
function revealHtml(app: App): string {
  const st = app.state;
  const head = st.selection.head;
  const parts: string[] = [];
  const code = (t: string, cls = '') => `<span class="qf-code-tag ${cls}">[${esc(t)}]</span>`;
  const startIdx = Math.max(0, st.doc.resolve(head).index(0) - 3);
  const endIdx = Math.min(st.doc.childCount, startIdx + 8);
  let pos = 0;
  for (let i = 0; i < endIdx; i++) {
    const node = st.doc.child(i);
    if (i >= startIdx) {
      const walk = (n: PMNode, p: number) => {
        if (n.isText) {
          const t = n.text!;
          const open = n.marks.map((m) => code(m.type.name === 'font' ? `Font:${m.attrs.family}` : m.type.name === 'size' ? `Size:${m.attrs.pt}` : m.type.name === 'color' ? `Color:${m.attrs.color}` : m.type.name.replace(/^./, (c) => c.toUpperCase()) + ' On', 'qf-code-on')).join('');
          const close = [...n.marks].reverse().map((m) => code((m.type.name === 'font' ? 'Font' : m.type.name === 'size' ? 'Size' : m.type.name === 'color' ? 'Color' : m.type.name.replace(/^./, (c) => c.toUpperCase())) + ' Off', 'qf-code-off')).join('');
          let body = '';
          for (let k = 0; k < t.length; k++) {
            if (p + k === head) body += '<span class="qf-code-cursor"></span>';
            body += t[k] === '\t' ? code('Tab') : esc(t[k]);
          }
          if (p + t.length === head) body += '<span class="qf-code-cursor"></span>';
          parts.push(open + body + close);
          return;
        }
        if (n.isLeaf) { parts.push(code(n.type.name === 'hard_break' ? 'HRt' : n.type.name === 'page_break' ? 'HPg' : n.type.name === 'field' ? `Field:${n.attrs.type}` : n.type.name === 'footnote' ? 'Footnote' : n.type.name === 'image' ? 'Image' : n.type.name, 'qf-code-obj')); return; }
        if (n.type === N.paragraph) {
          const a = n.attrs;
          const props = [a.style !== 'Normal' ? `Style:${a.style}` : '', a.align ? `Just:${a.align}` : '', a.indentLeft ? `Lft Indent:${a.indentLeft}pt` : '', a.indentFirst ? `First Ln:${a.indentFirst}pt` : '', a.lineHeight ? `Ln Spacing:${a.lineHeight}` : '', a.spaceBefore != null ? `Spc Before:${a.spaceBefore}` : '', a.spaceAfter != null ? `Spc After:${a.spaceAfter}` : ''].filter(Boolean);
          parts.push(props.map((x) => code(x, 'qf-code-para')).join(''));
          n.forEach((c, off) => walk(c, p + 1 + off));
          parts.push(code('HRt', 'qf-code-para') + '<br>');
          return;
        }
        parts.push(code(n.type.name.replace(/_/g, ' ') + ' Begin', 'qf-code-obj'));
        n.forEach((c, off) => walk(c, p + 1 + off));
        parts.push(code(n.type.name.replace(/_/g, ' ') + ' End', 'qf-code-obj') + '<br>');
      };
      walk(node, pos);
    }
    pos += node.nodeSize;
  }
  return parts.join('');
}

const reveal: PaneDef = {
  id: 'reveal', title: 'Reveal Codes',
  render(app, el) { el.classList.add('qf-reveal'); el.innerHTML = revealHtml(app); },
  update(app, el) { el.innerHTML = revealHtml(app); el.querySelector('.qf-code-cursor')?.scrollIntoView({ block: 'nearest' }); },
};

// ------------------------------------------------------------------------------------------
const selection: PaneDef = {
  id: 'selection', title: 'Selection Pane',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      const items: { label: string; pos: number; icon: string }[] = [];
      app.state.doc.descendants((n, pos) => {
        if (n.type === N.image) items.push({ label: (n.attrs.editKind ? n.attrs.editKind + ': ' : 'Picture: ') + (n.attrs.alt || 'untitled'), pos, icon: 'image' });
        if (n.type === N.table) items.push({ label: `Table ${n.childCount}×${n.firstChild?.childCount}`, pos, icon: 'table' });
        if (n.type === N.text_box) items.push({ label: `Text box: ${n.textContent.slice(0, 30)}`, pos, icon: 'text_fields' });
        if (n.type === N.math_block || n.type === N.math_inline) items.push({ label: `Equation: ${n.attrs.latex.slice(0, 30)}`, pos, icon: 'function' });
        if (n.type === N.gen_block) items.push({ label: `Generated: ${n.attrs.kind}`, pos, icon: 'toc' });
        if (n.type === N.control) items.push({ label: `Control: ${n.attrs.kind} ${n.attrs.tag || ''}`, pos, icon: 'check_box' });
        return true;
      });
      if (!items.length) el.append(h('p', { class: 'qf-help' }, 'No objects in this document.'));
      for (const it of items) el.append(h('button', { class: 'qf-nav-item', onclick: () => { try { app.view.dispatch(app.state.tr.setSelection(NodeSelection.create(app.state.doc, it.pos)).scrollIntoView()); } catch { app.selectPos(it.pos); } app.focus(); } }, icon(it.icon), ' ', it.label));
    };
    (el as any)._draw();
  },
  update(app, el) { (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const snippets: PaneDef = {
  id: 'snippets', title: 'Building Blocks',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      el.append(h('button', { class: 'qf-btn qf-primary', onclick: () => app.exec('insert.saveSnippet') }, icon('library_add'), ' Save Selection'));
      const groups = new Map<string, typeof app.prefs.snippets>();
      for (const s of app.prefs.snippets) { if (!groups.has(s.gallery)) groups.set(s.gallery, []); groups.get(s.gallery)!.push(s); }
      if (!app.prefs.snippets.length) el.append(h('p', { class: 'qf-help' }, 'Save boilerplate text, signatures, tables or letterheads here. Type a block’s name and press F3 to insert it.'));
      for (const [g, list] of groups) {
        el.append(h('h4', null, g));
        for (const s of list) el.append(h('div', { class: 'qf-clip' }, h('button', { class: 'qf-clip-text', onclick: () => app.exec('insert.snippets', s.name) }, s.name), h('button', { class: 'qf-iconbtn qf-sm', title: 'Delete', onclick: async () => { if (await confirmDialog('Delete', `Delete "${s.name}"?`)) { app.prefs.snippets = app.prefs.snippets.filter((x) => x !== s); app.savePrefs(); (el as any)._draw(); } } }, icon('delete'))));
      }
    };
    (el as any)._draw();
  },
};

// ------------------------------------------------------------------------------------------
const notes: PaneDef = {
  id: 'notes', title: 'Footnotes & Endnotes',
  render(app, el) {
    (el as any)._draw = () => {
      clear(el);
      let n = 0;
      app.state.doc.descendants((node, pos) => {
        if (node.type !== N.footnote) return true;
        n++;
        const ta = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
        ta.value = node.attrs.text;
        ta.addEventListener('change', () => {
          // The document may have changed since the list was drawn: find the note again (by id, else position and text).
          let at = -1;
          app.state.doc.descendants((x, p) => { if (at < 0 && x.type === N.footnote && (node.attrs.id ? x.attrs.id === node.attrs.id : p === pos && x.attrs.text === node.attrs.text)) at = p; return at < 0; });
          const cur = at >= 0 ? app.state.doc.nodeAt(at) : null;
          if (cur) app.view.dispatch(app.state.tr.setNodeMarkup(at, undefined, { ...cur.attrs, text: ta.value }));
          else toast('That note is no longer in the document.');
        });
        el.append(h('div', { class: 'qf-note' }, h('button', { class: 'qf-link', onclick: () => app.selectPos(pos) }, `${node.attrs.kind === 'end' ? 'Endnote' : 'Footnote'} ${n}`), ta));
        return true;
      });
      if (!n) el.append(h('p', { class: 'qf-help' }, 'No notes yet. Use References ▸ Insert Footnote.'));
      (el as any)._doc = app.state.doc;
    };
    (el as any)._draw();
  },
  update(app, el) { if ((el as any)._doc !== app.state.doc && !typingIn(el)) (el as any)._draw?.(); },
};

// ------------------------------------------------------------------------------------------
const versions: PaneDef = {
  id: 'versions', title: 'Version History',
  async render(app, el) {
    // The list and its buttons belong to the document shown when it was drawn (see update).
    const tab = app.tab, e = el as any;
    e._tab = tab; e._key = undefined; e._token = (e._token || 0) + 1;
    const { docKey } = await import('../commands/file');
    const key = e._key = docKey(tab);
    e._docKey = docKey;
    const draw = async () => {
      if (e._tab !== tab) return;
      const token = e._token = (e._token || 0) + 1;
      const live = () => e._token === token && e._tab === tab;
      clear(el);
      el.append(h('button', { class: 'qf-btn qf-primary', onclick: async () => { await app.exec('file.snapshot'); setTimeout(draw, 300); } }, icon('add_a_photo'), ' Take Snapshot'));
      const keys = (await kvKeys(`snap:${key}:`)).sort().reverse();
      if (!live()) return;
      if (!keys.length) el.append(h('p', { class: 'qf-help' }, 'Snapshots are saved each time you save and when you take one manually.'));
      for (const k of keys.slice(0, 100)) {
        const snap = await kvGet(k);
        if (!live()) return;
        if (!snap) continue;
        el.append(h('div', { class: 'qf-version' },
          h('div', null, h('b', null, snap.label), h('div', { class: 'qf-help' }, `${new Date(snap.when).toLocaleString()} · ${snap.words} words`)),
          h('div', { class: 'qf-row' },
            h('button', { class: 'qf-btn qf-sm', onclick: () => app.createTab(schema.nodeFromJSON(snap.json), { title: `${snap.name} (${new Date(snap.when).toLocaleDateString()})`, readOnly: false }) }, 'Open'),
            h('button', { class: 'qf-btn qf-sm', onclick: () => { const d = compareDocs(schema.nodeFromJSON(snap.json), tab.view.state.doc, 'Changes since snapshot'); app.createTab(d, { title: 'Compare with snapshot' }); } }, 'Compare'),
            h('button', { class: 'qf-btn qf-sm', onclick: async () => { if (await confirmDialog('Restore Version', 'Replace the current document with this version? (Undo is available.)') && app.docs.includes(tab)) { tab.view.dispatch(tab.view.state.tr.replaceWith(0, tab.view.state.doc.content.size, schema.nodeFromJSON(snap.json).content)); } } }, 'Restore'),
            h('button', { class: 'qf-iconbtn qf-sm', title: 'Delete', onclick: async () => { await kvDel(k); draw(); } }, icon('delete')))));
      }
    };
    draw();
  },
  update(app, el) {
    // Another document, or the same tab now holding another file (a blank tab is reused when a file opens).
    const e = el as any;
    if (e._tab !== app.tab || (e._key !== undefined && e._docKey(app.tab) !== e._key)) { clear(el); void versions.render(app, el, {}); }
  },
};

// ------------------------------------------------------------------------------------------
const mailmerge: PaneDef = {
  id: 'mailmerge', title: 'Mail Merge Wizard',
  render(app, el) {
    const steps: [string, string, string][] = [
      ['1. Document type', 'Letters, e-mail, envelopes, labels, or a directory.', 'mail.start'],
      ['2. Recipients', 'Type a list, load a CSV/TSV file, or use a table in this document.', 'mail.selectRecipients'],
      ['3. Write', 'Insert Address Block, Greeting Line, or individual fields.', 'mail.insertField'],
      ['4. Preview', 'Step through records to check the results.', 'mail.preview'],
      ['5. Complete', 'Merge to a new document, print, or e-mail.', 'mail.finish'],
    ];
    for (const [t, d, id] of steps) el.append(h('div', { class: 'qf-wizard-step' }, h('b', null, t), h('p', { class: 'qf-help' }, d), h('button', { class: 'qf-btn', onclick: () => app.exec(id) }, 'Go')));
    const d = app.settings.mergeData;
    el.append(h('p', null, d ? `${d.rows.length} recipients · fields: ${d.fields.join(', ')}` : 'No recipients selected.'));
  },
};

export const PANES: Record<string, PaneDef> = { navigation, styles, inspector, clipboard, find, comments, revisions, spelling, thesaurus, accessibility, reveal, selection, snippets, notes, versions, mailmerge, ai: aiPaneDef };
void toast; void openDialog; void pageOfPos;
