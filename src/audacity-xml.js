/** Original reader/writer for Audacity 3.x's binary XML wire format.
 * Format reference: Audacity-3.7.9 ProjectSerializer.cpp (field layout only).
 * https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectSerializer.cpp
 */
import { DOMParser } from '@xmldom/xmldom';

const LIMIT = 8 * 1024 * 1024, MAX_NODES = 20000;
const namePattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
export function xmlNode(name, attrs = {}, children = []) { return { name, attrs, children }; }
function checkName(name) { if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('Audacity project contains an invalid XML name.'); return name; }
const escapeXML = value => String(value).replace(/[&<>"'\r\n\t]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[c]);
export function writeXML(node) {
  const write = (n, depth) => {
    if (depth > 64) throw new Error('Audacity XML nesting exceeds the supported limit.');
    return `<${checkName(n.name)}${Object.entries(n.attrs).map(([key, value]) => ` ${checkName(key)}="${escapeXML(value)}"`).join('')}>${n.children.map(child => write(child, depth + 1)).join('')}</${n.name}>`;
  };
  return '<?xml version="1.0" standalone="no" ?>\n' + write(node, 0) + '\n';
}
export function readXML(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > LIMIT) throw new Error('Audacity XML exceeds the 8 MiB limit.');
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('Audacity projects with XML entities or internal DTDs are unsupported.');
  // Audacity's normal external DOCTYPE is documentary; never fetch external data.
  const source = text.replace(/<!DOCTYPE[^>]*>/gi, '');
  const document = new DOMParser({ onError(level, message) { throw new Error(`Invalid Audacity XML: ${message}`); } }).parseFromString(source, 'text/xml');
  let count = 0;
  const convert = (element, depth) => {
    if (++count > MAX_NODES || depth > 64) throw new Error('Audacity project XML is too complex.');
    const attrs = Object.create(null), children = [];
    for (let i = 0; i < element.attributes.length; i++) { const item = element.attributes.item(i); attrs[checkName(item.name)] = item.value; }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) children.push(convert(child, depth + 1));
      else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue.trim()) throw new Error('Unsupported text content in Audacity project.');
    }
    return xmlNode(checkName(element.tagName), attrs, children);
  };
  if (!document.documentElement) throw new Error('Audacity project XML has no root.');
  return convert(document.documentElement, 0);
}

export function encodeBinaryXML(root) {
  const names = new Map(), dictionary = [0, 1], data = [], encoder = new TextEncoder();
  const u16 = (out, value) => out.push(value & 255, (value >>> 8) & 255);
  const u32 = (out, value) => out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
  const append = (out, bytes) => { for (const value of bytes) out.push(value); if (out.length > LIMIT) throw new Error('Audacity XML exceeds the 8 MiB limit.'); };
  const id = name => {
    checkName(name);
    if (!names.has(name)) { const bytes = encoder.encode(name), value = names.size; if (value >= 65536) throw new Error('Too many Audacity XML names.'); names.set(name, value); dictionary.push(15); u16(dictionary, value); u16(dictionary, bytes.length); append(dictionary, bytes); }
    return names.get(name);
  };
  let count = 0;
  const visit = (node, depth) => {
    if (++count > MAX_NODES || depth > 64) throw new Error('Audacity project XML is too complex.');
    data.push(1); u16(data, id(node.name));
    for (const [key, value] of Object.entries(node.attrs)) { const bytes = encoder.encode(String(value)); data.push(3); u16(data, id(key)); u32(data, bytes.length); append(data, bytes); }
    for (const child of node.children) visit(child, depth + 1);
    data.push(2); u16(data, id(node.name));
  };
  visit(root, 0); return { dict: Uint8Array.from(dictionary), doc: Uint8Array.from(data) };
}

export function decodeBinaryXML(dict, doc) {
  if (!(dict instanceof Uint8Array) || !(doc instanceof Uint8Array) || dict.length + doc.length > LIMIT) throw new Error('Invalid or oversized Audacity binary XML.');
  const bytes = new Uint8Array(dict.length + doc.length); bytes.set(dict); bytes.set(doc, dict.length);
  const view = new DataView(bytes.buffer); let position = 0, charSize = 0, names = new Map(), count = 0, root = null;
  const dictionaries = [], stack = [];
  const need = n => { if (!Number.isSafeInteger(n) || n < 0 || position + n > bytes.length) throw new Error('Truncated Audacity binary XML.'); };
  const integer = (width, signed = false) => { need(width); let value; if (width === 1) value = view.getUint8(position); else if (width === 2) value = view.getUint16(position, true); else if (width === 4) value = signed ? view.getInt32(position, true) : view.getUint32(position, true); else { const big = view.getBigInt64(position, true); if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Audacity XML integer is too large.'); value = Number(big); } position += width; return value; };
  const string = length => {
    need(length); if (![1, 2, 4].includes(charSize) || length % charSize) throw new Error('Unsupported Audacity XML character encoding.');
    const start = position; position += length;
    if (charSize < 4) return new TextDecoder(charSize === 1 ? 'utf-8' : 'utf-16le', { fatal: true }).decode(bytes.subarray(start, position));
    let value = ''; for (let i = start; i < position; i += 4) { const code = view.getUint32(i, true); if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid Audacity UTF-32 character.'); value += String.fromCodePoint(code); } return value;
  };
  const name = () => { const value = names.get(integer(2)); if (!value) throw new Error('Audacity binary XML references an unknown name.'); return value; };
  while (position < bytes.length) {
    const type = integer(1);
    if (type === 0) { charSize = integer(1); if (![1, 2, 4].includes(charSize)) throw new Error('Unsupported Audacity XML character width.'); }
    else if (type === 15) { const id = integer(2), value = checkName(string(integer(2))); if (names.has(id) && names.get(id) !== value) throw new Error('Conflicting Audacity XML dictionary entry.'); names.set(id, value); }
    else if (type === 13) { if (dictionaries.length > 64) throw new Error('Audacity dictionary nesting is too deep.'); dictionaries.push({ names, charSize }); names = new Map(); }
    else if (type === 14) { const previous = dictionaries.pop(); if (!previous) throw new Error('Invalid Audacity dictionary stack.'); ({ names, charSize } = previous); }
    else if (type === 1) { const node = xmlNode(name(), Object.create(null)); if (++count > MAX_NODES || stack.length >= 64) throw new Error('Audacity XML is too complex.'); if (stack.length) stack.at(-1).children.push(node); else if (root) throw new Error('Audacity binary XML has multiple roots.'); else root = node; stack.push(node); }
    else if (type === 2) { if (stack.pop()?.name !== name()) throw new Error('Mismatched Audacity XML closing tag.'); }
    else if (type === 11 || type === 12) { const value = string(integer(4, true)); if (type === 11 && value.trim()) throw new Error('Unsupported Audacity XML text content.'); }
    else if (type >= 3 && type <= 10) {
      const key = name(); let value;
      if (type === 3) value = string(integer(4, true));
      else if (type === 5) value = integer(1);
      else if (type === 7) value = integer(8, true);
      else if (type === 9 || type === 10) { const width = type === 9 ? 4 : 8; need(width); value = width === 4 ? view.getFloat32(position, true) : view.getFloat64(position, true); position += width; integer(4, true); if (!Number.isFinite(value)) throw new Error('Non-finite Audacity XML number.'); }
      else value = integer(4, type !== 8);
      if (!stack.length || Object.hasOwn(stack.at(-1).attrs, key)) throw new Error('Invalid or duplicate Audacity XML attribute.');
      stack.at(-1).attrs[key] = value;
    } else throw new Error(`Unsupported Audacity binary XML field ${type}; use a supported Audacity 3.x project or export audio stems.`);
  }
  if (!root || stack.length || dictionaries.length) throw new Error('Incomplete Audacity binary XML.');
  return root;
}
