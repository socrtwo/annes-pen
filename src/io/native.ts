/** Anne's Pen native format: ProseMirror JSON with a small envelope. */
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../editor/schema';
import { decodeText } from './index';

export async function importNative(data: ArrayBuffer): Promise<PMNode> {
  let doc: PMNode;
  try {
    const json = JSON.parse(decodeText(data));
    const docJson = json && json.qf ? json.doc : json;
    doc = schema.nodeFromJSON(docJson);
    // nodeFromJSON does not validate content; a hand-edited file could break the editor later.
    doc.check();
  } catch (e) {
    throw new Error(`This file is not a valid Anne's Pen document (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (doc.type !== schema.nodes.doc) throw new Error('This file is not a valid Anne\'s Pen document (no document root).');
  return doc;
}

export async function exportNative(doc: PMNode): Promise<Blob> {
  const env = { qf: 1, app: 'Anne\'s Pen', saved: new Date().toISOString(), doc: doc.toJSON() };
  return new Blob([JSON.stringify(env)], { type: 'application/json' });
}
