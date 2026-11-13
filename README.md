# Anne's Pen

*Part of the Anne's Office suite: **Anne's Pen** (documents), [Anne's Grid](https://github.com/socrtwo/QuillGrid) (spreadsheets), [Anne's Post](https://github.com/socrtwo/QuillPost) (email) and [Anne's Stage](https://github.com/socrtwo/QuillStage) (presentations). Formerly named QuillForge: its .qfd/.qfde documents open, and the desktop and web apps keep its settings and drafts. On Android and iOS Anne's Pen installs as a new app; [docs/INSTALL.md](docs/INSTALL.md#coming-from-quillforge) shows how to move documents and settings over.*

An original, open-source word processor for Android (and the web) whose goal is simple: **no missing commands**. Every feature is a command, and every command can be put on the Quick Access Bar, on your own tab, on a keyboard shortcut, or in a macro, which is the full-library customization that mobile and online office apps leave out.

- **823 commands** across File, Home, Insert, Draw, Design, Layout, References, Mailings, Review, View, Tools, **AI**, Developer and Help, plus contextual Table Design, Table Layout and Picture Format tabs. See [docs/COMMANDS.md](docs/COMMANDS.md).
- **Opens damaged documents** with the [Word Recovery](https://github.com/socrtwo/wordrecovery-SF) engine: byte-level ZIP salvage, XML repair, Word 97–2003 binary text, and Open and Repair / Recover Text from Any File. See [docs/RECOVERY.md](docs/RECOVERY.md).
- **AI tab** with 70 commands surveyed from other word processors and writing tools. It offers a free on-device model (no account) and a setup wizard for free and paid providers that opens the right page in your browser and picks up the key. Requests can go to several AIs at once, with one combining their answers or all of them deliberating until they agree (a Quaker-style consensus). See [docs/AI.md](docs/AI.md).
- **Quick Access Bar chooser** with the desktop-style categories: *Popular Commands*, *Commands Not in the Tabs*, *All Commands*, each tab, and *Macros*. You can add separators, reorder, reset, and import or export the layout. Long-press any ribbon button to add it, and the bar can sit at the top or at the bottom near the keyboard.
- **Customize Tabs:** create tabs and groups, put any command in them, rename, reorder or hide built-in tabs.
- **Customize Keyboard:** rebind any command, with conflict display.
- **Command search** (Alt+Q or the 🔍 button) across the whole library.

## Install

Each [release](../../releases) has builds for:
- **Windows** (installer for x64 or ARM, or portable);
- **macOS** (universal);
- **Linux** (AppImage or .deb for x64, arm64 and armv7l, which covers **Raspberry Pi OS**);
- **ChromeOS** (Android app, Linux app or web app);
- **Android** (APK);
- **iOS/iPadOS** (an unsigned .ipa you sign with your Apple ID);
- the **web** (static files; offline-capable and installable).

[docs/INSTALL.md](docs/INSTALL.md) has the steps for each. To build it yourself, including the APK on the phone itself with Termux, see [docs/BUILD.md](docs/BUILD.md).

On Android, Anne's Pen registers for *Share to* on .docx, .doc, .odt, .rtf, .md, .txt, .html and .epub files (and plain text), and for *Open with* on those plus .qpd, WordPerfect, Works, Write, Lotus, Hangul, MacWrite, ClarisWorks, WordStar, XyWrite, .eml, .msg and MHTML files. It uses the Android system file picker, so files on the device, SD card, Google Drive, Dropbox and similar providers all work. **Save** writes back to the same file.

## Features

**Writing and formatting.** You get a full character format set:
- underline styles and colors, double strikethrough, small and all caps, hidden text;
- character spacing, scale and position;
- OpenType ligatures, number forms, kerning and stylistic sets;
- text effects, character borders and shading, phonetic guides.

Paragraph controls cover alignment, indents, spacing, line rules, keep-with-next, keep-lines-together, page break before, widow/orphan control, borders and shading, tab stops and drop caps. Lists can be bulleted (custom bullets), numbered (many formats), multilevel outline, or checklists. A style system offers 78 built-in styles, 10 style sets (Anne's Pen, Classic, Modern, Elegant, Book, Manuscript, Academic, Technical, Newsletter, Typewriter) and themes. You can create, modify and inspect styles.

**Pages.** Print Layout shows real pages with:
- automatic pagination that splits paragraphs across pages and honors widow/orphan and keep rules;
- headers and footers with fields, first-page and odd/even variants;
- footnotes at the foot of each page;
- watermarks, page borders and line numbers;
- multi-column sections, section/page/column breaks, page sizes and margins, and mirrored margins.

Mobile View reflows text at real font sizes for phones. There are also Web Layout, Read Mode, Outline (collapsible headings, promote and demote, move sections), Draft, and Focus views.

**Insert.** Tables (including quick tables), pictures with resize, rotate, crop and filters, 42 shapes, diagrams, charts, icons, equations (LaTeX via KaTeX), symbols and emoji, links, bookmarks, cross-references, fields, text boxes and sidebars, building blocks, signature lines, cover pages, smart chips, and content controls.

**References.** Table of contents, footnotes and endnotes, citations with a source manager (APA, MLA, Chicago, Turabian, Harvard, IEEE, ISO 690, GB 7714; BibTeX import and export), bibliography, captions, table of figures, index and concordance auto-marking, and a table of authorities.

**Mailings.** Mail merge from typed lists, CSV/TSV files or an in-document table. Address block, greeting line, IF / Fill-in / record rules, preview, finishing to a merged document, envelopes and labels.

**Review.** Track changes (accept or reject by change, by reviewer, or all), simple/all/no-markup/original views, threaded comments with replies, reactions and resolve, compare and combine documents, spelling and grammar checks (offline Hunspell dictionaries for American, British, Canadian and Australian English; see *English spelling* below), an online thesaurus and dictionary, word count, readability statistics, an accessibility checker, read aloud, dictation, Restrict Editing, and Mark as Final.

**English spelling.** By default the spelling check accepts every major variety of English, so *colour* and *color*, *organise* and *organize*, and *theatre* and *theater* are all correct. You can change this in **Review ▸ English Spelling** or **File ▸ Options**:
- check one variety: American; British (with Oxford *-ize* spellings); Canadian; or Australian;
- or follow each document's language. Text marked with its own variety (for example, a British quotation in an American document) is then checked against that variety.

### Spelling in other languages

**Review ▸ Spelling Dictionaries** is a wizard for free dictionaries in 90+ languages and regional varieties:
- 21 Spanish varieties, 3 German, 2 Portuguese, Catalan and Valencian, Serbian in Cyrillic and Latin, Polytonic Greek;
- Hebrew, Persian, Korean, Ukrainian, Russian, Basque, Irish, Welsh, Latin, Esperanto, and many more.

It shows:
- the languages of your device and of the open document first;
- each dictionary's size, license and memory use.

It downloads a dictionary only when you ask, verifies it against a published checksum, and keeps it on the device for offline use. One click then sets it as the document language or marks the selected text with it.

Downloaded dictionaries run on Hunspell, the engine LibreOffice and Firefox use, compiled to WebAssembly. Compounds (German) and elisions (French *l'homme*) work as in those programs. Text in a language with no installed dictionary is skipped rather than marked wrong.

Ireland, India, South Africa and other countries that follow British spelling use the British dictionary. New Zealand uses the Australian one, and the Philippines the American one. Text marked as another language is not checked against English rules. The grammar check accepts each variety's usage before an *h* (*an historic*, *a herb*). AI commands keep the author's variety unless you choose one.

**Developer.** Macro recorder (records commands and typing), a JavaScript macro editor with a document API, and content controls with form protection and CSV export of form data.

**Files.** Import and export .docx, .odt, .fodt, .rtf, .html, Markdown (GFM), .txt, .epub, and the native .qpd format. Files are recognized by their content, whatever their name or extension: a WordPerfect file called .doc, or a file with no extension at all, opens as what it is, with a short note when the name disagrees. Historical word processors open with their formatting: Word 1.x–2003 for Windows (including 6.0/95 and East Asian editions), Word for DOS, Windows Write, Word for Macintosh, WordPerfect 4.2–X9, Microsoft Works, Kingsoft WPS, Ami Pro, Lotus Word Pro, MacWrite, WriteNow, ClarisWorks, WordStar, XyWrite, DisplayWrite (DCA-RFT), MultiMate and Hangul (HWP). Spreadsheets (Excel, OpenDocument, CSV, dBASE, Lotus 1-2-3), presentations (PowerPoint, OpenDocument) and email (.eml, .msg, mbox, MHTML, winmail.dat) can be handed to the sister apps Anne's Grid, Anne's Stage and Anne's Post, or imported as tables, slide sections or a message. See [docs/FORMATS.md](docs/FORMATS.md) for every format, its detection signature and its fidelity. AES-256 encrypted .qpde is also supported. PDF goes through the system print service ("Save as PDF"). Other features: autosave drafts with crash recovery, version history snapshots with compare and restore, document inspector, templates, and multiple open documents in tabs.

### Innovations from other word processors

| Feature | Inspired by |
|---|---|
| Reveal Codes pane | WordPerfect |
| Navigator-style outline with move up/down/promote/demote, chapter (heading) numbering, hidden paragraphs, style inspector, regex find and replace, word completion | LibreOffice Writer |
| Smart chips, suggesting-mode workflow, Markdown auto-formatting, version history, voice typing | Online document editors |
| Focus mode (sentence/paragraph/line), typewriter scrolling, writing goals | iA Writer, Ulysses, Scrivener |
| Snapshots and compare | Scrivener |
| Slash (/) command menu, checklists | Notion and note-taking apps |
| Writing-style highlighting (long sentences, adverbs, passive voice, weak phrases) | Hemingway-style editors |
| Teleprompter, distraction-free mode | Presenter and writing apps |
| Spike, Calculate, Extend selection (F8) | Classic desktop word processors |
| OCR clean-up (join broken lines, de-hyphenate, strip running heads and page numbers, ligature fixes), typographic clean-up, sort/dedupe/extract tools | Publishing and OCR workflows |
| Metric-compatible open fonts substituted for Calibri, Cambria, Times New Roman, Arial, Courier New, Georgia and Garamond | Document-fidelity practice in open-source suites |

**Recovery.** When a document is damaged, Anne's Pen recovers it instead of refusing to open it. The engine is the Word Recovery pipeline: S2 file identification, local-header ZIP salvage with ImmortalInflate, CRC checks, InvalidTags → ValidTags fixes, XML healing, an RTF parser, Word 97 piece-table text, and a strings scan. A repaired package re-opens with its formatting, and the recovery report lists what each method found.

**AI.** The AI tab can draft, continue writing and rewrite (with alternatives), change tone or style, edit by instruction, shorten, expand, and turn text into lists or tables. It also proofreads and repairs OCR as tracked changes, and gives clarity and style-guide notes as comments. It can summarize, list action items and answer questions about the document. It translates a selection, a whole document or side-by-side. It suggests sources and flags claims to verify. It gives editor feedback, reader reactions and rubric grades, writes alt text, transcribes images, keeps story notes, and has a prompt library. With **several AIs** chosen (AI ▸ Choose AIs), each request goes to all of them: either one AI (the master) combines their answers, or they deliberate in a Quaker-style consensus, where a clerk words the answer and each AI unites with it, stands aside or blocks until no one blocks. The AI pane can show how each AI answered; only the final answer goes into the document.

Providers:
- An on-device model (free, private, offline after one download).
- Chrome's built-in model.
- Free tiers: OpenRouter, Gemini, Groq, Mistral, Cerebras, SambaNova, Z.ai, NVIDIA, Cloudflare; free trial keys: Cohere, Fireworks, Qwen.
- Ollama or LM Studio on your computer.
- Paid keys: OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Together, Fireworks, Hugging Face, Moonshot, Qwen, Cohere, Azure, Bedrock, or any OpenAI-compatible service.

Keys are stored encrypted on the device (Android Keystore; on desktops the system keychain, or unencrypted where Linux has none), and nothing is sent until you use an AI command.

## Known limitations

- Pagination splits paragraphs but does not split tables or images across pages. A block taller than a page overflows it. Section breaks do not change page size or orientation mid-document; one page setup applies to the whole document.
- Footnote, endnote and comment bodies are plain text.
- Formatting changes are not tracked as revisions; insertions and deletions are.
- The thesaurus, dictionary and translate commands need an internet connection.
- Spelling works offline. English is built in; other languages need a one-time download (Review ▸ Spelling Dictionaries). The South African English dictionary (LGPL-licensed) is a download, not built in; until it is installed, South African English uses the British dictionary.
- Grammar rules are English-only.
- Charts and diagrams are stored as images with editable data. Other suites see them as pictures.
- DOCX fidelity was verified with LibreOffice, pandoc and python-docx. It has not been tested in Microsoft Word itself.
- Legacy formats are imported, not saved: saving makes a new .docx (or another current format). Some rarely used features of those formats are not imported; docs/FORMATS.md lists them.
- Recovery: text after a damage point inside one deflate stream is unreliable and is set apart as "unverified". Encrypted Office files are detected, not decrypted.
- AI: the on-device model, Android OAuth listener and native clipboard and Keystore code have not yet been tried on a physical device. The AI request formats, streaming, errors and the wizard are tested against a mock server.

## Build

```bash
npm ci
npm run dev          # web app at http://localhost:5173
npm test             # unit tests (vitest)
npm run build        # production web build in dist/ (first writes public/third-party-notices.txt)
npm run android:build   # build + cap sync + gradle assembleRelease (needs Android SDK)
npm run desktop         # run the desktop app (Electron); desktop:dist builds installers
npm run ios:sync        # web build into the Xcode project (ios/)
```

CI type-checks, runs the unit and browser tests (`.github/workflows/ci.yml`) and builds a debug-signed APK and AAB (`.github/workflows/android.yml`) on every push. The **Release** workflow (`.github/workflows/release.yml`) builds every platform and publishes them together: push a tag `v<version>` matching `package.json`, or run it from the Actions tab on `main`. See [docs/BUILD.md](docs/BUILD.md#releases).

Browser checks: `npm run e2e:all` builds, serves the build with `vite preview` on a free port and runs the smoke, UI-hardening, all-commands (every command and menu variant), io, visual and offline (PWA) tests. After a build, `npm run e2e:<name>` runs one of them, as well as `e2e:ai` (AI features against a mock OpenAI/Anthropic/Gemini server) and `e2e:dictionaries` (downloads a real dictionary). The desktop app: `xvfb-run -a node tests/e2e/desktop.mjs`. Layout on phones (system bars, keyboard, 320–915 px): `npm run e2e:layout` (starts its own dev server).

Anne's Post, the suite's email app, can use this editor for message bodies: see [docs/EMBED.md](docs/EMBED.md).

## Project language

The interface, code comments and documentation use American English. The app itself treats all varieties of English as correct by default, as described above.

## Legal

Anne's Pen is an independent, clean-room project released under the MIT License. It is not affiliated with, endorsed by, or sponsored by Microsoft, Google, Apple, Corel, The Document Foundation, any AI provider, or any other vendor. Product names appear only to describe file-format compatibility or the origin of an idea (nominative use). The interface, icons (Material Symbols, Apache 2.0), templates, styles and text are original or openly licensed. See [docs/LEGAL.md](docs/LEGAL.md).
