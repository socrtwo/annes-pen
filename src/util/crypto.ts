/** Password-based document encryption: PBKDF2-SHA256 (310k iterations) + AES-256-GCM. */
const MAGIC = new TextEncoder().encode('QFDE1');

/** A document's key, derived once from its password and kept in memory only (never stored). */
export interface DocKey { key: CryptoKey; salt: Uint8Array }

async function key(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** True for data in the encrypted Anne's Pen format (.qpde, and .qfde from the former name). */
export function isEncryptedDoc(data: ArrayBuffer | Uint8Array): boolean {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return u8.length > MAGIC.length + 28 && MAGIC.every((b, i) => u8[i] === b);
}

export async function newDocKey(password: string): Promise<DocKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await key(password, salt), salt };
}

/** Encrypts with a document's key (a fresh IV every time, so the key can be reused for each save). */
export async function encryptWithKey(obj: unknown, k: DocKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(MAGIC.length + 16 + iv.length + ct.length);
  out.set(MAGIC, 0); out.set(k.salt, MAGIC.length); out.set(iv, MAGIC.length + 16); out.set(ct, MAGIC.length + 28);
  return out;
}

export async function encryptJson(obj: unknown, password: string): Promise<Uint8Array> {
  return encryptWithKey(obj, await newDocKey(password));
}

/** Decrypts, returning the content and the key (to encrypt it again on save). */
export async function decryptJsonWithKey(data: ArrayBuffer | Uint8Array, password: string): Promise<{ json: any; key: DocKey }> {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC[i]) throw new Error('Not an encrypted Anne\'s Pen file');
  const salt = u8.slice(MAGIC.length, MAGIC.length + 16);
  const iv = u8.slice(MAGIC.length + 16, MAGIC.length + 28);
  const ct = u8.slice(MAGIC.length + 28);
  const k = await key(password, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
  return { json: JSON.parse(new TextDecoder().decode(pt)), key: { key: k, salt } };
}

export async function decryptJson(data: ArrayBuffer | Uint8Array, password: string): Promise<any> {
  return (await decryptJsonWithKey(data, password)).json;
}

// ------------------------------------------------------------------------------------------
// Restrict Editing passwords. Advisory only: the protection is a setting in the file, which anyone
// can change with another program. Salted PBKDF2; older documents hold an unsalted SHA-256.

const PW_ITER = 100000;
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, base, 256));
}

/** The hash stored for a protection password: "pbkdf2$iterations$salt$hash" (hex). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PW_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PW_ITER)}`;
}

/** The unsalted hash held by documents protected before salted hashes. */
export async function legacyPasswordHash(password: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('quillpen:' + password))); // rename:keep — prefix of stored hashes
}

export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored) return false;
  const m = /^pbkdf2\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored);
  if (!m) return (await legacyPasswordHash(password)) === stored;
  const salt = new Uint8Array((m[2].match(/../g) || []).map((x) => parseInt(x, 16)));
  return (await pbkdf2(password, salt, Math.min(2_000_000, +m[1]))) === m[3];
}
