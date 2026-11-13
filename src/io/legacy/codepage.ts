import { decodeAs } from '../encoding';

/**
 * Single-byte code pages used by DOS, Mac and IBM-host word processors. The upper halves
 * come from the published code page charts; the Encoding Standard decoders (TextDecoder)
 * are used where browsers provide them.
 */

// IBM EBCDIC code page 037 (US/Canada), 256 entries.
const EBCDIC037 =
  '\x00\x01\x02\x03\x9c\t\x86\x7f\x97\x8d\x8e\x0b\x0c\r\x0e\x0f\x10\x11\x12\x13\x9d\x85\x08\x87\x18\x19\x92\x8f\x1c\x1d\x1e\x1f' +
  '\x80\x81\x82\x83\x84\n\x17\x1b\x88\x89\x8a\x8b\x8c\x05\x06\x07\x90\x91\x16\x93\x94\x95\x96\x04\x98\x99\x9a\x9b\x14\x15\x9e\x1a' +
  '  âäàáãåçñ¢.<(+|&éêëèíîïìß!$*);¬-/ÂÄÀÁÃÅÇÑ¦,%_>?øÉÊËÈÍÎÏÌ`:#@\'="' +
  'Øabcdefghi«»ðýþ±°jklmnopqrªºæ¸Æ¤µ~stuvwxyz¡¿ÐÝÞ®^£¥·©§¶¼½¾[]¯¨´×{ABCDEFGHI\u00adôöòóõ}JKLMNOPQR¹ûüùúÿ\\÷STUVWXYZ²ÔÖÒÓÕ0123456789³ÛÜÙÚ\x9f';

/** Decode bytes in a DOS code page (cp437 or cp850, from the shared tables in ../encoding); control bytes pass through. */
export function decodeDos(u8: Uint8Array, cp: 'cp437' | 'cp850' = 'cp437'): string {
  return decodeAs(u8, cp) ?? '';
}

export const dosChar = (b: number, cp: 'cp437' | 'cp850' = 'cp437') => (b < 0x80 ? String.fromCharCode(b) : decodeAs(new Uint8Array([b]), cp) ?? '');

export function decodeEbcdic(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += EBCDIC037[u8[i]] ?? '';
  return s;
}
export const ebcdicChar = (b: number) => EBCDIC037[b] ?? '';

const decoders = new Map<string, TextDecoder | null>();
/** A TextDecoder for an Encoding Standard label, or null when the platform lacks it. */
export function decoder(label: string): TextDecoder | null {
  if (!decoders.has(label)) {
    try { decoders.set(label, new TextDecoder(label)); } catch { decoders.set(label, null); }
  }
  return decoders.get(label)!;
}

const MAC_ROMAN_HI = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
export function decodeMacRoman(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i] < 0x80 ? String.fromCharCode(u8[i]) : MAC_ROMAN_HI[u8[i] - 0x80];
  return s;
}
export const macChar = (b: number) => (b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN_HI[b - 0x80]);

const WIN1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export const winChar = (b: number) => (b >= 0x80 && b < 0xa0 ? WIN1252_80[b - 0x80] : String.fromCharCode(b));
export function decodeWin1252(u8: Uint8Array): string {
  return decodeAs(u8, 'windows-1252') ?? '';
}

/** Windows code page number to an Encoding Standard label. */
export function codepageLabel(cp: number): string | null {
  const m: Record<number, string> = {
    874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251',
    1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
    1258: 'windows-1258', 10000: 'macintosh', 20866: 'koi8-r', 28591: 'iso-8859-1', 65001: 'utf-8', 866: 'ibm866',
  };
  return m[cp] || null;
}

// Upper halves (0x80-0xFF) of the DOS code pages 852 (Central European), 737 (Greek) and 775 (Baltic).
const DOS_HI: Record<number, string> = {
  852: 'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´\u00ad˝˛ˇ˘§÷¸°¨˙űŘř■\u00a0',
  737: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■\u00a0',
  775: 'ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’\u00ad±“¾¶§÷„°∙·¹³²■\u00a0',
};
function decodeDosHi(u8: Uint8Array, hi: string): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i] < 0x80 ? String.fromCharCode(u8[i]) : hi[u8[i] - 0x80];
  return s;
}

/** Decode with a Windows code page, falling back to CP1252. */
export function decodeCodepage(u8: Uint8Array, cp: number): string {
  if (cp === 437 || cp === 850) return decodeDos(u8, cp === 437 ? 'cp437' : 'cp850');
  if (DOS_HI[cp]) return decodeDosHi(u8, DOS_HI[cp]);
  if (cp === 1200) return new TextDecoder('utf-16le').decode(u8);
  const label = codepageLabel(cp);
  const d = label ? decoder(label) : null;
  return d ? d.decode(u8) : decodeWin1252(u8);
}
