/** WebSoundEdit Macro 1: a bounded, interpreted language. No ambient JavaScript. */
import { validateCommandParams, validateStaticCommandParams, STATIC_UNKNOWN } from './command-schema.js';
import { MACRO_BUILTINS, isMacroBuiltin, createMacroBuiltins } from './macro-builtins.js';
export { MACRO_BUILTINS } from './macro-builtins.js';

export const MACRO_LIMITS = Object.freeze({ sourceBytes: 131072, tokens: 30000, nodes: 20000, depth: 48, iterations: 10000, commands: 10000, operations: 200000, valueNodes: 50000, valueBytes: 8 * 1024 * 1024, stringLength: 131072, wallMs: 4 * 60 * 60 * 1000 });
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
export class MacroError extends Error {
  constructor(message, node, code = 'MACRO_INVALID') {
    const loc = node?.loc || node;
    super(message + (loc?.line ? ' (line ' + loc.line + ', column ' + loc.column + ')' : ''));
    this.name = 'MacroError'; this.code = code; this.line = loc?.line; this.column = loc?.column; this.completedSteps = 0;
  }
}
function safeKey(key, node) { if (typeof key !== 'string' || FORBIDDEN.has(key)) throw new MacroError('Forbidden property or variable: ' + String(key), node); return key; }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function lex(source, limits = MACRO_LIMITS) {
  if (typeof source !== 'string' || source.length > limits.sourceBytes || new TextEncoder().encode(source).length > limits.sourceBytes) throw new MacroError('Macro source exceeds its byte limit.');
  const result = []; let at = 0, line = 1, column = 1;
  const advance = () => { const char = source[at++]; if (char === '\n') { line++; column = 1; } else column++; return char; };
  const add = (type, value, loc) => { if (result.length >= limits.tokens) throw new MacroError('Macro token limit exceeded.', loc, 'RESOURCE_LIMIT'); result.push({ type, value, loc }); };
  while (at < source.length) {
    if (/\s/.test(source[at])) { advance(); continue; }
    if (source.startsWith('//', at)) { while (at < source.length && source[at] !== '\n') advance(); continue; }
    if (source.startsWith('/*', at)) { const loc = { line, column }; advance(); advance(); while (at < source.length && !source.startsWith('*/', at)) advance(); if (at === source.length) throw new MacroError('Unclosed comment.', loc); advance(); advance(); continue; }
    const loc = { line, column, offset: at }, char = source[at];
    if (char === '"' || char === "'") {
      const quote = advance(); let value = '', closed = false;
      while (at < source.length) {
        let next = advance();
        if (next === quote) { closed = true; break; }
        if (next === '\n' || next === '\r') throw new MacroError('A string cannot contain an unescaped line break.', loc);
        if (next === '\\') {
          if (at >= source.length) break;
          next = advance();
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" };
          if (next === 'u') {
            const hex = source.slice(at, at + 4); if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new MacroError('Invalid Unicode escape.', loc);
            value += String.fromCharCode(parseInt(hex, 16)); for (let i = 0; i < 4; i++) advance();
          } else if (own(escapes, next)) value += escapes[next];
          else throw new MacroError('Unsupported string escape.', loc);
        } else value += next;
      }
      if (!closed) throw new MacroError('Unclosed string.', loc);
      add('string', value, loc); continue;
    }
    if (/[0-9]/.test(char) || char === '.' && /[0-9]/.test(source[at + 1] || '')) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
      const value = Number(match[0]); if (!Number.isFinite(value)) throw new MacroError('Numbers must be finite.', loc);
      for (let i = 0; i < match[0].length; i++) advance(); add('number', value, loc); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = ''; while (at < source.length && /[A-Za-z0-9_$]/.test(source[at])) value += advance();
      if (value.length > 128) throw new MacroError('Identifier is too long.', loc);
      safeKey(value, loc); add('id', value, loc); continue;
    }
    const operator = ['===', '!==', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/='].find(value => source.startsWith(value, at)) || char;
    if (!['===','!==','<=','>=','==','!=','&&','||','+=','-=','*=','/=','(',')','{','}','[',']',',',';',':','.','+','-','*','/','%','!','<','>','='].includes(operator)) throw new MacroError('Unexpected character: ' + char, loc);
    for (let i = 0; i < operator.length; i++) advance(); add('punct', operator, loc);
  }
  add('eof', '<end>', { line, column, offset: at }); return result;
}

export function parseMacro(source, limits = MACRO_LIMITS) {
  const bound = { ...MACRO_LIMITS };
  for (const [key,value] of Object.entries(limits)) { if (!own(bound,key)||!Number.isSafeInteger(value)||value<1||value>bound[key]) throw new MacroError('Invalid macro limit: '+key); bound[key]=value; }
  const tokens = lex(source, bound); let at = 0, depth = 0, nodes = 0;
  const current = () => tokens[at];
  const is = value => !['string', 'number'].includes(current().type) && current().value === value;
  const take = value => { const token = current(); if (value !== undefined && !is(value)) throw new MacroError('Expected "' + value + '", found "' + token.value + '".', token); at++; return token; };
  const consume = value => is(value) ? (take(), true) : false;
  const node = (type, fields, token) => { if (++nodes > bound.nodes) throw new MacroError('Macro AST limit exceeded.', token, 'RESOURCE_LIMIT'); return { type, ...fields, loc: token?.loc }; };
  const nested = fn => { if (++depth > bound.depth) throw new MacroError('Macro nesting limit exceeded.', current(), 'RESOURCE_LIMIT'); try { return fn(); } finally { depth--; } };
  const identifier = () => { const token = take(); if (token.type !== 'id' || ['let','if','else','repeat','for','of','while','true','false','null','break','continue'].includes(token.value)) throw new MacroError('Expected a variable name.', token); return token; };
  const end = () => { if (!consume(';') && !is('}') && current().type !== 'eof') throw new MacroError('End this statement with a semicolon.', current()); };
  const precedence = { '||':1, '&&':2, '==':3, '!=':3, '===':3, '!==':3, '<':4, '>':4, '<=':4, '>=':4, '+':5, '-':5, '*':6, '/':6, '%':6 };
  const commandName = expression => {
    if (expression.type === 'Identifier') return expression.name;
    if (expression.type === 'MemberExpression' && !expression.computed) { const root = commandName(expression.object); return root && root + '.' + expression.property.value; }
    return null;
  };
  function primary() {
    return nested(() => {
      const token = current(); let value;
      if (token.type === 'number' || token.type === 'string') { take(); value = node('Literal', { value: token.value }, token); }
      else if (['true','false','null'].includes(token.value)) { take(); value = node('Literal', { value: token.value === 'null' ? null : token.value === 'true' }, token); }
      else if (consume('(')) { value = expression(); take(')'); }
      else if (consume('[')) {
        const elements = []; if (!is(']')) do { elements.push(expression()); } while (consume(',') && !is(']'));
        take(']'); value = node('ArrayExpression', { elements }, token);
      } else if (consume('{')) {
        const properties = [], keys = new Set();
        if (!is('}')) do {
          const key = take(); if (!['id','string','number'].includes(key.type)) throw new MacroError('Expected an object key.', key);
          const name = safeKey(String(key.value), key); if (keys.has(name)) throw new MacroError('Duplicate object key: ' + name, key); keys.add(name);
          take(':'); properties.push({ key: name, value: expression() });
        } while (consume(',') && !is('}'));
        take('}'); value = node('ObjectExpression', { properties }, token);
      } else if (token.type === 'id') { take(); value = node('Identifier', { name: safeKey(token.value, token) }, token); }
      else throw new MacroError('Expected a value.', token);
      let suffixes = 0;
      while (is('.') || is('[') || is('(')) {
        if (++suffixes > bound.depth) throw new MacroError('Property chain is too deep.', token, 'RESOURCE_LIMIT');
        if (consume('.')) { const property = identifier(); value = node('MemberExpression', { object: value, property: node('Literal', { value: safeKey(property.value, property) }, property), computed: false }, token); }
        else if (consume('[')) { const property = expression(); take(']'); value = node('MemberExpression', { object: value, property, computed: true }, token); }
        else {
          const method = commandName(value); if (!method) throw new MacroError('Only named editor commands and macro data tools can be called.', token);
          take('('); const argument = is(')') ? node('ObjectExpression', { properties: [] }, token) : expression(); take(')');
          value = node('CallExpression', { method, argument }, token);
        }
      }
      return value;
    });
  }
  function unary() { if (current().type === 'punct' && ['!','-','+'].includes(current().value)) { const token = take(); return nested(() => node('UnaryExpression', { operator: token.value, argument: unary() }, token)); } return primary(); }
  function expression(min = 1) {
    return nested(() => {
      let left = unary();
      while (current().type === 'punct' && (precedence[current().value] || 0) >= min) { const token = take(); left = node('BinaryExpression', { operator: token.value, left, right: expression(precedence[token.value] + 1) }, token); }
      return left;
    });
  }
  function block() { const token = take('{'); return nested(() => { const body = []; while (!is('}') && current().type !== 'eof') body.push(statement()); take('}'); return node('BlockStatement', { body }, token); }); }
  function statement() {
    const token = current();
    if (consume('let')) { const name = identifier().value; take('='); const init = expression(); end(); return node('VariableDeclaration', { name, init }, token); }
    if (consume('if')) { take('('); const test = expression(); take(')'); const consequent = block(); let alternate = null; if (consume('else')) alternate = is('if') ? nested(statement) : block(); return node('IfStatement', { test, consequent, alternate }, token); }
    if (consume('repeat')) { take('('); const count = expression(); take(')'); return node('RepeatStatement', { count, body: block() }, token); }
    if (consume('while')) { take('('); const test = expression(); take(')'); return node('WhileStatement', { test, body: block() }, token); }
    if (consume('for')) { take('('); consume('let'); const name = identifier().value; take('of'); const iterable = expression(); take(')'); return node('ForOfStatement', { name, iterable, body: block() }, token); }
    if (consume('break')) { end(); return node('BreakStatement', {}, token); }
    if (consume('continue')) { end(); return node('ContinueStatement', {}, token); }
    if (token.type === 'id' && tokens[at + 1]?.type === 'punct' && ['=','+=','-=','*=','/='].includes(tokens[at + 1]?.value)) { const name = identifier().value, operator = take().value, value = expression(); end(); return node('AssignmentStatement', { name, operator, value }, token); }
    const value = expression(); end(); return node('ExpressionStatement', { expression: value }, token);
  }
  const body = []; while (current().type !== 'eof') body.push(statement());
  const program = node('Program', { version: 1, body }, tokens[0]);
  assertProgram(program, bound);
  return program;
}

// Validate externally supplied ASTs without recursive descent or invoking accessors.
// The depth check also catches very long left-associated expression trees.
function assertProgram(ast, limits = MACRO_LIMITS) {
  const typeOf=value=>value&&Object.getOwnPropertyDescriptor(value,'type')?.value;
  const list=(value,node)=>{
    if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>limits.nodes)throw new MacroError('Invalid AST list.',node);
    for(const key of Reflect.ownKeys(value))if(key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))throw new MacroError('AST lists accept indexed data only.',node);
    for(let index=0;index<value.length;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!own(descriptor,'value'))throw new MacroError('AST lists must be dense data without accessors.',node);}
    return value;
  };
  const shapes = {
    Program:['body'], BlockStatement:['body'], Literal:[], Identifier:[],
    ArrayExpression:['elements'], ObjectExpression:['properties'],
    UnaryExpression:['argument'], BinaryExpression:['left','right'],
    MemberExpression:['object','property'], CallExpression:['argument'],
    ExpressionStatement:['expression'], VariableDeclaration:['init'],
    AssignmentStatement:['value'], IfStatement:['test','consequent','alternate'],
    RepeatStatement:['count','body'], WhileStatement:['test','body'],
    ForOfStatement:['iterable','body'], BreakStatement:[], ContinueStatement:[],
  };
  if (!ast || Object.getOwnPropertyDescriptor(ast,'type')?.value !== 'Program') throw new MacroError('Expected a parsed macro program.');
  const pending = [{node:ast,depth:0}], seen = new Set(); let count=0, semanticBytes=0;
  while(pending.length) {
    const {node,depth}=pending.pop();
    if(!node||typeof node!=='object'||Array.isArray(node)||![Object.prototype,null].includes(Object.getPrototypeOf(node)))throw new MacroError('Invalid macro AST node.');
    if(seen.has(node)||++count>limits.nodes||depth>limits.depth*3)throw new MacroError('Invalid or excessive macro AST.',null,'RESOURCE_LIMIT');
    seen.add(node);
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node)))if(!own(descriptor,'value')||FORBIDDEN.has(key))throw new MacroError('Invalid macro AST property.');
    if(!own(shapes,node.type))throw new MacroError('Unknown macro AST node: '+String(node.type),node);
    if(node.loc){
      if(![Object.prototype,null].includes(Object.getPrototypeOf(node.loc)))throw new MacroError('Invalid source location.');
      for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(node.loc)))if(!own(descriptor,'value'))throw new MacroError('Invalid source location.');
      const line=Object.getOwnPropertyDescriptor(node.loc,'line')?.value,column=Object.getOwnPropertyDescriptor(node.loc,'column')?.value;
      if(!Number.isSafeInteger(line)||line<1||!Number.isSafeInteger(column)||column<1)throw new MacroError('Invalid source location.');
    }
    if(node.type==='Literal' && !(node.value===null||['string','boolean'].includes(typeof node.value)||typeof node.value==='number'&&Number.isFinite(node.value)))throw new MacroError('Invalid literal.',node);
    if(['Identifier','VariableDeclaration','AssignmentStatement','ForOfStatement'].includes(node.type) && (typeof node.name!=='string'||!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(node.name)))throw new MacroError('Invalid variable name.',node);
    if(node.name)safeKey(node.name,node);
    for(const key of ['name','method','value'])if(typeof node[key]==='string'){semanticBytes+=node[key].length*2;if(semanticBytes>limits.sourceBytes*2)throw new MacroError('Macro AST text exceeds its source budget.',node,'RESOURCE_LIMIT');}
    if(node.type==='CallExpression' && (typeof node.method!=='string'||node.method.length>256||!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(node.method)))throw new MacroError('Invalid command name.',node);
    if(node.type==='CallExpression')for(const part of node.method.split('.'))safeKey(part,node);
    if(node.type==='MemberExpression'){
      if(typeof node.computed!=='boolean')throw new MacroError('Invalid member access mode.',node);
      if(!node.computed&&(Object.getOwnPropertyDescriptor(node.property||{},'type')?.value!=='Literal'||typeof Object.getOwnPropertyDescriptor(node.property,'value')?.value!=='string'||!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(node.property.value)))throw new MacroError('A dot property must be a safe identifier.',node);
      if(!node.computed)safeKey(node.property.value,node);
    }
    if(node.type==='UnaryExpression'&&!['!','+','-'].includes(node.operator))throw new MacroError('Invalid unary operator.',node);
    if(node.type==='BinaryExpression'&&!['+','-','*','/','%','<','>','<=','>=','==','!=','===','!==','&&','||'].includes(node.operator))throw new MacroError('Invalid binary operator.',node);
    if(node.type==='AssignmentStatement'&&!['=','+=','-=','*=','/='].includes(node.operator))throw new MacroError('Invalid assignment operator.',node);
    if(['RepeatStatement','WhileStatement','ForOfStatement'].includes(node.type)&&typeOf(node.body)!=='BlockStatement')throw new MacroError('A loop needs a block.',node);
    if(node.type==='IfStatement'&&(typeOf(node.consequent)!=='BlockStatement'||node.alternate&&!['BlockStatement','IfStatement'].includes(typeOf(node.alternate))))throw new MacroError('Invalid conditional block.',node);
    for(const key of shapes[node.type]){
      const value=node[key];
      if(key==='alternate'&&value===null)continue;
      if(key==='properties') {
        list(value,node);
        const keys=new Set();
        for(const property of value){
          if(!property||typeof property!=='object'||!Object.getOwnPropertyDescriptor(property,'key')?.hasOwnProperty('value')||!Object.getOwnPropertyDescriptor(property,'value')?.hasOwnProperty('value'))throw new MacroError('Invalid object property.',node);
          safeKey(property.key,node);semanticBytes+=property.key.length*2;if(semanticBytes>limits.sourceBytes*2)throw new MacroError('Macro AST text exceeds its source budget.',node,'RESOURCE_LIMIT');if(keys.has(property.key))throw new MacroError('Duplicate object key.',node);keys.add(property.key);pending.push({node:property.value,depth:depth+1});
        }
      } else if(key==='elements'||key==='body'&&['Program','BlockStatement'].includes(node.type)) {
        list(value,node);
        for(const child of value)pending.push({node:child,depth:depth+1});
      } else pending.push({node:value,depth:depth+1});
    }
  }
}

function applyOperator(operator, left, right, node) {
  if (['==','==='].includes(operator)) return left === right;
  if (['!=','!=='].includes(operator)) return left !== right;
  if (['<','>','<=','>='].includes(operator)) {
    if (!(['number','string'].includes(typeof left) && typeof left === typeof right)) throw new MacroError('Compare two numbers or two strings.', node);
    return operator === '<' ? left < right : operator === '>' ? left > right : operator === '<=' ? left <= right : left >= right;
  }
  if (operator === '+' && typeof left === 'string' && typeof right === 'string') { if (left.length + right.length > MACRO_LIMITS.stringLength) throw new MacroError('String size limit exceeded.', node, 'RESOURCE_LIMIT'); return left + right; }
  if (typeof left !== 'number' || typeof right !== 'number') throw new MacroError('Arithmetic requires finite numbers.', node);
  if ((operator === '/' || operator === '%') && right === 0) throw new MacroError('Division by zero.', node);
  const result = operator === '+' ? left + right : operator === '-' ? left - right : operator === '*' ? left * right : operator === '/' ? left / right : left % right;
  if (!Number.isFinite(result)) throw new MacroError('Arithmetic result is not finite.', node); return result;
}
function constant(node) {
  if (node.type === 'Literal') return { known: true, value: node.value };
  if (node.type === 'UnaryExpression') { const a = constant(node.argument); if (!a.known) return a; if (node.operator === '!') return { known:true,value:!a.value }; if (typeof a.value !== 'number') throw new MacroError('Unary arithmetic requires a number.', node); return { known:true,value:node.operator === '-' ? -a.value : a.value }; }
  if (node.type === 'ArrayExpression') { const items = node.elements.map(constant); return items.every(x => x.known) ? { known:true,value:items.map(x => x.value) } : { known:false }; }
  if (node.type === 'ObjectExpression') { const value = Object.create(null); for (const property of node.properties) { const item = constant(property.value); if (!item.known) return { known:false }; value[safeKey(property.key, node)] = item.value; } return { known:true,value }; }
  if (node.type === 'BinaryExpression') { const a=constant(node.left); if(!a.known)return a; if(node.operator==='&&'&&!a.value||node.operator==='||'&&a.value)return a; const b=constant(node.right); if(!b.known)return b; return {known:true,value:node.operator==='&&'||node.operator==='||'?b.value:applyOperator(node.operator,a.value,b.value,node)}; }
  return { known:false };
}
const WAIT = { method:'wait', schema:{ type:'object', properties:{ seconds:{type:'number',minimum:0,maximum:86400}, beats:{type:'number',minimum:0,maximum:100000} }, additionalProperties:false }, description:'Wait seconds or project beats, with cancellation.', recordable:false };
function partialConstant(node){
  if(node.type==='ObjectExpression'){const value=Object.create(null);for(const property of node.properties)value[property.key]=partialConstant(property.value);return value;}
  if(node.type==='ArrayExpression')return node.elements.map(partialConstant);
  const result=constant(node);return result.known?result.value:STATIC_UNKNOWN;
}
export function validateMacro(ast, catalog = [], { variables } = {}) {
  const commands = new Map((Array.isArray(catalog) ? catalog : catalog.all || [...(catalog.core || []), ...(catalog.ui || [])]).map(entry => [entry.method || entry.id, entry])); commands.set('wait', WAIT);
  for (const descriptor of MACRO_BUILTINS) commands.set(descriptor.method, descriptor);
  const errors = []; let count = 0;
  const visit = (node, depth=0, loops=0) => {
    if (!node || typeof node !== 'object' || ++count > MACRO_LIMITS.nodes || depth > MACRO_LIMITS.depth * 3) throw new MacroError('Invalid or excessive macro AST.', node, 'RESOURCE_LIMIT');
    if (node.type === 'CallExpression') {
      const descriptor = commands.get(node.method);
      if (!descriptor) errors.push(new MacroError('Unknown command: ' + node.method, node, 'UNKNOWN_COMMAND'));
      else if (descriptor.available === false) errors.push(new MacroError('Command is unavailable here: ' + node.method, node, 'UNSUPPORTED_CAPABILITY'));
      else { try { validateStaticCommandParams(partialConstant(node.argument), descriptor); } catch (error) { errors.push(Object.assign(new MacroError(error.message, node, error.code),{command:node.method})); } }
    }
    if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && !loops) errors.push(new MacroError(node.type === 'BreakStatement' ? 'break requires a loop.' : 'continue requires a loop.', node));
    if (node.type === 'Identifier') safeKey(node.name,node);
    if (node.type === 'ObjectExpression') for (const property of node.properties) safeKey(property.key,node);
    for (const [key,value] of Object.entries(node)) {
      if (key === 'loc') continue;
      const nextLoops = loops + (['RepeatStatement','WhileStatement','ForOfStatement'].includes(node.type) && key === 'body' ? 1 : 0);
      if (Array.isArray(value)) for (const entry of value) { if (entry?.type) visit(entry,depth+1,nextLoops); else if (entry?.value?.type) visit(entry.value,depth+1,nextLoops); }
      else if (value?.type) visit(value,depth+1,nextLoops);
    }
  };
  try {
    assertProgram(ast); visit(ast);
    // The runner supplies exact initial names. UI validation can omit this set
    // when a script expects custom variables supplied by its caller.
    if(variables) {
      const root = new Set(variables);
      const expr=(node,scopes)=>{
        if(node.type==='Identifier'&&!scopes.some(scope=>scope.has(node.name)))throw new MacroError('Unknown variable: '+node.name,node);
        for(const key of ['argument','left','right','object','property'])if(node[key]?.type)expr(node[key],scopes);
        for(const item of node.elements||[])expr(item,scopes);
        for(const property of node.properties||[])expr(property.value,scopes);
      };
      const block=(body,scopes)=>{
        for(const item of body){
          if(item.type==='VariableDeclaration'){expr(item.init,scopes);if(scopes[0].has(item.name))throw new MacroError('Variable already declared: '+item.name,item);scopes[0].add(item.name);}
          else if(item.type==='AssignmentStatement'){if(!scopes.some(scope=>scope.has(item.name)))throw new MacroError('Assign only to a declared variable: '+item.name,item);expr(item.value,scopes);}
          else if(item.type==='ExpressionStatement')expr(item.expression,scopes);
          else if(item.type==='IfStatement'){expr(item.test,scopes);block(item.consequent.body,[new Set(),...scopes]);if(item.alternate)block(item.alternate.type==='IfStatement'?[item.alternate]:item.alternate.body,[new Set(),...scopes]);}
          else if(['RepeatStatement','WhileStatement','ForOfStatement'].includes(item.type)){expr(item.count||item.test||item.iterable,scopes);const local=new Set();if(item.type==='ForOfStatement')local.add(item.name);block(item.body.body,[local,...scopes]);}
        }
      };
      block(ast.body,[root]);
    }
  } catch (error) { errors.push(error); }
  return { valid:errors.length===0, errors:errors.map(error=>({message:error.message,code:error.code,line:error.line,column:error.column})) };
}
function expressionText(node) {
  switch(node.type) {
    case 'Literal':return JSON.stringify(node.value);
    case 'Identifier':return node.name;
    case 'ArrayExpression':return '['+node.elements.map(expressionText).join(', ')+']';
    case 'ObjectExpression':return '{'+node.properties.map(p=>JSON.stringify(p.key)+': '+expressionText(p.value)).join(', ')+'}';
    case 'UnaryExpression':return '('+node.operator+expressionText(node.argument)+')';
    case 'BinaryExpression':return '('+expressionText(node.left)+' '+node.operator+' '+expressionText(node.right)+')';
    case 'MemberExpression':return expressionText(node.object)+(node.computed?'['+expressionText(node.property)+']':'.'+node.property.value);
    case 'CallExpression':return node.method+'('+expressionText(node.argument)+')';
    default:throw new MacroError('Unknown expression node.',node);
  }
}
export function formatMacro(ast) {
  assertProgram(ast);
  const emit = (node, depth=0) => {
    const indent='  '.repeat(depth), block = child => '{\n'+child.body.map(n=>emit(n,depth+1)).join('\n')+'\n'+indent+'}';
    switch(node.type) {
      case 'Program':return '// WebSoundEdit Macro 1\n'+node.body.map(n=>emit(n,0)).join('\n')+'\n';
      case 'ExpressionStatement':return indent+expressionText(node.expression)+';';
      case 'VariableDeclaration':return indent+'let '+node.name+' = '+expressionText(node.init)+';';
      case 'AssignmentStatement':return indent+node.name+' '+node.operator+' '+expressionText(node.value)+';';
      case 'IfStatement':return indent+'if ('+expressionText(node.test)+') '+block(node.consequent)+(node.alternate?' else '+(node.alternate.type==='IfStatement'?emit(node.alternate,depth).trimStart():block(node.alternate)):'');
      case 'RepeatStatement':return indent+'repeat ('+expressionText(node.count)+') '+block(node.body);
      case 'WhileStatement':return indent+'while ('+expressionText(node.test)+') '+block(node.body);
      case 'ForOfStatement':return indent+'for ('+node.name+' of '+expressionText(node.iterable)+') '+block(node.body);
      case 'BreakStatement':return indent+'break;';
      case 'ContinueStatement':return indent+'continue;';
      default:throw new MacroError('Unknown statement node.',node);
    }
  };
  const output=emit(ast);if(output.length>MACRO_LIMITS.sourceBytes||new TextEncoder().encode(output).length>MACRO_LIMITS.sourceBytes)throw new MacroError('Formatted macro exceeds 128 KiB.',null,'RESOURCE_LIMIT');return output;
}
// Inspect semantic edges only, after parseMacro/assertProgram has bounded and
// validated the AST. Text scripts may compose commands; one visual step may not.
function hasNestedCommands(expression) {
  const pending = [expression];
  while (pending.length) {
    const node = pending.pop();
    switch (node.type) {
      case 'CallExpression': return true;
      case 'ArrayExpression': for (const item of node.elements) pending.push(item); break;
      case 'ObjectExpression': for (const property of node.properties) pending.push(property.value); break;
      case 'UnaryExpression': pending.push(node.argument); break;
      case 'BinaryExpression': pending.push(node.left, node.right); break;
      case 'MemberExpression': pending.push(node.object, node.property); break;
      case 'Literal': case 'Identifier': break;
      default: throw new MacroError('Expected an expression in a visual step.', node);
    }
  }
  return false;
}
export function stepsToMacro(steps) {
  if (!Array.isArray(steps) || steps.length > MACRO_LIMITS.commands) throw new MacroError('Too many recorded steps.');
  let bytes=0;
  return formatMacro(parseMacro(steps.map(step=>{
    if (typeof step.method!=='string' || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(step.method)) throw new MacroError('Invalid command name in a step.');
    const text=step.method+'('+(step.paramsSource ?? JSON.stringify(safeValue(step.params ?? {})))+');';
    if((bytes+=new TextEncoder().encode(text).length+1)>MACRO_LIMITS.sourceBytes)throw new MacroError('Recorded steps exceed 128 KiB.',null,'RESOURCE_LIMIT');
    const ast=parseMacro(text);
    if(ast.body.length!==1||ast.body[0].type!=='ExpressionStatement'||ast.body[0].expression.type!=='CallExpression'||ast.body[0].expression.method!==step.method) throw new MacroError('A visual step must contain exactly one command.');
    if(hasNestedCommands(ast.body[0].expression.argument)) throw new MacroError('A visual step cannot hide a nested command; use the text editor for command composition.');
    return text;
  }).join('\n')));
}
export function macroToSteps(source) {
  const ast=typeof source==='string'?parseMacro(source):source;
  assertProgram(ast);
  if(ast?.type!=='Program'||ast.body.some(n=>n.type!=='ExpressionStatement'||n.expression.type!=='CallExpression'||hasNestedCommands(n.expression.argument)))return null;
  return ast.body.map(n=>{let value;try{value=constant(n.expression.argument);}catch{value={known:false};}return {method:n.expression.method,...(value.known?{params:value.value}:{}),paramsSource:expressionText(n.expression.argument)};});
}
function safeValue(value, limits=MACRO_LIMITS, silentDecibels=false) {
  let count=0,bytes=0;
  const copy=(item,depth)=>{
    bytes+=8;
    if(++count>limits.valueNodes||depth>limits.depth||bytes>limits.valueBytes)throw new MacroError('Macro value limit exceeded.',null,'RESOURCE_LIMIT');
    if(item===undefined)return null;
    if(item===null||typeof item==='boolean')return item;
    if(typeof item==='number'){if(silentDecibels&&item===-Infinity)return null;if(!Number.isFinite(item))throw new MacroError('Macro values must be finite.');return item;}
    if(typeof item==='string'){bytes+=item.length*2;if(item.length>limits.stringLength||bytes>limits.valueBytes)throw new MacroError('Macro string limit exceeded.',null,'RESOURCE_LIMIT');return item;}
    if(ArrayBuffer.isView(item)){if(!Number.isSafeInteger(item.length)||item.length>limits.valueNodes-count)throw new MacroError('PCM/binary results are too large for a macro variable. Use an export or analysis command.',null,'RESOURCE_LIMIT');const output=[];for(let index=0;index<item.length;index++)output.push(copy(item[index],depth+1));return output;}
    if(Array.isArray(item)){
      if(item.length>limits.valueNodes-count)throw new MacroError('Macro array exceeds its item limit.',null,'RESOURCE_LIMIT');
      for(const key of Reflect.ownKeys(item))if(key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))throw new MacroError('Macro arrays accept indexed data only.');
      const output=[];for(let index=0;index<item.length;index++){const descriptor=Object.getOwnPropertyDescriptor(item,String(index));if(!descriptor||!own(descriptor,'value'))throw new MacroError('Macro arrays must be dense data without accessors.');output.push(copy(descriptor.value,depth+1));}return output;
    }
    if(!item||typeof item!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new MacroError('Macro values must be data, not executable objects.');
    const out=Object.create(null);
    for(const key of Object.keys(item)){const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!own(descriptor,'value'))throw new MacroError('Macro values cannot contain accessors.');bytes+=key.length*2;out[safeKey(key)]=copy(descriptor.value,depth+1);}
    return out;
  };
  return copy(value,0);
}
class Scope {
  constructor(parent=null){this.parent=parent;this.values=new Map();}
  get(name,node){safeKey(name,node);if(this.values.has(name))return this.values.get(name);if(this.parent)return this.parent.get(name,node);throw new MacroError('Unknown variable: '+name,node);}
  define(name,value,node){safeKey(name,node);if(this.values.has(name))throw new MacroError('Variable already declared: '+name,node);this.values.set(name,value);}
  set(name,value,node){if(this.values.has(name)){this.values.set(name,value);return;}if(this.parent)return this.parent.set(name,value,node);throw new MacroError('Assign only to a declared variable: '+name,node);}
}
function checkHeap(scope,limits) {
  const pending=[],seen=new Set();let nodes=0,bytes=0;
  for(let current=scope;current;current=current.parent)for(const [key,value] of current.values){bytes+=key.length*2;pending.push(value);}
  while(pending.length){
    const value=pending.pop();if(value&&typeof value==='object'){if(seen.has(value))continue;seen.add(value);}
    if(++nodes>limits.valueNodes||(bytes+=8)>limits.valueBytes)throw new MacroError('Macro variables exceed the aggregate memory budget.',null,'RESOURCE_LIMIT');
    if(typeof value==='string')bytes+=value.length*2;
    else if(Array.isArray(value))for(const item of value)pending.push(item);
    else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){bytes+=key.length*2;pending.push(item);}
    if(bytes>limits.valueBytes)throw new MacroError('Macro variables exceed the aggregate memory budget.',null,'RESOURCE_LIMIT');
  }
}
export class MacroRunner {
  constructor({execute,getCommands=()=>[],getContext=()=>({})}){if(typeof execute!=='function')throw new TypeError('MacroRunner requires execute.');this.execute=execute;this.getCommands=getCommands;this.getContext=getContext;this.controller=null;}
  cancel(){this.controller?.abort();}
  async run(text,options={}) {
    if(this.controller)throw new MacroError('A macro is already running.',null,'MACRO_BUSY');
    const controller=new AbortController();this.controller=controller;
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    try{return await this._run(text,options,controller);}
    finally{options.signal?.removeEventListener('abort',abort);if(this.controller===controller)this.controller=null;}
  }
  async _run(text,{variables={},onEvent=()=>{},limits={}}={},controller) {
    const bound={...MACRO_LIMITS};
    for(const [key,value] of Object.entries(limits)){if(!own(bound,key)||!Number.isSafeInteger(value)||value<1||value>bound[key])throw new MacroError('Invalid macro limit: '+key);bound[key]=value;}
    const ast=parseMacro(text,bound),catalog=await this.getCommands(),context=safeValue(await this.getContext(),bound),supplied=safeValue(variables,bound);
    if(!context||Array.isArray(context)||!supplied||Array.isArray(supplied)||typeof context!=='object'||typeof supplied!=='object')throw new MacroError('Macro context and variables must be objects.');
    const validation=validateMacro(ast,catalog,{variables:Object.keys({...context,...supplied})});
    if(!validation.valid){const first=validation.errors[0];throw Object.assign(new MacroError(first.message,null,first.code),{line:first.line,column:first.column,errors:validation.errors});}
    const root=new Scope(),descriptors=new Map((Array.isArray(catalog)?catalog:catalog.all||[...(catalog.core||[]),...(catalog.ui||[])]).map(entry=>[entry.method||entry.id,entry]));
    for (const descriptor of MACRO_BUILTINS) descriptors.set(descriptor.method, descriptor);
    for(const [name,value] of Object.entries({...context,...supplied}))root.define(name,value);
    checkHeap(root,bound);
    const started=Date.now();let operations=0,nextYield=128,iterations=0,completedSteps=0,lastResult=null;
    const builtin = createMacroBuiltins({ limits: bound, charge: cost => {
      if (controller.signal.aborted) throw Object.assign(new Error('Macro canceled. Completed operations remain applied.'), { code: 'ABORTED' });
      if (!Number.isSafeInteger(cost) || cost < 0 || (operations += cost) > bound.operations || Date.now() - started > bound.wallMs) throw Object.assign(new Error('Macro execution limit exceeded.'), { code: 'RESOURCE_LIMIT' });
    } });
    const emit=event=>{try{onEvent({...event,completedSteps});}catch{}};
    const check=async node=>{
      if(controller.signal.aborted)throw new MacroError('Macro canceled. Completed operations remain applied.',node,'ABORTED');
      if(++operations>bound.operations||Date.now()-started>bound.wallMs)throw new MacroError('Macro execution limit exceeded.',node,'RESOURCE_LIMIT');
      // Builtins charge work in batches, so their counters can jump past an
      // exact multiple. Yield at a threshold so UI cancellation still runs.
      if(operations>=nextYield){nextYield=operations+128;await new Promise(resolve=>setTimeout(resolve,0));if(controller.signal.aborted)throw new MacroError('Macro canceled. Completed operations remain applied.',node,'ABORTED');}
    };
    const delay=ms=>new Promise((resolve,reject)=>{
      const timer=setTimeout(done,ms);const cancel=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',cancel);reject(new MacroError('Macro canceled. Completed operations remain applied.',null,'ABORTED'));};
      function done(){controller.signal.removeEventListener('abort',cancel);resolve();}
      controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();
    });
    const evaluate=async(node,scope,retain=true)=>{
      await check(node);
      switch(node.type){
        case 'Literal':return node.value;
        case 'Identifier':return scope.get(node.name,node);
        case 'ArrayExpression':{const result=[];for(const entry of node.elements)result.push(await evaluate(entry,scope));return safeValue(result,bound);}
        case 'ObjectExpression':{const result=Object.create(null);for(const entry of node.properties)result[safeKey(entry.key,node)]=await evaluate(entry.value,scope);return safeValue(result,bound);}
        case 'UnaryExpression':{const value=await evaluate(node.argument,scope);if(node.operator==='!')return !value;if(typeof value!=='number')throw new MacroError('Unary arithmetic requires a number.',node);return node.operator==='-'?-value:value;}
        case 'BinaryExpression':{const left=await evaluate(node.left,scope);if(node.operator==='&&')return left&&await evaluate(node.right,scope);if(node.operator==='||')return left||await evaluate(node.right,scope);return applyOperator(node.operator,left,await evaluate(node.right,scope),node);}
        case 'MemberExpression':{const object=await evaluate(node.object,scope),raw=await evaluate(node.property,scope);if(!['string','number'].includes(typeof raw))throw new MacroError('Property names must be strings or indices.',node);const key=safeKey(String(raw),node);if(object===null||!['object','string'].includes(typeof object)||!own(Object(object),key))throw new MacroError('Missing own property: '+key,node);return object[key];}
        case 'CallExpression':{try{
          if(completedSteps>=bound.commands)throw new MacroError('Macro command limit exceeded.',node,'RESOURCE_LIMIT');
          const params=await evaluate(node.argument,scope);let result;
          // Arguments may contain other calls. Recheck before the outer command
          // so a nested data tool cannot spend the final slot then start an edit.
          if(completedSteps>=bound.commands)throw new MacroError('Macro command limit exceeded.',node,'RESOURCE_LIMIT');
          if(isMacroBuiltin(node.method)) {
            validateCommandParams(params, descriptors.get(node.method)); result = builtin(node.method, params);
          } else if(node.method==='wait'){
            validateCommandParams(params,WAIT);if((params.seconds===undefined)===(params.beats===undefined))throw new MacroError('wait needs exactly one of seconds or beats.',node);
            const liveContext=await this.getContext();const bpm=liveContext.state?.bpm??liveContext.project?.bpm??liveContext.bpm??120;
            const seconds=params.seconds??params.beats*60/bpm;if(!Number.isFinite(seconds)||seconds<0||seconds*1000>bound.wallMs-(Date.now()-started))throw new MacroError('Wait exceeds the remaining macro time limit.',node,'RESOURCE_LIMIT');
            await delay(seconds*1000);result={seconds};
          }else {validateCommandParams(params,descriptors.get(node.method));result=await this.execute(node.method,params,{origin:'macro',signal:controller.signal,record:false});}
          // Digital silence has -Infinity dB in the DSP API. Macro data uses the
          // same null representation as JSON, so scripts can test it explicitly.
          completedSteps++;emit({type:'step',method:node.method,line:node.loc?.line});lastResult=retain?safeValue(result,bound,node.method==='analysis.stats'):null;return lastResult;
        }catch(error){const failure=error instanceof MacroError?error:new MacroError(error.message,node,error.code||'MACRO_COMMAND_FAILED');failure.command??=node.method;throw failure;}
        }
        default:throw new MacroError('Unsupported expression.',node);
      }
    };
    const statements=async(body,scope)=>{for(const item of body){const flow=await statement(item,scope);if(flow)return flow;}return null;};
    const loopBody=async(node,scope)=>{if(++iterations>bound.iterations)throw new MacroError('Macro loop limit exceeded.',node,'RESOURCE_LIMIT');return statements(node.body.body,new Scope(scope));};
    const statement=async(node,scope)=>{
      await check(node);
      switch(node.type){
        case 'ExpressionStatement':await evaluate(node.expression,scope,false);break;
        case 'VariableDeclaration':scope.define(node.name,safeValue(await evaluate(node.init,scope),bound),node);checkHeap(scope,bound);break;
        case 'AssignmentStatement':{let value=await evaluate(node.value,scope);if(node.operator!=='=')value=applyOperator(node.operator[0],scope.get(node.name,node),value,node);scope.set(node.name,safeValue(value,bound),node);checkHeap(scope,bound);break;}
        case 'IfStatement':{const branch=await evaluate(node.test,scope)?node.consequent:node.alternate;if(branch)return branch.type==='BlockStatement'?statements(branch.body,new Scope(scope)):statement(branch,scope);break;}
        case 'RepeatStatement':{const count=await evaluate(node.count,scope);if(!Number.isSafeInteger(count)||count<0||count>bound.iterations)throw new MacroError('repeat requires a bounded nonnegative integer.',node);for(let i=0;i<count;i++){const flow=await loopBody(node,scope);if(flow==='break')break;}break;}
        case 'WhileStatement':while(await evaluate(node.test,scope)){const flow=await loopBody(node,scope);if(flow==='break')break;}break;
        case 'ForOfStatement':{const values=await evaluate(node.iterable,scope);if(!Array.isArray(values)||values.length>bound.iterations)throw new MacroError('for requires a bounded array.',node);for(const value of values){const local=new Scope(scope);local.define(node.name,value,node);const flow=await loopBody(node,local);if(flow==='break')break;}break;}
        case 'BreakStatement':return 'break';
        case 'ContinueStatement':return 'continue';
        default:throw new MacroError('Unsupported statement.',node);
      }
      return null;
    };
    emit({type:'start'});
    try{await statements(ast.body,root);await check(ast);const result={completedSteps,variables:safeValue(Object.fromEntries(root.values),bound),lastResult};emit({type:'complete'});return result;}
    catch(error){const failure=error instanceof MacroError?error:Object.assign(new MacroError(error.message,null,error.code||'MACRO_COMMAND_FAILED'),{cause:error});failure.completedSteps=completedSteps;emit({type:'error',error:{message:failure.message,code:failure.code,line:failure.line,column:failure.column}});throw failure;}
  }
}
