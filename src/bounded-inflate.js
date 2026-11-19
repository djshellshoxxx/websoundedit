/** Original RFC 1951 length preflight. No output is expanded until its exact
 * size has been proven; fflate's fixed-output option alone silently truncates.
 * https://www.rfc-editor.org/rfc/rfc1951
 */
import { inflateSync } from 'fflate';

const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DISTANCE_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DISTANCE_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CODE_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
export const MAX_DEFLATE_BLOCKS = 20000;
function huffman(lengths, kind) {
  const counts = new Uint16Array(16), next = new Uint16Array(16), maps = Array.from({ length: 16 }, () => new Map());
  let maximum = 0;
  for (const length of lengths) { if (length < 0 || length > 15) throw new Error('Invalid DEFLATE code length.'); if (length) { counts[length]++; maximum = Math.max(maximum, length); } }
  if (!maximum) { if (kind === 'distance') return { maximum, maps }; throw new Error('Empty DEFLATE Huffman tree.'); }
  let remaining = 1, code = 0;
  for (let bits = 1; bits <= 15; bits++) { remaining = remaining * 2 - counts[bits]; if (remaining < 0) throw new Error('Oversubscribed DEFLATE Huffman tree.'); code = (code + counts[bits - 1]) * 2; next[bits] = code; }
  if (remaining && (kind === 'codes' || maximum !== 1)) throw new Error('Incomplete DEFLATE Huffman tree.');
  lengths.forEach((length, symbol) => { if (length) maps[length].set(next[length]++, symbol); });
  return { maximum, maps };
}
const FIXED_LITERAL = huffman(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8), 'literal');
const FIXED_DISTANCE = huffman(new Array(32).fill(5), 'distance');

export function preflightDeflate(bytes, expectedBytes, { blockBudget = { remaining: MAX_DEFLATE_BLOCKS } } = {}) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 256 * 1024 * 1024) throw new Error('Invalid DEFLATE output limit.');
  if (!Number.isSafeInteger(blockBudget?.remaining) || blockBudget.remaining < 0 || blockBudget.remaining > MAX_DEFLATE_BLOCKS) throw new Error('Invalid DEFLATE complexity budget.');
  let position = 0, outputBytes = 0, final = 0;
  const need = bits => { if (position + bits > bytes.length * 8) throw new Error('Truncated DEFLATE stream.'); };
  const read = count => {
    need(count); let value = 0;
    for (let bit = 0; bit < count; bit++, position++) value |= ((bytes[position >>> 3] >>> (position & 7)) & 1) << bit;
    return value;
  };
  const symbol = tree => {
    let code = 0;
    for (let width = 1; width <= tree.maximum; width++) { code = code * 2 + read(1); const value = tree.maps[width].get(code); if (value !== undefined) return value; }
    throw new Error('Invalid DEFLATE Huffman symbol.');
  };
  const reserve = count => { if (count > expectedBytes - outputBytes) throw new Error('DEFLATE output exceeds its declared size.'); outputBytes += count; };
  do {
    if (blockBudget.remaining-- <= 0) throw new Error('Project ZIP exceeds the 20,000 DEFLATE block complexity limit.');
    final = read(1); const type = read(2);
    if (type === 0) {
      position = Math.ceil(position / 8) * 8;
      const length = read(16), complement = read(16);
      if ((length ^ complement) !== 65535) throw new Error('Invalid stored DEFLATE block length.');
      reserve(length); need(length * 8); position += length * 8; continue;
    }
    if (type === 3) throw new Error('Reserved DEFLATE block type.');
    let literal = FIXED_LITERAL, distance = FIXED_DISTANCE;
    if (type === 2) {
      const literalCount = read(5) + 257, distanceCount = read(5) + 1, codeCount = read(4) + 4;
      if (literalCount > 286) throw new Error('Invalid DEFLATE literal alphabet.');
      const codeLengths = new Array(19).fill(0);
      for (let i = 0; i < codeCount; i++) codeLengths[CODE_ORDER[i]] = read(3);
      const codeTree = huffman(codeLengths, 'codes'), lengths = [];
      while (lengths.length < literalCount + distanceCount) {
        const value = symbol(codeTree); let count = 1, length = value;
        if (value === 16) { if (!lengths.length) throw new Error('Invalid DEFLATE repeat.'); length = lengths.at(-1); count = read(2) + 3; }
        else if (value === 17) { length = 0; count = read(3) + 3; }
        else if (value === 18) { length = 0; count = read(7) + 11; }
        if (lengths.length + count > literalCount + distanceCount) throw new Error('DEFLATE code repeat exceeds its alphabet.');
        while (count--) lengths.push(length);
      }
      if (!lengths[256]) throw new Error('DEFLATE end-of-block code is missing.');
      literal = huffman(lengths.slice(0, literalCount), 'literal'); distance = huffman(lengths.slice(literalCount), 'distance');
    }
    for (;;) {
      const value = symbol(literal);
      if (value < 256) { reserve(1); continue; }
      if (value === 256) break;
      if (value > 285) throw new Error('Reserved DEFLATE length symbol.');
      const at = value - 257, length = LENGTH_BASE[at] + read(LENGTH_EXTRA[at]), distanceCode = symbol(distance);
      if (distanceCode > 29) throw new Error('Reserved DEFLATE distance symbol.');
      const offset = DISTANCE_BASE[distanceCode] + read(DISTANCE_EXTRA[distanceCode]);
      if (offset > outputBytes) throw new Error('DEFLATE distance exceeds available history.');
      reserve(length);
    }
  } while (!final);
  if (outputBytes !== expectedBytes || Math.ceil(position / 8) !== bytes.length) throw new Error('DEFLATE length does not match its ZIP entry.');
  return outputBytes;
}

export function inflateBounded(bytes, expectedBytes, options) {
  preflightDeflate(bytes, expectedBytes, options);
  const result = inflateSync(bytes, { out: new Uint8Array(expectedBytes) });
  if (result.length !== expectedBytes) throw new Error('DEFLATE length does not match its ZIP entry.');
  return result;
}
