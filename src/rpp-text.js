/** Bounded Cockos/WDL line-token and nested-block grammar.
 * Quoted strings use one of ", ' or `; backslashes are ordinary characters.
 * https://github.com/justinfrankel/WDL/blob/main/WDL/lineparse.h
 */
export const RPP_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, lines: 50000, lineBytes: 65536, tokenCharacters: 16384, tokensPerLine: 256, tokens: 100000, records: 20000, depth: 64 });
export class ReaperFormatError extends Error {
  constructor(message, line) { super(line ? `REAPER line ${line}: ${message}` : `REAPER: ${message}`); this.name = 'ReaperFormatError'; this.code = 'UNSUPPORTED_REAPER_PROJECT'; if (line) this.line = line; }
}
export function tokenizeRppLine(line, number = 1) {
  if (line.length > RPP_LIMITS.lineBytes || new TextEncoder().encode(line).length > RPP_LIMITS.lineBytes) throw new ReaperFormatError('line exceeds 64 KiB.', number);
  const tokens = []; let at = 0;
  while (at < line.length) {
    while (line[at] === ' ' || line[at] === '\t') at++;
    if (at === line.length || line[at] === '#' || line[at] === ';') break;
    let value = ''; const first = line[at];
    if (first === '"' || first === "'" || first === '`') {
      const end = line.indexOf(first, ++at);
      if (end < 0) throw new ReaperFormatError('unterminated quoted token.', number);
      value = line.slice(at, end); at = end + 1;
      if (at < line.length && !/[ \t]/.test(line[at])) throw new ReaperFormatError('quoted tokens must be separated by whitespace.', number);
    } else {
      const start = at; while (at < line.length && line[at] !== ' ' && line[at] !== '\t') at++;
      value = line.slice(start, at);
    }
    if (value.length > RPP_LIMITS.tokenCharacters) throw new ReaperFormatError('token exceeds the supported length.', number);
    if (tokens.length >= RPP_LIMITS.tokensPerLine) throw new ReaperFormatError('too many tokens on one line.', number);
    tokens.push(value);
  }
  return tokens;
}

export function parseRpp(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.length > RPP_LIMITS.bytes) throw new ReaperFormatError('project text exceeds 8 MiB.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else throw new ReaperFormatError('provide UTF-8 project text or bytes.');
  if (text.length > RPP_LIMITS.bytes || new TextEncoder().encode(text).length > RPP_LIMITS.bytes) throw new ReaperFormatError('project text exceeds 8 MiB.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ReaperFormatError('unsupported control character.');
  text = text.replace(/^\uFEFF/, '');
  let root = null, records = 0, tokens = 0; const stack = [];
  // Scan lines without allocating an array for an attacker-supplied newline run.
  // CRLF and old CR line endings work; physical lines include blank/comments.
  let position = 0, index = -1;
  while (position < text.length) {
    if (++index >= RPP_LIMITS.lines) throw new ReaperFormatError('project exceeds 50,000 physical lines.');
    let end = position; while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
    const line = text.slice(position, end); position = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
    const parts = tokenizeRppLine(line, index + 1); if (!parts.length) continue;
    if (++records > RPP_LIMITS.records || (tokens += parts.length) > RPP_LIMITS.tokens) throw new ReaperFormatError('project text is too complex.', index + 1);
    const first = parts.shift();
    if (first === '>') { if (parts.length || !stack.length) throw new ReaperFormatError('unexpected closing block.', index + 1); stack.pop(); continue; }
    const block = first.startsWith('<'), tag = block ? first.slice(1) : first;
    if (!tag) throw new ReaperFormatError('empty record name.', index + 1);
    const record = { tag, args: parts, line: index + 1, ...(block ? { children: [] } : {}) };
    if (stack.length) stack.at(-1).children.push(record);
    else if (root || !block) throw new ReaperFormatError('expected one project root.', index + 1);
    else root = record;
    if (block) { if (stack.length > RPP_LIMITS.depth) throw new ReaperFormatError('nesting exceeds 64 levels.', index + 1); stack.push(record); }
  }
  if (!root || stack.length || root.tag !== 'REAPER_PROJECT') throw new ReaperFormatError('missing, incomplete or unsupported project root.');
  return root;
}

export function quoteRpp(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/.test(text) || text.length > RPP_LIMITS.tokenCharacters) throw new ReaperFormatError('a name or field contains an unsupported control character or is too long.');
  for (const quote of ['"', "'", '`']) if (!text.includes(quote)) return quote + text + quote;
  if (text && !/[ \t]/.test(text) && !/^["'`#;]/.test(text)) return text;
  throw new ReaperFormatError('a field contains spaces and all three quote characters; remove one quote type before exporting.');
}
export const rppRecord = (tag, args = [], children) => ({ tag, args, ...(children === undefined ? {} : { children }) });
export function writeRpp(root) {
  const lines = []; let records = 0, tokens = 0, totalBytes = 0;
  function line(text) { const bytes = new TextEncoder().encode(text).length + 1; if (bytes > RPP_LIMITS.lineBytes || (totalBytes += bytes) > RPP_LIMITS.bytes) throw new ReaperFormatError('project text exceeds its size limit.'); lines.push(text); }
  function visit(record, depth) {
    if (++records > RPP_LIMITS.records || depth > RPP_LIMITS.depth || (tokens += record.args.length + 1) > RPP_LIMITS.tokens || record.args.length >= RPP_LIMITS.tokensPerLine) throw new ReaperFormatError('project text is too complex.');
    if (!/^[A-Z_][A-Z0-9_:]*$/.test(record.tag)) throw new ReaperFormatError('invalid record name.');
    const block = Array.isArray(record.children);
    const args = record.args.map(value => {
      if (typeof value === 'number') { if (!Number.isFinite(value)) throw new ReaperFormatError('numeric fields must be finite.'); return String(value); }
      if (typeof value !== 'string') throw new ReaperFormatError('fields must be strings or finite numbers.');
      return quoteRpp(value);
    }).join(' ');
    line(`${'  '.repeat(depth)}${block ? '<' : ''}${record.tag}${args ? ' ' + args : ''}`);
    if (block) { for (const child of record.children) visit(child, depth + 1); if (++records > RPP_LIMITS.records || ++tokens > RPP_LIMITS.tokens) throw new ReaperFormatError('project text is too complex.'); line(`${'  '.repeat(depth)}>`); }
  }
  if (root.tag !== 'REAPER_PROJECT') throw new ReaperFormatError('invalid project root.');
  visit(root, 0); return lines.join('\n') + '\n';
}
