/** Macro-local data tools. They receive plain data and never call editor or host APIs. */
import { schema as S } from './command-schema.js';

const MAX_ITEMS = 10000, MAX_TEXT = 131072;
const number = S.number(-Number.MAX_VALUE, Number.MAX_VALUE);
const integer = S.integer(-1000000000, 1000000000);
const text = S.string(MAX_TEXT);
const scalar = { anyOf: [number, text, S.boolean, { type: 'null' }] };
const values = S.array({}, MAX_ITEMS), numbers = S.array(number, MAX_ITEMS), strings = S.array(scalar, MAX_ITEMS);
const definitions = [];
const descriptor = (method, label, properties, required = Object.keys(properties)) => {
  const value = { id: method, method, label, description: label, category: 'Macro data tools', capabilities: [], recordable: false, undoable: false, schema: S.object(properties, required) };
  definitions.push(value); return method;
};
descriptor('random.seed', 'Restart this run’s random sequence with a number or text seed', { seed: { anyOf: [S.integer(0, 4294967295), S.string(256, 1)] } });
descriptor('random.float', 'Random number from min (inclusive) to max (exclusive); defaults 0–1', { min: number, max: number }, []);
descriptor('random.int', 'Random integer from min through max, including both ends', { min: S.integer(-2147483648, 2147483647), max: S.integer(-2147483648, 2147483647) });
descriptor('random.choice', 'Pick one item from a nonempty array', { values: { ...values, minItems: 1 } });
descriptor('array.range', 'Integer sequence from start to end (exclusive), using step', { start: integer, end: integer, step: integer }, ['end']);
descriptor('array.length', 'Count the items in an array', { values });
descriptor('array.append', 'Return an array with one added item; keep the input unchanged', { values, value: {} });
descriptor('array.set', 'Return an array with an existing index replaced', { values, index: S.integer(0, MAX_ITEMS - 1), value: {} });
descriptor('array.concat', 'Combine arrays in order into one new array', { arrays: S.array(values, 128) });
descriptor('array.slice', 'Copy an array interval; negative indices count from the end', { values, start: S.integer(-MAX_ITEMS, MAX_ITEMS), end: S.integer(-MAX_ITEMS, MAX_ITEMS) }, ['values']);
descriptor('array.reverse', 'Return the items in reverse order', { values });
descriptor('array.sort', 'Sort numbers numerically or strings in deterministic text order', { values, descending: S.boolean }, ['values']);
descriptor('array.shuffle', 'Shuffle a copy with this run’s random sequence', { values });
descriptor('array.sum', 'Sum a numeric array', { values: numbers });
descriptor('array.mean', 'Mean of a nonempty numeric array', { values: { ...numbers, minItems: 1 } });
for (const [name, label] of [['abs', 'Absolute value'], ['ceil', 'Round up to an integer'], ['floor', 'Round down to an integer'], ['sqrt', 'Square root of a nonnegative value']]) descriptor(`math.${name}`, label, { value: number });
descriptor('math.round', 'Round to a specified number of decimal places (default zero)', { value: number, digits: S.integer(0, 9) }, ['value']);
descriptor('math.pow', 'Raise base to exponent; the result must remain finite', { base: number, exponent: number });
descriptor('math.min', 'Minimum of a nonempty numeric array', { values: { ...numbers, minItems: 1 } });
descriptor('math.max', 'Maximum of a nonempty numeric array', { values: { ...numbers, minItems: 1 } });
descriptor('math.clamp', 'Keep value between min and max', { value: number, min: number, max: number });
descriptor('math.lerp', 'Interpolate between start and end with an amount from zero to one', { start: number, end: number, amount: S.number(0, 1) });
descriptor('math.dbToGain', 'Convert amplitude decibels to a linear gain', { db: S.number(-300, 300) });
descriptor('math.gainToDb', 'Convert nonnegative linear gain to dB; zero returns null', { gain: S.number(0, Number.MAX_VALUE) });
descriptor('text.string', 'Convert a finite scalar to text', { value: scalar });
descriptor('text.number', 'Read a complete finite numeric string', { value: S.string(MAX_TEXT, 1) });
for (const [name, label] of [['trim', 'Remove surrounding whitespace'], ['lower', 'Convert text to lowercase'], ['upper', 'Convert text to uppercase']]) descriptor(`text.${name}`, label, { value: text });
descriptor('text.join', 'Join scalar array items with a separator', { values: strings, separator: text }, ['values']);
descriptor('text.split', 'Split text at literal separators; no regular expressions', { value: text, separator: S.string(MAX_TEXT, 1) });
descriptor('text.replace', 'Replace literal text; all matches by default, no regular expressions', { value: text, search: S.string(MAX_TEXT, 1), replacement: text, all: S.boolean }, ['value', 'search', 'replacement']);

function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export const MACRO_BUILTINS = freeze(definitions);
export const MACRO_BUILTIN_METHODS = Object.freeze(MACRO_BUILTINS.map(item => item.method));
const methods = new Set(MACRO_BUILTIN_METHODS);
export const isMacroBuiltin = method => methods.has(method);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const finite = value => Number.isFinite(value) ? value : fail('The result must be finite.');

function hashSeed(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  let value = 2166136261;
  for (let index = 0; index < seed.length; index++) value = Math.imul(value ^ seed.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** One independent PRNG per execution. Explicit seeds reproduce across browser and CLI. */
export function createMacroBuiltins({ limits, charge }) {
  const arrayLimit = Math.min(MAX_ITEMS, limits.valueNodes - 1, Math.floor(limits.valueBytes / 8) - 1);
  const textLimit = Math.min(MAX_TEXT, limits.stringLength, Math.floor((limits.valueBytes - 8) / 2));
  let seed;
  if (globalThis.crypto?.getRandomValues) seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  else seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const admitArray = length => { if (!Number.isSafeInteger(length) || length < 0 || length > arrayLimit) fail('Array result exceeds the macro value budget.', 'RESOURCE_LIMIT'); charge(length + 1); };
  const admitText = length => { if (!Number.isSafeInteger(length) || length < 0 || length > textLimit) fail('Text result exceeds the macro value budget.', 'RESOURCE_LIMIT'); charge(Math.ceil(length / 16) + 1); };
  const orderedBounds = (min, max, strict = false) => { if (strict ? max <= min : max < min) fail('Maximum must be ' + (strict ? 'greater than' : 'at least') + ' minimum.'); };
  return (method, params) => {
    const { values: input, value } = params;
    switch (method) {
      case 'random.seed': seed = hashSeed(params.seed); return seed;
      case 'random.float': {
        const min = params.min ?? 0, max = params.max ?? 1; orderedBounds(min, max, true);
        const fraction = next(), result = finite(min * (1 - fraction) + max * fraction);
        // Avoid rounding onto the excluded endpoint when the interval is tiny.
        return result >= max ? min : Math.max(min, result);
      }
      case 'random.int': orderedBounds(params.min, params.max); return params.min + Math.floor(next() * (params.max - params.min + 1));
      case 'random.choice': return input[Math.floor(next() * input.length)];
      case 'array.range': {
        const start = params.start ?? 0, step = params.step ?? 1;
        if (step === 0) fail('Array range step must not be zero.');
        const count = Math.max(0, Math.ceil((params.end - start) / step)); admitArray(count);
        return Array.from({ length: count }, (_, index) => start + index * step);
      }
      case 'array.length': return input.length;
      case 'array.append': admitArray(input.length + 1); return [...input, value];
      case 'array.set': {
        if (params.index >= input.length) fail('Array index is outside the existing array.');
        admitArray(input.length); const result = input.slice(); result[params.index] = value; return result;
      }
      case 'array.concat': { const count = params.arrays.reduce((sum, array) => sum + array.length, 0); admitArray(count); return params.arrays.flat(); }
      case 'array.slice': {
        const offset = value => value < 0 ? Math.max(0, input.length + value) : Math.min(input.length, value);
        const start = offset(params.start ?? 0), end = offset(params.end ?? input.length); admitArray(Math.max(0, end - start)); return input.slice(start, end);
      }
      case 'array.reverse': admitArray(input.length); return input.slice().reverse();
      case 'array.sort': {
        if (input.length && (!['number', 'string'].includes(typeof input[0]) || input.some(item => typeof item !== typeof input[0]))) fail('Sort needs all numbers or all strings.');
        admitArray(input.length); charge(Math.ceil(input.length * Math.log2(Math.max(1, input.length))));
        const direction = params.descending ? -1 : 1;
        return input.slice().sort((a, b) => (a < b ? -direction : a > b ? direction : 0));
      }
      case 'array.shuffle': {
        admitArray(input.length); const result = input.slice();
        for (let index = result.length - 1; index > 0; index--) { const other = Math.floor(next() * (index + 1)); [result[index], result[other]] = [result[other], result[index]]; }
        return result;
      }
      case 'array.sum': case 'array.mean': {
        charge(input.length); let sum = 0, correction = 0;
        for (const item of input) { const adjusted = (method === 'array.mean' ? item / input.length : item) - correction, nextSum = finite(sum + adjusted); correction = (nextSum - sum) - adjusted; sum = nextSum; }
        return sum;
      }
      case 'math.abs': return Math.abs(value);
      case 'math.ceil': return Math.ceil(value);
      case 'math.floor': return Math.floor(value);
      case 'math.sqrt': return finite(Math.sqrt(value));
      case 'math.round': { const scale = 10 ** (params.digits ?? 0); return finite(Math.round(finite(value * scale)) / scale); }
      case 'math.pow': return finite(Math.pow(params.base, params.exponent));
      case 'math.min': case 'math.max': {
        charge(input.length); let result = input[0]; for (const item of input) if (method === 'math.min' ? item < result : item > result) result = item; return result;
      }
      case 'math.clamp': orderedBounds(params.min, params.max); return Math.max(params.min, Math.min(params.max, value));
      case 'math.lerp': return finite(params.start * (1 - params.amount) + params.end * params.amount);
      case 'math.dbToGain': return finite(10 ** (params.db / 20));
      case 'math.gainToDb': return params.gain === 0 ? null : finite(20 * Math.log10(params.gain));
      case 'text.string': { const result = String(value); admitText(result.length); return result; }
      case 'text.number': {
        charge(Math.ceil(value.length / 16) + 1);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) fail('Expected a complete decimal numeric string.');
        return finite(Number(value));
      }
      case 'text.trim': charge(Math.ceil(value.length / 16) + 1); return value.trim();
      case 'text.lower': case 'text.upper': {
        charge(Math.ceil(value.length / 16) + 1); const result = method === 'text.lower' ? value.toLowerCase() : value.toUpperCase(); admitText(result.length); return result;
      }
      case 'text.join': {
        const separator = params.separator ?? '', parts = input.map(item => String(item));
        admitText(parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1) * separator.length); return parts.join(separator);
      }
      case 'text.split': {
        charge(Math.ceil(value.length / 16) + 1); let count = 1, at = 0;
        while ((at = value.indexOf(params.separator, at)) >= 0) { count++; if (count > arrayLimit) fail('Split result exceeds the macro array budget.', 'RESOURCE_LIMIT'); at += params.separator.length; }
        admitArray(count); return value.split(params.separator);
      }
      case 'text.replace': {
        charge(Math.ceil(value.length / 16) + 1); let count = 0, at = 0;
        while ((at = value.indexOf(params.search, at)) >= 0) { count++; at += params.search.length; if (params.all === false) break; }
        admitText(value.length + count * (params.replacement.length - params.search.length));
        // Functions keep "$&" and other replacement tokens literal.
        return params.all === false ? value.replace(params.search, () => params.replacement) : value.replaceAll(params.search, () => params.replacement);
      }
      default: fail('Unknown macro data tool: ' + method, 'UNKNOWN_COMMAND');
    }
  };
}
