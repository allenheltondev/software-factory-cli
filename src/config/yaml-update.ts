/**
 * Apply a desired config object onto an existing YAML file's text with the
 * `yaml` Document API, so comments, key order and formatting of nodes that did
 * not change survive a save. Pure; no filesystem access.
 */
import { isCollection, isMap, isNode, isScalar, isSeq, parseDocument, type Document, type ToStringOptions, type YAMLMap, type YAMLSeq } from 'yaml';

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

const isObject = (v: unknown): v is Record<string, Plain> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural equality; object key order is ignored. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function toJS(doc: Document, node: unknown): unknown {
  return isNode(node) ? node.toJS(doc) : node;
}

function keyString(key: unknown): string | undefined {
  if (isScalar(key)) return String(key.value);
  if (typeof key === 'string' || typeof key === 'number') return String(key);
  return undefined;
}

/** Return the node to store for `value`: the existing node (edited in place when possible) or a new one. */
function update(doc: Document, node: unknown, value: Plain, isRoot = false): unknown {
  if (deepEqual(toJS(doc, node), value)) return node;
  if (isMap(node) && isObject(value)) {
    updateMap(doc, node, value, isRoot);
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    updateSeq(doc, node, value);
    return node;
  }
  if (isScalar(node) && value !== null && typeof value !== 'object' && typeof node.value === typeof value && !node.tag) {
    node.value = value; // keeps the node's comments and quoting style
    return node;
  }
  return doc.createNode(value);
}

function updateMap(doc: Document, map: YAMLMap, value: Record<string, Plain>, isRoot: boolean): void {
  const wasEmpty = map.items.length === 0;
  const seen = new Set<string>();
  const items: YAMLMap['items'] = [];
  for (const pair of map.items) {
    const k = keyString(pair.key);
    if (k === undefined || !Object.hasOwn(value, k) || seen.has(k)) continue;
    seen.add(k);
    const before = pair.value;
    const wasFlow = isCollection(before) && before.flow;
    pair.value = update(doc, before, value[k]!);
    if (wasFlow && isCollection(before) && pair.value === before && !before.flow && before.comment) {
      if (isScalar(pair.key) && !pair.key.comment) {
        // `key: {} # note` grew into a block; keep the note on the key's line.
        pair.key.comment = before.comment;
        delete before.comment;
      }
    }
    items.push(pair);
  }
  for (const [k, v] of Object.entries(value)) {
    if (!seen.has(k)) items.push(doc.createPair(k, v));
  }
  if (!isRoot && map.items.length && items[0] !== map.items[0]) {
    // A comment just inside a nested map belongs to its first key; it goes with that key.
    delete map.commentBefore;
    const first = items[0]?.key;
    if (isNode(first)) first.spaceBefore = false;
  }
  map.items = items;
  if (wasEmpty && items.length) map.flow = false; // `{}` placeholder grows into a block
}

function updateSeq(doc: Document, seq: YAMLSeq, value: Plain[]): void {
  const wasEmpty = seq.items.length === 0;
  const old = seq.items;
  const oldJs = old.map((n) => toJS(doc, n));
  const used = new Set<number>();
  const items: unknown[] = new Array(value.length);
  const matched: boolean[] = new Array(value.length).fill(false);
  // Reuse unchanged items first (they keep their comments even if they moved)...
  value.forEach((v, i) => {
    const j = oldJs.findIndex((o, idx) => !used.has(idx) && deepEqual(o, v));
    if (j >= 0) {
      used.add(j);
      items[i] = old[j];
      matched[i] = true;
    }
  });
  // ...then edit the item at the same position, or add a new one.
  value.forEach((v, i) => {
    if (matched[i]) return;
    if (i < old.length && !used.has(i)) {
      used.add(i);
      items[i] = update(doc, old[i], v);
    } else {
      items[i] = doc.createNode(v);
    }
  });
  seq.items = items;
  if (wasEmpty && items.length) seq.flow = false;
}

/** Best-effort guess at the source's indentation style so untouched lines are re-emitted the same way. */
function detectFormat(source: string): ToStringOptions {
  const lines = source.split(/\r?\n/);
  let indent = 0;
  let indentSeq: boolean | undefined;
  let prev: { indent: number; opensBlock: boolean } | undefined;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const lead = line.length - trimmed.length;
    if (lead > 0 && !trimmed.startsWith('- ') && (indent === 0 || lead < indent)) indent = lead;
    if (prev?.opensBlock && trimmed.startsWith('- ') && indentSeq === undefined) indentSeq = lead > prev.indent;
    prev = { indent: lead, opensBlock: /:\s*(#.*)?$/.test(trimmed) };
  }
  let flowCollectionPadding: boolean | undefined;
  if (/[[{] [^\s\]}]/.test(source)) flowCollectionPadding = true;
  else if (/[[{][^\s\]}]/.test(source)) flowCollectionPadding = false;
  return {
    lineWidth: 0,
    indent: indent >= 1 && indent <= 8 ? indent : 2,
    indentSeq: indentSeq ?? true,
    flowCollectionPadding: flowCollectionPadding ?? true,
  };
}

/**
 * Rewrite `source` so it parses to `value`, touching only nodes that changed.
 * Returns null when the source can't be updated in place (parse errors, not a
 * mapping, or the edited document wouldn't round-trip to `value`, e.g. because
 * of anchors/aliases); the caller should then write a fresh document.
 */
export function updateYamlText(source: string, value: unknown): string | null {
  const desired = JSON.parse(JSON.stringify(value)) as Plain; // drop undefined, as stringify would
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const doc = parseDocument(bom ? source.slice(1) : source);
  if (doc.errors.length || !isMap(doc.contents) || !isObject(desired)) return null;
  if (deepEqual(doc.toJS(), desired)) return source;

  doc.contents = update(doc, doc.contents, desired, true) as typeof doc.contents;
  let out = doc.toString(detectFormat(source));

  const check = parseDocument(out);
  if (check.errors.length || !deepEqual(check.toJS(), desired)) return null;
  if (source.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
  return bom + out;
}
