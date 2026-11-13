# Opening damaged documents

Anne's Pen includes the recovery engine from [Word Recovery (socrtwo/wordrecovery-SF)](https://github.com/socrtwo/wordrecovery-SF), ported to TypeScript and extended. It runs automatically whenever a .docx, .docm, .doc, .odt, .rtf, .epub or .fodt file fails to open normally. It also runs when a large package opens with no content. You can also start it on purpose:

- **File ▸ Open ▸ Open and Repair…** runs every recovery method, even on a file that opens, and shows the report.
- **File ▸ Open ▸ Recover Text from Any File…** extracts readable text from any file: damaged documents, Word backup (.wbk) and AutoRecover (.asd) files, `~WRD*.tmp` temp files, or unknown data.
- **File ▸ Recovery Report** shows how the current document was recovered.
- **File ▸ Manual Recovery Options** is a guide for each platform: AutoRecover folders, version history, Shadow Copies, Time Machine, command-line tools, and the other S2 recovery tools.

A recovered document opens as "*name* (Recovered)". **Save** asks for a new name, so the damaged original is never overwritten.

## The pipeline

| Step | Method | From Word Recovery? |
|---|---|---|
| 0 | **S2 File Identifier:** magic-number identification; finds and separates embedded or concatenated files (for example a PDF fused onto a DOCX); recommends the right S2 tool for each foreign piece | Yes: a port of Word Recovery's `s2-file-id.js` (in the upstream project), here `src/io/recover/fileid.ts` |
| 1 | **Standard parse:** open the package and verify each part's CRC-32 (damaged deflate data often decompresses without an error) | Yes, plus CRC checks |
| 2 | **Byte-level ZIP recovery:** walk `PK\x03\x04` local headers and ignore the central directory; inflate each entry with **ImmortalInflate**, a decoder that never throws, at bit shifts 0–47 | Yes, plus declared-size use, CRC checks and deflate-block resync |
| 3 | **XML repair:** the original InvalidTags → ValidTags substitutions for `word/document.xml`, then `healXMLStrict`, then a new tag-soup rebuilder (mis-nested and truncated elements, stray `&`, duplicate attributes, undeclared prefixes) | Yes, plus the rebuilder |
| 3a | **Damage cut:** in a part known to be damaged, keep the consistent prefix. Text decoded after the damage goes in a marked "unverified" section at the end, because LZ77 copies damage forward | New |
| 4 | **RTF extraction:** a full control-word parser (`\uN`, `\'hh`, `\binN`, ignorable destinations) | Yes, rewritten |
| 5 | **Word 97–2003 binary:** OLE2 compound file → FIB → piece table, CP1252 or UTF-16 text; field codes dropped and results kept; cell and row marks become tabs and lines. Fallbacks: contiguous sectors when the FAT is broken, a directory scan, a FIB scan, a search for the piece table, or the fcMin text run | New (the original used a strings scan for .doc) |
| 6 | **Strings scan:** printable ASCII and UTF-16LE runs, as a last resort | Yes |

When the package can be rebuilt, the repaired parts are re-zipped with valid `[Content_Types].xml` and relationships, then opened with the normal DOCX/ODT importer. So styles, lists, tables, images, notes and comments survive wherever their parts did. Otherwise the best recovered text opens as a plain document. The report offers **Save repaired .docx**, **Open recovered text**, **Copy text** and **Save text**.

## What was tested

`tests/unit/recover.test.ts` builds damaged files from real fixtures (`tests/fixtures/recovery/sample.docx` and `sample.doc`, made with LibreOffice) and checks each case:

- truncated packages;
- a zeroed end-of-central-directory record;
- a missing central directory;
- garbage before the archive;
- a PDF appended to the archive;
- malformed `document.xml` (mis-nesting, a bare `&`, truncation);
- CRC damage that inflates without error;
- corrupted compressed data in the middle of `document.xml` inside an otherwise intact archive;
- a `.doc` with a destroyed FAT;
- RTF and arbitrary bytes.

The engine is also checked against a real-world damaged .docx that is held privately for testing and is not distributed with the project. That file has a stale local header and compressed data that breaks off partway through `document.xml`. That test found two defects, both now fixed:

- intact parts were reported as damaged, because JSZip reads the stored CRC-32 as a signed number and the check compared it with an unsigned one;
- the user saw the raw decompressor message.

Anne's Pen now recovers that file's formatted text, table and bold runs up to the break and marks where the document ends.

## Limits

- **Damaged deflate data:** text after the damage point in the same deflate stream is unreliable; it is kept, clearly marked, at the end. Data in later, undamaged deflate blocks is recovered when the decoder can resynchronize. When nothing after the damage can be recovered, a red notice marks where the document breaks off. The last words before it may be garbled, so check them against another copy.
- **.doc files** open as text and paragraph structure, with tables as tab-separated lines. Character and paragraph formatting is not read. Save as .docx to keep the text.
- **Password-protected files** (encrypted .doc or .docx) are detected and reported; they cannot be decrypted.
