/** Review tab: proofing, comments, tracking, changes, compare, protect, accessibility, speech. */
import { def } from './registry';
import { trackPositions, type App } from '../app';
import { hashPassword, verifyPassword } from '../util/crypto';
import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { normalizeSettings } from '../editor/settings';
import { schema } from '../editor/schema';
import { trackKey, listChanges, resolveChanges, changesInRange } from '../editor/plugins/trackChanges';
import { proofKey, coachKey } from '../editor/plugins/decorations';
import { compareDocs } from '../editor/compare';
import { countWords, docText, selectedText, textblocks, wordAt } from '../editor/ops';
import { openDialog, toast, promptDialog, confirmDialog, alertDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { keepAwake, openExternal } from '../platform/native';
import { SPELL_DIALECTS, type SpellDialect } from '../proof/proofing';

const N = schema.nodes;
const M = schema.marks;
const v = (app: App) => app.view;

// ------------------------------------------------------------------------------------------
// Proofing

export function textStats(text: string) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || [];
  const sentences = Math.max(1, (text.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length || (words.length ? 1 : 0));
  const syll = (w: string) => {
    const s = w.toLowerCase().replace(/[^a-z]/g, '');
    if (s.length <= 3) return 1;
    const m = s.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return Math.max(1, m ? m.length : 1);
  };
  const syllables = words.reduce((a, w) => a + syll(w), 0);
  const complex = words.filter((w) => syll(w) >= 3).length;
  const chars = text.replace(/\s/g, '').length;
  const wc = words.length || 1;
  const fre = 206.835 - 1.015 * (wc / sentences) - 84.6 * (syllables / wc);
  const fk = 0.39 * (wc / sentences) + 11.8 * (syllables / wc) - 15.59;
  const fog = 0.4 * (wc / sentences + 100 * (complex / wc));
  const smog = 1.043 * Math.sqrt(complex * (30 / sentences)) + 3.1291;
  const cli = 0.0588 * ((chars / wc) * 100) - 0.296 * ((sentences / wc) * 100) - 15.8;
  const ari = 4.71 * (chars / wc) + 0.5 * (wc / sentences) - 21.43;
  const passive = (text.match(/\b(am|is|are|was|were|be|been|being)\s+\w+(ed|en)\b/gi) || []).length;
  return { words: words.length, sentences, syllables, chars, charsWithSpaces: text.length, complex, fre, fk, fog, smog, cli, ari, passive, readingMinutes: words.length / 238, speakingMinutes: words.length / 140 };
}

def([
  { id: 'review.spelling', label: 'Spelling & Grammar', icon: 'spellcheck', tab: 'Review', group: 'Proofing', keys: ['F7'], popular: true, run: (app) => { app.ui.openPane('spelling'); return app.proofer.run(app.tab); } },
  {
    id: 'review.spellDialect', label: 'English Spelling', icon: 'translate', tab: 'Review', group: 'Language', kind: 'menu',
    tip: 'Accept every standard English spelling (default), follow the document\'s language, or check one variety: US, UK (with Oxford -ize), Canada or Australia',
    keywords: 'dialect american british canadian australian dictionary colour color',
    run: async (app, arg?: SpellDialect) => {
      if (!arg) {
        const r = await openDialog({ title: 'English Spelling', fields: [{ key: 'd', label: 'Dictionary', type: 'select', options: SPELL_DIALECTS, value: app.prefs.spellDialect || 'any' }] });
        if (!r) return;
        arg = r.d;
      }
      if (!SPELL_DIALECTS.some((d) => d.value === arg)) return;
      app.prefs.spellDialect = arg!;
      app.savePrefs();
      app.proofer.schedule(app.tab, 0);
      toast(SPELL_DIALECTS.find((d) => d.value === arg)?.label || '');
    },
    menu: (app) => [...SPELL_DIALECTS.map((d) => ({ id: 'review.spellDialect', arg: d.value, label: d.label, checked: (app.prefs.spellDialect || 'any') === d.value })), { id: 'review.dictionaries', label: 'Dictionaries for other languages…' }],
  },
  {
    id: 'review.dictionaries', label: 'Spelling Dictionaries…', icon: 'download', tab: 'Review', group: 'Language', noRecord: true,
    tip: 'Download free spelling dictionaries for 90+ languages and use them for documents or marked text',
    keywords: 'language dictionary hunspell download french german spanish install',
    run: async (app) => { const { openDictionaryWizard } = await import('../ui/dictWizard'); await openDictionaryWizard(app); },
  },
  { id: 'review.toggleSpell', label: 'Check Spelling as You Type', icon: 'spellcheck', tab: 'Review', group: 'Proofing', kind: 'toggle', run: (app) => { app.prefs.spellcheck = !app.prefs.spellcheck; app.savePrefs(); app.proofer.schedule(app.tab, 0); }, isActive: (app) => app.prefs.spellcheck },
  { id: 'review.toggleGrammar', label: 'Mark Grammar Errors as You Type', icon: 'grading', tab: 'Review', group: 'Proofing', kind: 'toggle', run: (app) => { app.prefs.grammar = !app.prefs.grammar; app.savePrefs(); app.proofer.schedule(app.tab, 0); }, isActive: (app) => app.prefs.grammar },
  { id: 'review.hideProof', label: 'Hide Spelling & Grammar Errors in This Document', icon: 'visibility_off', tab: 'Review', group: 'Proofing', run: (app) => app.view.dispatch(app.state.tr.setMeta(proofKey, []).setMeta('addToHistory', false)) },
  {
    id: 'review.recheck', label: 'Recheck Document', icon: 'restart_alt', tab: 'Review', group: 'Proofing',
    run: async (app) => { app.prefs.ignoredWords = []; app.savePrefs(); const n = await app.proofer.run(app.tab); toast(`${n.length} issue(s) found`); },
  },
  {
    id: 'review.thesaurus', label: 'Thesaurus', icon: 'menu_book', tab: 'Review', group: 'Proofing', keys: ['Shift-F7'], popular: true,
    run: (app) => app.ui.openPane('thesaurus', { word: selectedText(app.state).trim() || wordAt(app.state.selection.$head)?.text || '' }),
  },
  {
    id: 'review.define', label: 'Define (Dictionary)', icon: 'dictionary', tab: 'Review', group: 'Proofing',
    run: (app) => app.ui.openPane('thesaurus', { word: selectedText(app.state).trim() || wordAt(app.state.selection.$head)?.text || '', define: true }),
  },
  {
    id: 'review.wordCount', label: 'Word Count', icon: 'tag', tab: 'Review', group: 'Proofing', keys: ['Mod-Shift-g'], popular: true,
    run: async (app) => {
      const st = app.state;
      const sel = !st.selection.empty;
      const text = sel ? selectedText(st) : docText(st.doc);
      const s = textStats(text);
      let fn = 0, fnWords = 0;
      st.doc.descendants((n) => { if (n.type === N.footnote) { fn++; fnWords += countWords(n.attrs.text); } return true; });
      const pages = (await import('../editor/plugins/pagination')).pageInfo(st).pages;
      const paras = textblocks(st.doc).filter((b) => b.text.trim()).length;
      const lines = sel ? text.split('\n').length : '—';
      const rows: [string, string | number][] = [
        ['Pages', app.tab.viewMode === 'print' ? pages : '(Print Layout)'], ['Words', s.words], ['Characters (no spaces)', s.chars], ['Characters (with spaces)', s.charsWithSpaces],
        ['Paragraphs', sel ? text.split(/\n+/).filter((x) => x.trim()).length : paras], ['Lines', lines], ['Sentences', s.sentences],
        ['Footnotes/endnotes', `${fn} (${fnWords} words)`], ['Reading time', `${Math.ceil(s.readingMinutes)} min`], ['Speaking time', `${Math.ceil(s.speakingMinutes)} min`],
      ];
      await alertDialog(sel ? 'Word Count (selection)' : 'Word Count', h('table', { class: 'qf-stats' }, ...rows.map(([k, val]) => h('tr', null, h('td', null, k), h('td', null, String(val))))));
    },
  },
  {
    id: 'review.readability', label: 'Readability Statistics', icon: 'insights', tab: 'Review', group: 'Proofing',
    run: async (app) => {
      const s = textStats(app.state.selection.empty ? docText(app.state.doc) : selectedText(app.state));
      const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');
      const rows: [string, string][] = [
        ['Words', String(s.words)], ['Sentences', String(s.sentences)], ['Words per sentence', f(s.words / s.sentences)], ['Characters per word', f(s.chars / (s.words || 1))],
        ['Passive sentences (approx.)', `${Math.round((s.passive / s.sentences) * 100)}%`], ['Flesch Reading Ease', f(s.fre)], ['Flesch-Kincaid Grade Level', f(s.fk)],
        ['Gunning Fog Index', f(s.fog)], ['SMOG Index', f(s.smog)], ['Coleman-Liau Index', f(s.cli)], ['Automated Readability Index', f(s.ari)],
      ];
      await alertDialog('Readability Statistics', h('table', { class: 'qf-stats' }, ...rows.map(([k, val]) => h('tr', null, h('td', null, k), h('td', null, val)))));
    },
  },
  { id: 'review.styleCoach', label: 'Writing Style Highlights', icon: 'auto_fix', tab: 'Review', group: 'Proofing', kind: 'toggle', origin: 'Readability editors (Hemingway-style highlighting)', run: (app) => { const on = !coachKey.getState(app.state)?.on; v(app).dispatch(app.state.tr.setMeta(coachKey, on)); if (on) toast('Yellow: long sentence · Red: very long · Blue: adverb · Green: passive · Purple: weak phrase'); }, isActive: (app) => !!coachKey.getState(app.state)?.on },
  { id: 'review.accessibility', label: 'Check Accessibility', icon: 'accessibility_new', tab: 'Review', group: 'Accessibility', popular: true, run: (app) => app.ui.openPane('accessibility') },
  {
    id: 'review.altText', label: 'Alt Text…', icon: 'image_search', tab: 'Review', group: 'Accessibility', edits: true,
    run: (app) => app.exec('picture.altText'),
  },
  {
    id: 'review.translate', label: 'Translate Selection (online)', icon: 'translate', tab: 'Review', group: 'Language',
    run: async (app) => {
      const t = selectedText(app.state) || docText(app.state.doc).slice(0, 4000);
      const r = await openDialog({ title: 'Translate', help: 'Opens an online translator in your browser. The selected text is sent to that service.', fields: [{ key: 'to', label: 'Translate to', type: 'select', options: ['es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'pl', 'ru', 'uk', 'el', 'tr', 'ar', 'he', 'hi', 'zh-CN', 'ja', 'ko', 'la'], value: 'es' }] });
      if (r) openExternal(`https://translate.google.com/?sl=auto&tl=${r.to}&text=${encodeURIComponent(t)}&op=translate`);
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Read aloud / speech

let speaking = false;
def([
  {
    id: 'review.readAloud', label: 'Read Aloud', icon: 'record_voice_over', tab: 'Review', group: 'Speech', kind: 'toggle', keys: ['Mod-Alt-Space'], popular: true,
    run: async (app) => {
      const synth = window.speechSynthesis;
      if (!synth) { toast('Text-to-speech is not available on this device.'); return; }
      if (speaking) { synth.cancel(); speaking = false; keepAwake(false); app.refresh(); return; }
      const tab = app.tab;
      const st = app.state;
      const from = st.selection.empty ? st.selection.from : st.selection.from;
      const to = st.selection.empty ? st.doc.content.size : st.selection.to;
      const blocks = textblocks(st.doc).filter((b) => b.pos + b.node.nodeSize > from && b.pos < to && b.text.trim());
      speaking = true;
      keepAwake(true);
      app.refresh();
      for (const b of blocks) {
        // Stop when switched off or when another document became active.
        if (!speaking || app.tab !== tab) { synth.cancel(); break; }
        app.selectPos(b.pos + 1);
        await new Promise<void>((res) => {
          const u = new SpeechSynthesisUtterance(b.text.replace(/￼/g, ' '));
          u.rate = app.prefs.readAloudRate;
          u.lang = app.settings.language;
          u.onboundary = (e) => {
            if (e.name !== 'word') return;
            try { const p = b.pos + 1 + e.charIndex; const w = wordAt(app.state.doc.resolve(Math.min(p + 1, app.state.doc.content.size))); if (w) app.view.dispatch(app.state.tr.setSelection((app.state.selection.constructor as any).create(app.state.doc, w.from, w.to)).scrollIntoView()); } catch { /* */ }
          };
          u.onend = () => res(); u.onerror = () => res();
          synth.speak(u);
        });
      }
      speaking = false;
      keepAwake(false);
      app.refresh();
    },
    isActive: () => speaking,
  },
  {
    id: 'review.speechSettings', label: 'Read Aloud Settings…', icon: 'settings_voice', tab: 'Review', group: 'Speech',
    run: async (app) => {
      const r = await openDialog({ title: 'Read Aloud', fields: [{ key: 'rate', label: 'Reading speed', type: 'range', min: 0.5, max: 2, step: 0.1, value: app.prefs.readAloudRate, suffix: '×' }] });
      if (r) { app.prefs.readAloudRate = r.rate; app.savePrefs(); }
    },
  },
  {
    id: 'review.dictate', label: 'Dictate (Voice Typing)', icon: 'mic', tab: 'Home', group: 'Voice', kind: 'toggle', keys: ['Alt-`'], origin: 'Voice typing in online editors',
    run: (app) => {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) { toast('Voice typing in the app uses your keyboard’s microphone button (e.g. Gboard voice input).'); return; }
      if ((app as any)._rec) { (app as any)._rec.stop(); (app as any)._rec = null; app.refresh(); return; }
      const rec = new SR();
      rec.continuous = true; rec.interimResults = false; rec.lang = app.settings.language;
      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) {
          let t = e.results[i][0].transcript.trim();
          t = t.replace(/\b(new paragraph)\b/gi, '\n').replace(/\bcomma\b/gi, ',').replace(/\bperiod\b|\bfull stop\b/gi, '.').replace(/\bquestion mark\b/gi, '?').replace(/\s+([,.?])/g, '$1');
          if (t.includes('\n')) { for (const [k, part] of t.split('\n').entries()) { if (k) app.view.dispatch(app.state.tr.split(app.state.selection.from)); if (part) app.view.dispatch(app.state.tr.insertText(part + ' ')); } }
          else app.view.dispatch(app.state.tr.insertText(t + ' ').scrollIntoView());
        }
      };
      rec.onend = () => { (app as any)._rec = null; app.refresh(); };
      rec.start();
      (app as any)._rec = rec;
      toast('Listening… say "new paragraph", "comma", "period".');
    },
    isActive: (app) => !!(app as any)._rec,
  },
]);

// ------------------------------------------------------------------------------------------
// Comments

function commentIdAtCursor(app: App): string | null {
  const m = app.state.selection.$head.marks().find((x) => x.type === M.comment) || app.state.doc.resolve(Math.min(app.state.selection.head + 1, app.state.doc.content.size)).marks().find((x) => x.type === M.comment);
  return m ? m.attrs.id : null;
}

export function commentRanges(doc: PMNode): Map<string, { from: number; to: number; text: string }> {
  const out = new Map<string, { from: number; to: number; text: string }>();
  doc.descendants((n, pos) => {
    if (!n.isInline) return true;
    for (const m of n.marks) if (m.type === M.comment) {
      const cur = out.get(m.attrs.id);
      const t = n.isText ? n.text! : '';
      if (cur) { cur.to = pos + n.nodeSize; cur.text += t; } else out.set(m.attrs.id, { from: pos, to: pos + n.nodeSize, text: t });
    }
    return true;
  });
  return out;
}

def([
  {
    id: 'review.newComment', label: 'New Comment', icon: 'add_comment', tab: 'Review', group: 'Comments', keys: ['Mod-Alt-m'], popular: true,
    run: async (app) => {
      const st = app.state;
      let { from, to } = st.selection;
      if (from === to) { const w = wordAt(st.selection.$head); if (w) { from = w.from; to = w.to; } }
      if (from === to) { toast('Select text or place the cursor in a word to comment on it.'); return; }
      const pt = trackPositions(app);
      const text = await promptDialog('New Comment', `Comment on “${st.doc.textBetween(from, to).slice(0, 60)}”:`, '', { type: 'textarea' as any, rows: 4 } as any);
      pt.done();
      if (!text || pt.lost) return;
      const a = pt.map(from, 1), b = pt.map(to, -1);
      if (b <= a) { toast('The text you were commenting on was deleted.'); return; }
      const id = `cm${Date.now().toString(36)}`;
      const s = JSON.parse(JSON.stringify(app.settings));
      s.comments[id] = { id, author: app.prefs.author, date: Date.now(), text, resolved: false, replies: [] };
      const tr = app.state.tr.addMark(a, b, M.comment.create({ id })).setDocAttribute('settings', s).setMeta('comment', true).setMeta('trackSkip', true);
      v(app).dispatch(tr);
      app.ui.openPane('comments');
    },
  },
  {
    id: 'review.deleteComment', label: 'Delete Comment', icon: 'speaker_notes_off', tab: 'Review', group: 'Comments', kind: 'split', edits: true,
    run: (app, arg) => {
      const id = arg?.id || commentIdAtCursor(app);
      const st = app.state;
      const s = JSON.parse(JSON.stringify(app.settings));
      const tr = st.tr.setMeta('comment', true).setMeta('trackSkip', true);
      const del = (cid: string) => { delete s.comments[cid]; st.doc.descendants((n, pos) => { if (n.isInline && n.marks.some((m) => m.type === M.comment && m.attrs.id === cid)) tr.removeMark(pos, pos + n.nodeSize, M.comment.create({ id: cid })); return true; }); };
      if (arg === 'all') Object.keys(s.comments).forEach(del);
      else if (arg === 'resolved') Object.values(s.comments).filter((c: any) => c.resolved).forEach((c: any) => del(c.id));
      else if (id) del(id);
      else { toast('No comment at the cursor.'); return; }
      st.doc.descendants((n, pos) => { if (n.isInline) for (const m of n.marks) if (m.type === M.comment && !s.comments[m.attrs.id]) tr.removeMark(pos, pos + n.nodeSize, m); return true; });
      tr.setDocAttribute('settings', s);
      v(app).dispatch(tr);
    },
    menu: () => [{ id: 'review.deleteComment', label: 'Delete' }, { id: 'review.deleteComment', arg: 'resolved', label: 'Delete All Resolved Comments' }, { id: 'review.deleteComment', arg: 'all', label: 'Delete All Comments in Document' }],
  },
  { id: 'review.deleteAllComments', label: 'Delete All Comments', icon: 'delete_sweep', tab: 'Review', group: 'Comments', edits: true, run: async (app) => { if (await confirmDialog('Delete All Comments', 'Delete every comment in this document?')) app.exec('review.deleteComment', 'all'); } },
  { id: 'review.prevComment', label: 'Previous Comment', icon: 'chevron_left', tab: 'Review', group: 'Comments', noRecord: true, run: (app) => gotoComment(app, -1) },
  { id: 'review.nextComment', label: 'Next Comment', icon: 'chevron_right', tab: 'Review', group: 'Comments', noRecord: true, run: (app) => gotoComment(app, 1) },
  { id: 'review.showComments', label: 'Show Comments', icon: 'forum', tab: 'Review', group: 'Comments', kind: 'toggle', popular: true, run: (app) => app.ui.togglePane('comments'), isActive: (app) => app.ui.paneOpen('comments') },
  {
    id: 'review.resolveComment', label: 'Resolve Comment', icon: 'task_alt', tab: 'Review', group: 'Comments',
    run: (app, arg) => { const id = arg?.id || commentIdAtCursor(app); if (!id) return; updateComment(app, id, (c) => { c.resolved = !c.resolved; }); },
  },
  {
    id: 'review.replyComment', label: 'Reply to Comment', icon: 'reply', tab: 'Review', group: 'Comments',
    run: async (app, arg) => {
      const id = arg?.id || commentIdAtCursor(app);
      if (!id) { toast('Place the cursor in commented text.'); return; }
      const text = arg?.text ?? (await promptDialog('Reply', 'Reply:', '', { type: 'textarea' as any } as any));
      if (!text) return;
      updateComment(app, id, (c) => { c.replies.push({ id: `r${Date.now().toString(36)}`, author: app.prefs.author, date: Date.now(), text }); });
    },
  },
]);

export function updateComment(app: App, id: string, fn: (c: any) => void) {
  const s = JSON.parse(JSON.stringify(app.settings));
  if (!s.comments[id]) return;
  fn(s.comments[id]);
  v(app).dispatch(app.state.tr.setDocAttribute('settings', s).setMeta('comment', true).setMeta('trackSkip', true));
}

function gotoComment(app: App, dir: 1 | -1) {
  const ranges = [...commentRanges(app.state.doc).values()].sort((a, b) => a.from - b.from);
  if (!ranges.length) { toast('No comments.'); return; }
  const pos = app.state.selection.from;
  const t = dir > 0 ? ranges.find((r) => r.from > pos) || ranges[0] : [...ranges].reverse().find((r) => r.from < pos) || ranges[ranges.length - 1];
  app.selectPos(t.from);
  app.ui.openPane('comments');
}

// ------------------------------------------------------------------------------------------
// Tracking

function setTracking(app: App, on: boolean) {
  if (!on && app.settings.protection.mode === 'tracked') { toast('Tracking is locked by Restrict Editing.'); return; }
  if (!on && trackKey.getState(app.state)?.lockTracking) { toast('Tracking is locked. Use Lock Tracking to unlock.'); return; }
  v(app).dispatch(app.state.tr.setMeta(trackKey, { enabled: on, author: app.prefs.author }).setMeta('addToHistory', false));
  app.ui.status(on ? 'Track Changes on' : 'Track Changes off');
}

def([
  { id: 'review.trackChanges', label: 'Track Changes', icon: 'track_changes', tab: 'Review', group: 'Tracking', kind: 'toggle', keys: ['Mod-Shift-e'], popular: true, run: (app) => setTracking(app, !trackKey.getState(app.state)?.enabled), isActive: (app) => !!trackKey.getState(app.state)?.enabled || app.settings.protection.mode === 'tracked' },
  {
    id: 'review.lockTracking', label: 'Lock Tracking', icon: 'lock', tab: 'Review', group: 'Tracking', kind: 'toggle',
    run: (app) => { const cur = !!trackKey.getState(app.state)?.lockTracking; v(app).dispatch(app.state.tr.setMeta(trackKey, { lockTracking: !cur, enabled: true })); },
    isActive: (app) => !!trackKey.getState(app.state)?.lockTracking,
  },
  {
    id: 'review.markupView', label: 'Display for Review', icon: 'rate_review', tab: 'Review', group: 'Tracking', kind: 'menu',
    run: (app, arg) => { app.tab.el.dataset.markup = arg || 'all'; app.refresh(); },
    menu: (app) => [['simple', 'Simple Markup'], ['all', 'All Markup'], ['none', 'No Markup (final)'], ['original', 'Original']].map(([k, l]) => ({ id: 'review.markupView', arg: k, label: l, checked: (app.tab.el.dataset.markup || 'all') === k })),
  },
  {
    id: 'review.showMarkup', label: 'Show Markup', icon: 'checklist', tab: 'Review', group: 'Tracking', kind: 'menu',
    run: (app, arg) => { const el = app.tab.el; const k = `hide${arg}`; el.classList.toggle(`qf-${k}`); app.refresh(); },
    menu: (app) => [['Comments', 'Comments'], ['Insertions', 'Insertions and Deletions'], ['Formatting', 'Formatting']].map(([k, l]) => ({ id: 'review.showMarkup', arg: k, label: l, checked: !app.tab.el.classList.contains(`qf-hide${k}`) })),
  },
  { id: 'review.reviewingPane', label: 'Reviewing Pane', icon: 'view_list', tab: 'Review', group: 'Tracking', kind: 'toggle', run: (app) => app.ui.togglePane('revisions'), isActive: (app) => app.ui.paneOpen('revisions') },
  {
    id: 'review.changeAuthor', label: 'Change User Name…', icon: 'badge', tab: 'Review', group: 'Tracking',
    run: async (app) => {
      const r = await openDialog({ title: 'User Name', fields: [{ key: 'author', label: 'User name', type: 'text', value: app.prefs.author }, { key: 'initials', label: 'Initials', type: 'text', value: app.prefs.initials }] });
      if (!r) return;
      app.prefs.author = r.author || 'Author'; app.prefs.initials = r.initials || app.prefs.author[0];
      app.savePrefs();
      for (const d of app.docs) d.view.dispatch(d.view.state.tr.setMeta(trackKey, { author: app.prefs.author }));
    },
  },
]);

/** Accept/Reject and the Document Inspector dispatch with trackSkip (which bypasses protection), so they
 *  refuse while the document is protected or read-only. Returns true when refused. */
export function refuseIfProtected(app: App): boolean {
  const s = app.settings;
  if (s.protection.mode === 'none' && !s.markedFinal && !app.tab.readOnly) return false;
  toast('This document is protected. Use Review ▸ Restrict Editing to remove protection first.');
  return true;
}

function acceptReject(app: App, accept: boolean, scope: 'one' | 'all' | 'shown' | 'selection' | 'author', moveNext = false) {
  const st = app.state;
  let changes = listChanges(st.doc);
  if (scope === 'one' || scope === 'selection') {
    const { from, to } = st.selection;
    changes = changesInRange(st.doc, from, to);
    if (!changes.length && scope === 'one') {
      const next = listChanges(st.doc).find((c) => c.from >= from);
      if (next) { app.selectPos(next.from); app.view.dispatch(app.state.tr.setSelection((app.state.selection.constructor as any).create(app.state.doc, next.from, next.to))); }
      else toast('No more changes.');
      return;
    }
  }
  if (scope === 'shown') {
    const el = app.tab.el;
    changes = changes.filter((c) => !(el.classList.contains('qf-hideInsertions') && (c.kind === 'insertion' || c.kind === 'deletion')) && !(el.classList.contains('qf-hideFormatting') && c.kind === 'format'));
  }
  if (!changes.length) { toast('No tracked changes.'); return; }
  if (refuseIfProtected(app)) return;
  const end = Math.max(...changes.map((c) => c.to));
  v(app).dispatch(resolveChanges(app.state, changes, accept));
  if (moveNext) {
    const next = listChanges(app.state.doc).find((c) => c.from >= Math.min(end, app.state.doc.content.size) - 1) || listChanges(app.state.doc)[0];
    if (next) app.view.dispatch(app.state.tr.setSelection((app.state.selection.constructor as any).create(app.state.doc, next.from, next.to)).scrollIntoView());
  }
}

def([
  {
    id: 'review.accept', label: 'Accept', icon: 'check', tab: 'Review', group: 'Changes', kind: 'split', edits: true, popular: true,
    run: (app, arg) => acceptReject(app, true, arg === 'all' ? 'all' : arg === 'shown' ? 'shown' : 'one', arg === 'next' || arg == null),
    menu: () => [{ id: 'review.accept', arg: 'next', label: 'Accept and Move to Next' }, { id: 'review.accept', arg: 'this', label: 'Accept This Change' }, { id: 'review.accept', arg: 'shown', label: 'Accept All Changes Shown' }, { id: 'review.accept', arg: 'all', label: 'Accept All Changes' }, { id: 'review.acceptAllStop', label: 'Accept All Changes and Stop Tracking' }],
  },
  {
    id: 'review.reject', label: 'Reject', icon: 'close', tab: 'Review', group: 'Changes', kind: 'split', edits: true, popular: true,
    run: (app, arg) => acceptReject(app, false, arg === 'all' ? 'all' : arg === 'shown' ? 'shown' : 'one', arg === 'next' || arg == null),
    menu: () => [{ id: 'review.reject', arg: 'next', label: 'Reject and Move to Next' }, { id: 'review.reject', arg: 'this', label: 'Reject This Change' }, { id: 'review.reject', arg: 'shown', label: 'Reject All Changes Shown' }, { id: 'review.reject', arg: 'all', label: 'Reject All Changes' }, { id: 'review.rejectAllStop', label: 'Reject All Changes and Stop Tracking' }],
  },
  { id: 'review.acceptAll', label: 'Accept All Changes', icon: 'done_all', tab: 'Review', group: 'Changes', edits: true, run: (app) => acceptReject(app, true, 'all') },
  { id: 'review.rejectAll', label: 'Reject All Changes', icon: 'remove_done', tab: 'Review', group: 'Changes', edits: true, run: (app) => acceptReject(app, false, 'all') },
  { id: 'review.acceptAllStop', label: 'Accept All and Stop Tracking', icon: 'done_all', tab: 'Review', group: 'Changes', edits: true, run: (app) => { if (refuseIfProtected(app)) return; acceptReject(app, true, 'all'); setTracking(app, false); } },
  { id: 'review.rejectAllStop', label: 'Reject All and Stop Tracking', icon: 'remove_done', tab: 'Review', group: 'Changes', edits: true, run: (app) => { if (refuseIfProtected(app)) return; acceptReject(app, false, 'all'); setTracking(app, false); } },
  {
    id: 'review.acceptByAuthor', label: 'Accept/Reject by Reviewer…', icon: 'person_search', tab: 'Review', group: 'Changes', edits: true,
    run: async (app) => {
      const all = listChanges(app.state.doc);
      const authors = [...new Set(all.map((c) => c.author))];
      if (!authors.length) { toast('No tracked changes.'); return; }
      if (refuseIfProtected(app)) return;
      const r = await openDialog({ title: 'Changes by Reviewer', fields: [{ key: 'a', label: 'Reviewer', type: 'select', options: authors, value: authors[0] }, { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'accept', label: 'Accept' }, { value: 'reject', label: 'Reject' }], value: 'accept' }] });
      if (r) v(app).dispatch(resolveChanges(app.state, all.filter((c) => c.author === r.a), r.act === 'accept'));
    },
  },
  { id: 'review.prevChange', label: 'Previous Change', icon: 'arrow_back', tab: 'Review', group: 'Changes', noRecord: true, run: (app) => moveChange(app, -1) },
  { id: 'review.nextChange', label: 'Next Change', icon: 'arrow_forward', tab: 'Review', group: 'Changes', noRecord: true, run: (app) => moveChange(app, 1) },
]);

function moveChange(app: App, dir: 1 | -1) {
  const list = listChanges(app.state.doc);
  if (!list.length) { toast('No tracked changes.'); return; }
  const pos = dir > 0 ? app.state.selection.to : app.state.selection.from;
  const c = dir > 0 ? list.find((x) => x.from >= pos) || list[0] : [...list].reverse().find((x) => x.to <= pos) || list[list.length - 1];
  app.view.dispatch(app.state.tr.setSelection((app.state.selection.constructor as any).create(app.state.doc, c.from, c.to)).scrollIntoView());
  app.focus();
}

// ------------------------------------------------------------------------------------------
// Compare / combine / protect

def([
  {
    id: 'review.compare', label: 'Compare Documents…', icon: 'difference', tab: 'Review', group: 'Compare', popular: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Compare Documents', fields: [
        { key: 'orig', label: 'Original document', type: 'select', options: [{ value: 'file', label: 'Choose a file…' }, ...app.docs.map((d, i) => ({ value: String(i), label: d.displayName }))], value: 'file' },
        { key: 'rev', label: 'Revised document', type: 'select', options: [...app.docs.map((d, i) => ({ value: String(i), label: d.displayName })), { value: 'file', label: 'Choose a file…' }], value: String(app.docs.indexOf(app.tab)) },
        { key: 'label', label: 'Label changes with', type: 'text', value: app.prefs.author },
      ] });
      if (!r) return;
      const load = async (sel: string): Promise<PMNode | null> => {
        if (sel !== 'file') return app.docs[+sel].view.state.doc;
        const { openDocument, OPEN_ACCEPT, OPEN_MIMES } = await import('../platform/native');
        const { importFile } = await import('../io');
        const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
        return f ? (await importFile(f.data, f.name)).doc : null;
      };
      const a = await load(r.orig), b = await load(r.rev);
      if (!a || !b) return;
      const doc = compareDocs(a, b, r.label || 'Compare');
      app.createTab(doc, { title: 'Compare Result', fileName: 'Compare Result.docx' });
      app.ui.openPane('revisions');
    },
  },
  {
    id: 'review.combine', label: 'Combine Revisions…', icon: 'merge_type', tab: 'Review', group: 'Compare', edits: true,
    run: async (app) => {
      if (refuseIfProtected(app)) return;
      const tab = app.tab;
      toast('Choose the revised copy to combine into this document.');
      const { openDocument, OPEN_ACCEPT, OPEN_MIMES } = await import('../platform/native');
      const { importFile } = await import('../io');
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      const other = (await importFile(f.data, f.name)).doc;
      if (!app.docs.includes(tab)) return;
      tab.view.dispatch(combineTr(tab.view.state, other, f.name.replace(/\.[^.]+$/, '')));
    },
  },
  { id: 'review.compareVersions', label: 'Compare with Saved Version…', icon: 'history', tab: 'Review', group: 'Compare', run: (app) => app.ui.openPane('versions') },
  {
    id: 'review.restrictEditing', label: 'Restrict Editing…', icon: 'shield_lock', tab: 'Review', group: 'Protect', popular: true,
    run: async (app) => {
      const p = app.settings.protection;
      const r = await openDialog({ title: 'Restrict Editing', help: 'Restriction is advisory: it prevents accidental changes in Anne\'s Pen, but anyone can edit the file with another program.', fields: [
        { key: 'mode', label: 'Allow only this type of editing', type: 'radio', options: [{ value: 'none', label: 'No restrictions' }, { value: 'tracked', label: 'Tracked changes' }, { value: 'comments', label: 'Comments' }, { value: 'forms', label: 'Filling in forms' }, { value: 'readonly', label: 'No changes (read only)' }], value: p.mode },
        { key: 'pw', label: 'Password (optional)', type: 'password', value: '' },
      ] });
      if (!r) return;
      // Changing the mode or the password needs the current password.
      if (p.hash && (r.mode !== p.mode || r.pw)) {
        const pw = await promptDialog(r.mode !== p.mode ? 'Unprotect Document' : 'Change Password', 'Current password:', '', { type: 'password' });
        if (pw == null || !(await verifyPassword(pw, p.hash))) { toast('Incorrect password.'); return; }
      }
      const hash = r.pw ? await hashPassword(r.pw) : r.mode === 'none' ? undefined : p.hash;
      const tr = app.state.tr.setDocAttribute('settings', { ...JSON.parse(JSON.stringify(app.settings)), protection: { mode: r.mode, hash } }).setMeta('allowProtected', true).setMeta('trackSkip', true);
      v(app).dispatch(tr);
      app.view.setProps({});
      toast(r.mode === 'none' ? 'Protection removed' : `Protection: ${r.mode}`);
    },
  },
  {
    id: 'review.markFinal', label: 'Mark as Final', icon: 'verified', tab: 'Review', group: 'Protect', kind: 'toggle',
    run: (app) => {
      const on = !app.settings.markedFinal;
      v(app).dispatch(app.state.tr.setDocAttribute('settings', { ...JSON.parse(JSON.stringify(app.settings)), markedFinal: on }).setMeta('allowProtected', true).setMeta('trackSkip', true));
      app.view.setProps({});
      toast(on ? 'Marked as final (read-only). Toggle again to edit.' : 'Editing enabled');
    },
    isActive: (app) => app.settings.markedFinal,
  },
  { id: 'review.hideInk', label: 'Hide Ink', icon: 'ink_eraser', tab: 'Review', group: 'Ink', kind: 'toggle', run: (app) => { app.tab.el.classList.toggle('qf-hide-ink'); app.refresh(); }, isActive: (app) => app.tab.el.classList.contains('qf-hide-ink') },
]);

/** Combine Revisions as one undoable change to the current document: this document's settings (comments,
 *  styles, page setup, protection) stay, unchanged text keeps its own formatting and comments, and the
 *  revised copy's differences appear as tracked changes. compareDocs keeps its second argument's version of
 *  unchanged text, so the revised copy is compared back to this one and the new changes (revision marks,
 *  and the change attribute of block objects) are then flipped. */
export function combineTr(state: EditorState, other: PMNode, label: string): Transaction {
  const t0 = Date.now();
  const merged = compareDocs(other, state.doc, label);
  const t1 = Date.now();
  const made = (a: { author?: string; date?: number }) => a.author === label && a.date! >= t0 && a.date! <= t1;
  const flip = (m: Mark) => (!(m.type === M.insertion || m.type === M.deletion) || !made(m.attrs) ? m : m.type === M.insertion ? M.deletion.create(m.attrs) : M.insertion.create(m.attrs));
  const swap = (n: PMNode): PMNode => {
    const c = n.attrs.change;
    let out = c && made(c) ? n.type.create({ ...n.attrs, change: { ...c, kind: c.kind === 'insertion' ? 'deletion' : 'insertion' } }, n.content, n.marks) : n;
    if (n.content.size) { const kids: PMNode[] = []; n.forEach((k) => kids.push(swap(k))); out = out.copy(Fragment.fromArray(kids)); }
    return n.marks.length ? out.mark(Mark.setFrom(n.marks.map(flip))) : out;
  };
  const content: PMNode[] = [];
  merged.forEach((n) => content.push(swap(n)));
  const s = JSON.parse(JSON.stringify(normalizeSettings(state.doc.attrs.settings)));
  for (const [id, c] of Object.entries(normalizeSettings(other.attrs.settings).comments)) if (!s.comments[id]) s.comments[id] = c;
  return state.tr.replaceWith(0, state.doc.content.size, content).setDocAttribute('settings', s).setMeta('trackSkip', true);
}

/** Hash used for Restrict Editing passwords (also used by Developer ▸ Protect for Form Filling). */
export async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('quillpen:' + s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
