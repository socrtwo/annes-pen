/**
 * Character-encoding detection for plain-text-like files (text, Markdown and other markups,
 * CSV) that carry no declaration.
 *
 * Order: byte-order marks (UTF-8, UTF-16 LE/BE, UTF-32 LE/BE); BOM-less UTF-16 from the
 * pattern of zero bytes; strict UTF-8; then legacy candidates scored on the decoded text.
 * Multi-byte East Asian encodings (Shift_JIS, EUC-JP, GBK/GB18030, Big5, EUC-KR) must decode
 * without errors and are scored on how much of the result is common CJK text. Single-byte
 * encodings (Windows-125x, ISO-8859-x, KOI8-R, Mac OS Roman, IBM PC code pages 437/850/866)
 * are scored on whether non-ASCII characters form plausible words (letters inside words,
 * lower case within lower-case words, Cyrillic case balance, box drawing in runs for DOS
 * files). Code pages 437 and 850 are decoded from built-in tables because browsers'
 * TextDecoder does not provide them.
 */

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';
const CP850_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

function decodeTable(u8: Uint8Array, high: string): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i] < 0x80 ? String.fromCharCode(u8[i]) : high[u8[i] - 0x80];
  return s;
}

// Windows-1252 0x80–0x9F (some runtimes decode the label as ISO-8859-1, leaving C1 controls).
const CP1252_C1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

/** Decode with a label, including the built-in IBM PC code pages; null when unsupported or invalid (fatal). */
export function decodeAs(u8: Uint8Array, label: string, fatal = false): string | null {
  const l = label.toLowerCase();
  if (l === 'windows-1252' || l === 'cp1252' || l === 'iso-8859-1' || l === 'latin1' || l === 'us-ascii' || l === 'ascii') {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x4000) {
      const chunk = u8.subarray(i, i + 0x4000);
      let part = '';
      for (let k = 0; k < chunk.length; k++) { const b = chunk[k]; part += b >= 0x80 && b < 0xa0 ? CP1252_C1[b - 0x80] : String.fromCharCode(b); }
      s += part;
    }
    return s;
  }
  if (l === 'cp437' || l === 'ibm437' || l === '437') return decodeTable(u8, CP437_HIGH);
  if (l === 'cp850' || l === 'ibm850' || l === '850') return decodeTable(u8, CP850_HIGH);
  if (l === 'utf-32le' || l === 'utf-32be') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let s = '';
    for (let i = 0; i + 3 < u8.length; i += 4) { const cp = dv.getUint32(i, l === 'utf-32le'); s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�'; }
    return s;
  }
  try {
    return new TextDecoder(l, { fatal }).decode(u8);
  } catch {
    return null;
  }
}

const SINGLE_BYTE = ['windows-1252', 'windows-1250', 'windows-1251', 'koi8-r', 'ibm866', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'iso-8859-2', 'macintosh', 'cp437', 'cp850'];
const MULTI_BYTE = ['shift_jis', 'euc-jp', 'gbk', 'big5', 'euc-kr'];

// The most frequent Chinese characters in simplified and traditional text (shared ones appear in both).
const COMMON_SC = '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尼故乐江';
const COMMON_TC = '的一是不了在人有我他這個們中來上大為和國地到以說時要就出會可也你對生能而子那得於著下自之年過發後作裡用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實日軍者意無力它與長把機十民第公此已工使情明性知全三又關點正業外將兩高間由問很最重並物手應戰向頭文體政美相見被利什二等產或新己製身果加西斯月話合回特代內信表化老給世位次度門任常先海通教兒原東聲提立及比員解水名真論處走義各入幾口認條平系氣題活爾更別打女變四神總何電數安少報才結反受目太量再感建務做接必場件計管期市直德資命山金指克許統區保至隊形社便空決治展馬科司五基眼書非則聽白卻界達光放強即像難且權思王象完設式色路記南品住告類求據程北邊死張該交規萬取拉格望覺術領共確傳師觀清今切院讓識候帶導爭運笑飛風步改收根乾造言聯持組每濟車親極林服快辦議往元英士證近失轉夫令準布始怎呢存未遠叫台單影具羅字愛擊流備兵連調深商算質團集百需價花黨華城石級整府離況亞請技際約示復病息究線似官火斷精滿支視消越器容照須九增研寫稱企八功嗎包片史委乎查輕易早曾除農找裝廣顯吧阿李標談吃圖念六引歷首醫局突專費號尼故樂江';

const isLetter = (c: string) => /\p{L}/u.test(c);
/** Non-ASCII Latin letters in everyday use in European languages; others score lower. */
const COMMON_LATIN = new Set([...'éèàçêëôöüäßñáíóúãõâîûïåæøœÉÈÀÇÊÖÜÄÑÁÍÓÚÅÆØčřšžěůýąęłśźżćńőűășțğıšžČŘŠŽĚŮÝĄĘŁŚŹŻĆŃŐŰĂȘȚĞİ']);
/** Single non-ASCII letters that are words by themselves. */
const LONE_WORDS = new Set([...'àéèóòùíúåöäüçâêôýáųąęłАаВвСсКкУуИиОоЯяΗηΟοΤτ']);
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

const asciiAlnum = (x: number) => (x >= 0x30 && x <= 0x39) || (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a);
const blank = (x: number | undefined) => x === undefined || x === 0x20 || x === 0x09 || x === 0x0a || x === 0x0d;

/**
 * Share of the high bytes that are Windows punctuation (0x85, 0x91–0x97) placed the way
 * typography places it: apostrophes in or at the edge of words, quotes opening and closing
 * words, dashes between words, an ellipsis after a word.
 */
function cp1252Typography(u8: Uint8Array): number {
  let high = 0, typo = 0;
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b < 0x80) continue;
    high++;
    if (b !== 0x85 && (b < 0x91 || b > 0x97 || b === 0x95)) continue;
    const p = i ? u8[i - 1] : undefined, n = u8[i + 1];
    const lp = p !== undefined && asciiAlnum(p), ln = n !== undefined && asciiAlnum(n);
    const closeP = p !== undefined && (lp || p === 0x2e || p === 0x2c || p === 0x21 || p === 0x3f || p === 0x85 || p === 0x92);
    let ok = false;
    if (b === 0x92) ok = lp || ln; // it’s, James’, ’90s
    else if (b === 0x91 || b === 0x93) ok = !lp && (ln || n === 0x91); // ‘opening, “opening
    else if (b === 0x94) ok = closeP && !ln; // closing”
    else if (b === 0x96 || b === 0x97) ok = (blank(p) || lp) && (blank(n) || ln);
    else if (b === 0x85) ok = (closeP || blank(p)) && (blank(n) || n === 0x94 || n === 0x92 || n === 0x22 || n === 0x27);
    if (ok) typo++;
  }
  return high ? typo / high : 0;
}

/** Plausibility of decoded single-byte text (higher is better); null when nothing non-ASCII. */
function scoreSingle(s: string, label: string, typography = 0): number | null {
  let high = 0, score = 0;
  let cyrLower = 0, cyrUpper = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    if (code < 0x80) continue;
    high++;
    const prev = s[i - 1] || ' ', next = s[i + 1] || ' ';
    if (code >= 0x80 && code <= 0x9f) { score -= 5; continue; }
    if (c === '�') { score -= 5; continue; }
    if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0370 && code <= 0x03ff)) { if (isLower(c)) cyrLower++; else if (isUpper(c)) cyrUpper++; }
    if (isLetter(c)) {
      const latin = code < 0x0250;
      score += latin && !COMMON_LATIN.has(c) ? 0.2 : 1;
      if (c === prev && c === next) score -= 3; // "ddd": a ruled line in another code page
      if (!isLetter(prev) && !isLetter(next) && !LONE_WORDS.has(c)) score -= 2;
      const inWord = isLetter(prev) && isLetter(next);
      if (inWord) score += 1.5;
      if (isUpper(c) && isLower(prev) && (isLower(next) || !isLetter(next))) score -= 3.5;
      // Greek/Hebrew/Arabic letters mixed into Latin words are implausible.
      if (inWord && /[a-z]/i.test(prev + next) && !/[À-ɏ]/.test(c)) score -= 3.5;
      continue;
    }
    if (code >= 0x2500 && code <= 0x259f) {
      const run = (prev.charCodeAt(0) >= 0x2500 && prev.charCodeAt(0) <= 0x259f) || (next.charCodeAt(0) >= 0x2500 && next.charCodeAt(0) <= 0x259f) || /[ \n\r]/.test(prev + next);
      score += run ? 0.6 : -2;
      continue;
    }
    if (/[“”‘’–—…«»°£€¢©®™§¶•·×÷±½¼¾¿¡\u00a0]/.test(c)) { score += isLetter(prev) && isLetter(next) && !/[’‘·\u00a0]/.test(c) ? -1.5 : 0.4; continue; }
    // Other symbols are rare in prose; inside a word they betray the wrong code page.
    score -= isLetter(prev) && isLetter(next) ? 3 : 1;
  }
  if (!high) return null;
  let norm = score / high;
  if (cyrLower + cyrUpper > 4) norm += ((cyrLower - cyrUpper) / (cyrLower + cyrUpper)) * ((cyrLower + cyrUpper) / high); // prose is mostly lower case
  // Gentle priors: Windows-1252 is the most common legacy encoding; MacRoman/DOS need evidence.
  if (label === 'windows-1252') norm += 0.15;
  // Smart quotes, apostrophes and dashes are the same in every Windows code page.
  if (label.startsWith('windows-')) norm += 3 * typography;
  if (label === 'iso-8859-2') norm -= 0.05;
  if (label === 'cp850') norm -= 0.02;
  return norm;
}

function scoreMulti(s: string, label: string): number {
  let nonAscii = 0, cjk = 0, kana = 0, hangul = 0, halfKana = 0, sc = 0, tc = 0, han = 0;
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (code < 0x80) continue;
    nonAscii++;
    if (code >= 0x3040 && code <= 0x30ff) { kana++; cjk++; }
    else if (code >= 0xac00 && code <= 0xd7af) { hangul++; cjk++; }
    else if (code >= 0x4e00 && code <= 0x9fff) { han++; cjk++; if (COMMON_SC.includes(c)) sc++; if (COMMON_TC.includes(c)) tc++; }
    else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff01 && code <= 0xff5e)) cjk++;
    else if (code >= 0xff61 && code <= 0xff9f) halfKana++;
  }
  if (!nonAscii) return 0;
  let score = cjk / nonAscii - (halfKana / nonAscii) * 0.8;
  if (label === 'shift_jis' || label === 'euc-jp') score += kana ? 0.3 * Math.min(1, (kana * 4) / nonAscii) : -0.1;
  if (label === 'euc-kr') score += hangul ? 0.3 : -0.3;
  if (label === 'gbk') score += han ? (sc / han) * 0.6 - 0.05 : -0.2;
  if (label === 'big5') score += han ? (tc / han) * 0.6 - 0.1 : -0.2;
  // Chinese prose is full of the most frequent characters; rare ones only are a misread.
  if ((label === 'gbk' || label === 'big5') && han >= 3 && !kana && !hangul && (label === 'gbk' ? sc : tc) < han * 0.1) score -= 0.5;
  return score;
}

export interface Detected { encoding: string; text: string; confidence: number }

/** Script ranges real text is written in (a code unit outside all of them is suspect). */
const BLOCKS: [number, number][] = [
  [0x0000, 0x007f], [0x0080, 0x024f], [0x0250, 0x036f], [0x0370, 0x03ff], [0x0400, 0x052f], [0x0530, 0x058f], [0x0590, 0x05ff], [0x0600, 0x06ff],
  [0x0900, 0x0dff], [0x0e00, 0x0e7f], [0x1e00, 0x1fff], [0x2000, 0x206f], [0x2100, 0x21ff], [0x2500, 0x25ff], [0x3000, 0x30ff], [0x3100, 0x31ff],
  [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef],
];
const HAN_BLOCK = 16;

function blockOf(u: number): number {
  for (let k = 0; k < BLOCKS.length; k++) if (u >= BLOCKS[k][0] && u <= BLOCKS[k][1]) return k;
  return -1;
}

/** True when the bytes decode as UTF-8 (a sequence cut at the end is allowed). */
function utf8Valid(u8: Uint8Array): boolean {
  let end = u8.length;
  let k = 0;
  while (k < 3 && end > 0 && (u8[end - 1] & 0xc0) === 0x80) { end--; k++; }
  if (end > 0 && u8[end - 1] >= 0xc0) end--;
  else end = u8.length;
  try { new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(0, end)); return true; } catch { return false; }
}

/** How well UTF-16 code units read as text: 0 when invalid, else the share in the three main scripts. */
function utf16Score(u8: Uint8Array, le: boolean): number {
  const n = Math.min(u8.length, 8192) & ~1;
  const counts = new Array<number>(BLOCKS.length).fill(0);
  let chars = 0, bad = 0, common = 0;
  for (let i = 0; i < n; i += 2) {
    const u = le ? u8[i] | (u8[i + 1] << 8) : (u8[i] << 8) | u8[i + 1];
    chars++;
    if (u >= 0xd800 && u <= 0xdbff) {
      const v = i + 3 < n ? (le ? u8[i + 2] | (u8[i + 3] << 8) : (u8[i + 2] << 8) | u8[i + 3]) : i + 2 >= n ? 0xdc00 : 0;
      if (v < 0xdc00 || v > 0xdfff) return 0; // unpaired surrogate
      i += 2;
      continue;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return 0;
    if (u === 9 || u === 10 || u === 13 || u === 12) { counts[0]++; continue; }
    const k = u < 0x20 || (u >= 0x7f && u < 0xa0) ? -1 : blockOf(u);
    if (k < 0) { bad++; continue; }
    counts[k]++;
    if (k === HAN_BLOCK) { const c = String.fromCharCode(u); if (COMMON_SC.includes(c) || COMMON_TC.includes(c)) common++; }
  }
  if (chars < 2 || bad > chars * 0.02) return 0;
  // Bytes of other text read as UTF-16 land on random, mostly rare ideographs.
  const han = counts[HAN_BLOCK];
  if (han > chars * 0.2 && common < han * 0.15) return 0;
  const top = [...counts].sort((a, b) => b - a);
  const share = (top[0] + top[1] + top[2]) / chars;
  return share >= 0.9 ? share : 0;
}

/**
 * BOM-less UTF-16 whose text is not mostly ASCII (so the zero-byte pattern does not show it):
 * tried only when the bytes are not UTF-8, or decode as UTF-8 full of control characters.
 */
export function bomlessUtf16(u8: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (u8.length < 4 || u8.length % 2) return null;
  const sample = u8.subarray(0, Math.min(u8.length, 8192));
  if (utf8Valid(sample)) {
    let ctrl = 0;
    for (const x of sample) if (x < 0x20 && x !== 9 && x !== 10 && x !== 13 && x !== 12) ctrl++;
    if (ctrl <= sample.length * 0.01) return null;
  }
  const le = utf16Score(u8, true), be = utf16Score(u8, false);
  if (!le && !be) return null;
  return le >= be ? 'utf-16le' : 'utf-16be';
}

/** Detect the encoding of text bytes and decode them. */
export function detectText(data: ArrayBuffer | Uint8Array): Detected {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(u8.subarray(3)), confidence: 1 };
  if (u8[0] === 0xff && u8[1] === 0xfe && u8[2] === 0 && u8[3] === 0) return { encoding: 'utf-32le', text: decodeAs(u8.subarray(4), 'utf-32le')!, confidence: 1 };
  if (u8[0] === 0 && u8[1] === 0 && u8[2] === 0xfe && u8[3] === 0xff) return { encoding: 'utf-32be', text: decodeAs(u8.subarray(4), 'utf-32be')!, confidence: 1 };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(u8.subarray(2)), confidence: 1 };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(u8.subarray(2)), confidence: 1 };
  // BOM-less UTF-16: ASCII-range text has a zero in every other byte.
  const sample = u8.subarray(0, Math.min(u8.length, 8192));
  if (sample.length >= 4) {
    let even = 0, odd = 0;
    for (let i = 0; i + 1 < sample.length; i += 2) { if (sample[i] === 0) even++; if (sample[i + 1] === 0) odd++; }
    const pairs = Math.floor(sample.length / 2);
    if (odd / pairs > 0.3 && even / pairs < 0.05) return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(u8), confidence: 0.9 };
    if (even / pairs > 0.3 && odd / pairs < 0.05) return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(u8), confidence: 0.9 };
  }
  const u16 = bomlessUtf16(u8);
  if (u16) return { encoding: u16, text: new TextDecoder(u16).decode(u8), confidence: 0.85 };
  const utf8 = decodeAs(u8, 'utf-8', true);
  if (utf8 != null) return { encoding: 'utf-8', text: utf8, confidence: 1 };
  // A file truncated in the middle of a UTF-8 sequence is still UTF-8.
  if (u8.length > 4) {
    const head = decodeAs(u8.subarray(0, u8.length - 3), 'utf-8', true);
    if (head != null && /[\u0080-￿]/.test(head)) return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(u8), confidence: 0.9 };
  }
  const probe = u8.subarray(0, Math.min(u8.length, 65536));
  let best: { encoding: string; score: number } = { encoding: 'windows-1252', score: -Infinity };
  // Bytes ≥ 0x80 followed by bytes ≥ 0x40 in pairs suggest a double-byte encoding, unless the
  // high bytes are Windows smart quotes and dashes ("Don’t" is 'n' 0x92 't', a valid GBK pair).
  let pairs = 0, highs = 0;
  for (let i = 0; i < probe.length; i++) if (probe[i] >= 0x80) { highs++; if (probe[i + 1] >= 0x40 && probe[i + 1] !== 0x7f && probe[i + 1] !== 0xff) { pairs++; i++; } }
  const typography = cp1252Typography(probe);
  if (pairs > 2 && pairs * 2 >= highs * 0.9 && typography < 0.5) {
    for (const enc of MULTI_BYTE) {
      const s = decodeAs(probe.length < u8.length ? trimPartial(probe) : probe, enc, true);
      if (s == null) continue;
      const sc = scoreMulti(s, enc);
      if (sc > 0.6 && sc + 10 > best.score) best = { encoding: enc, score: sc + 10 };
    }
  }
  if (best.score < 10) {
    for (const enc of SINGLE_BYTE) {
      const s = decodeAs(probe, enc);
      if (s == null) continue;
      const sc = scoreSingle(s, enc, typography);
      if (sc != null && sc > best.score) best = { encoding: enc, score: sc };
    }
  }
  const text = decodeAs(u8, best.encoding) ?? decodeAs(u8, 'windows-1252')!;
  return { encoding: best.encoding, text, confidence: best.score >= 10 ? 0.8 : Math.max(0.1, Math.min(0.8, best.score / 3)) };
}

/** Drop a possibly cut double-byte sequence at the end of a probe window. */
function trimPartial(u8: Uint8Array): Uint8Array {
  let end = u8.length;
  while (end > 0 && u8[end - 1] >= 0x80 && u8.length - end < 2) end--;
  return u8.subarray(0, end);
}

export function decodeAuto(data: ArrayBuffer | Uint8Array): string {
  return detectText(data).text;
}
