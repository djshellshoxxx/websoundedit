#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AudioEditor } from '../src/engine.js';
import { parseMacro, validateMacro } from '../src/macro.js';
import { decodeAudioBytes, encodeAudioBytes, nativeCapabilities } from './node-codecs.mjs';
import { NodeWorkbench, safeArtifactStem } from './node-runtime.mjs';

const help=[
'WebSoundEdit 1.0 beta · Circuit Drift Labs','',
'Usage:',
'  node scripts/cli.mjs --input recording.wav --recipe examples/cleanup.json --output result.wav',
'  node scripts/cli.mjs --input recording.wav --macro cleanup.wsemacro --output-dir exports',
'  node scripts/cli.mjs --batch --input a.wav --input b.wav --macro cleanup.wsemacro --output-dir exports',
'  node scripts/cli.mjs --input input.mp3 --output output.opus --format opus','',
'Options:',
'  --input FILE        Explicit local input (repeat; up to 128 inputs)',
'  --project FILE      Load a WebSoundEdit JSON project first',
'  --recipe FILE       Existing atomic JSON recipe format',
'  --macro FILE        Bounded Macro1 text; variables input, inputs and project',
'  --batch             Isolated sequential editor per input; requires --macro and --output-dir',
'  --continue-on-error Keep processing later batch files and report failures',
'  --output-dir DIR    Destination for macro exports; existing files never overwritten',
'  --output FILE       Render the final mix (or --scope)',
'  --format FORMAT     wav, mp3, flac, ogg, opus, aac, m4a, alac, aiff, wma',
'  --scope SCOPE       mix, track, clip or selection',
'  --layout LAYOUT     mono, stereo, 5.1 or 7.1; project defaults to stereo',
'  --bit-depth N       16, 24 or 32; default 16',
'  --float             Float32 WAV for final --output',
'  --bitrate N         Compressed kb/s; default 192',
'  --sample-rate N     New project sample rate; default 48000',
'  --save-project FILE Save editable JSON with embedded PCM',
'  --commands          Print commands, schemas and capability availability',
'  --capabilities      Report installed FFmpeg encoders',
'  --help              Show this help','',
'Macros use supplied file aliases; they cannot read paths or run shell commands.',
'Browser input/playback/looping is available through the browser SDK. Headless',
'commands advertise unsupported browser capabilities. UDP uses scripts/server.mjs.',
].join('\n')+'\n';
const includesCommand=(node,method)=>node&&typeof node==='object'&&(node.type==='CallExpression'&&node.method===method||Object.values(node).some(value=>Array.isArray(value)?value.some(item=>includesCommand(item,method)):value&&typeof value==='object'&&includesCommand(value,method)));
async function boundedFile(file,max=256*1024*1024){const info=await stat(file);if(!info.isFile()||info.size<1||info.size>max)throw new Error('Input must be a nonempty file within '+max+' bytes: '+file);const value=await readFile(file);if(value.length>max)throw new Error('Input grew beyond its size limit.');return new Uint8Array(value);}
async function createSink(directory){
  const root=resolve(directory);await mkdir(root,{recursive:true});const used=new Set();
  return async artifact=>{
    const suffix='.'+artifact.ext,raw=artifact.name.endsWith(suffix)?artifact.name.slice(0,-suffix.length):artifact.name,stem=safeArtifactStem(raw);
    for(let attempt=0;attempt<4096;attempt++){
      const name=stem+(attempt?' ('+(attempt+1)+')':'')+suffix;
      if(used.has(name.toLowerCase()))continue;
      try{await writeFile(join(root,name),artifact.bytes,{flag:'wx'});used.add(name.toLowerCase());console.log('Saved '+join(root,name)+' ('+artifact.bytes.length+' bytes).');return;}
      catch(error){if(error.code==='EEXIST')continue;throw error;}
    }
    throw new Error('Too many colliding output filenames.');
  };
}
export async function main(argv=process.argv.slice(2)){
  const options={input:[]},flags=new Set(['help','commands','capabilities','float','batch','continue-on-error']),values=new Set(['input','project','recipe','macro','output-dir','output','format','scope','bit-depth','bitrate','sample-rate','layout','save-project']);
  for(let index=0;index<argv.length;index++){
    if(!argv[index].startsWith('--'))throw new Error('Unexpected argument: '+argv[index]);
    const key=argv[index].slice(2);
    if(flags.has(key))options[key]=true;
    else if(values.has(key)){const value=argv[++index];if(!value||value.startsWith('--'))throw new Error('Missing value for --'+key);if(key==='input')options.input.push(value);else options[key]=value;}
    else throw new Error('Unknown option: --'+key);
  }
  if(options.help||!argv.length){console.log(help);return;}
  if(options.capabilities){console.log(JSON.stringify(await nativeCapabilities(),null,2));return;}
  if(options.input.length>128)throw new Error('Use at most 128 input files per job.');
  if(options.commands){const workbench=new NodeWorkbench();try{console.log(JSON.stringify(workbench.commands(),null,2));}finally{await workbench.dispose();}return;}
  if(!options.output&&!options['save-project']&&!options['output-dir'])throw new Error('Provide --output, --save-project or --output-dir.');
  if(options.batch&&(!options.macro||!options['output-dir']||!options.input.length||options.project||options.output||options['save-project']))throw new Error('Batch requires --macro, one or more --input files and --output-dir; save per-file projects through the script.');
  const macro=options.macro?new TextDecoder('utf-8',{fatal:true}).decode(await boundedFile(options.macro,131072)):null,ast=macro?parseMacro(macro):null;
  const recipe=options.recipe?JSON.parse(new TextDecoder().decode(await boundedFile(options.recipe,1024*1024))):null;
  const sink=options['output-dir']?await createSink(options['output-dir']):null;
  if(ast&&!sink&&(includesCommand(ast,'file.export')||includesCommand(ast,'file.exportStems')))throw new Error('A macro with export commands requires --output-dir.');
  const finalOptions={format:options.format||extname(options.output||'').slice(1).toLowerCase()||'wav',bitDepth:options['bit-depth']?Number(options['bit-depth']):16,float:!!options.float,bitrate:options.bitrate?Number(options.bitrate):192};
  const projectOptions={sampleRate:options['sample-rate']?Number(options['sample-rate']):48000,outputLayout:options.layout||'stereo'};
  if(options.batch){
    const results=[];
    for(const file of options.input){
      const workbench=new NodeWorkbench({editor:new AudioEditor(projectOptions),outputSink:sink});
      try{
        const validation=validateMacro(ast,workbench.commands());if(!validation.valid)throw new Error(validation.errors[0].message);
        const input=workbench.supply(await boundedFile(file),{name:basename(file)});
        if(!includesCommand(ast,'file.import'))await workbench.execute('file.import',{input:input.id},{origin:'batch',record:false});
        if(recipe)await workbench.execute('recipe.run',{commands:Array.isArray(recipe)?recipe:recipe.commands||recipe.steps});
        await workbench.execute('macro.run',{text:macro,variables:{input,inputs:[input],file:input}});
        if(!workbench.outputs.length)await workbench.exportFile({...finalOptions,scope:options.scope||'mix',name:input.stem});
        results.push({file,success:true,outputs:workbench.outputs.map(output=>output.name)});
      }catch(error){results.push({file,success:false,error:error.message});console.error('Failed '+file+': '+error.message);if(!options['continue-on-error'])throw error;}
      finally{await workbench.dispose();}
    }
    console.log(JSON.stringify({batch:results},null,2));if(results.some(result=>!result.success))process.exitCode=1;return;
  }
  const conversionOnly=options.input.length===1&&!options.project&&!recipe&&!macro&&!options.scope&&!options.layout;
  const conversionAudio=conversionOnly?await decodeAudioBytes(await boundedFile(options.input[0])):null;
  const workbench=new NodeWorkbench({editor:new AudioEditor({...projectOptions,sampleRate:options['sample-rate']?Number(options['sample-rate']):conversionAudio?.sampleRate??48000}),outputSink:sink});
  try{
    if(ast){const validation=validateMacro(ast,workbench.commands());if(!validation.valid)throw new Error(validation.errors[0].message);}
    if(options.project)await workbench.execute('project.load',{project:JSON.parse(new TextDecoder().decode(await boundedFile(options.project,384*1024*1024)))});
    const inputs=[];
    for(const file of options.input){
      const alias=workbench.supply(await boundedFile(file),{name:basename(file)});inputs.push(alias);
      if(!ast||!includesCommand(ast,'file.import')){
        if(conversionAudio)await workbench.editor.execute('clip.add',{audio:conversionAudio,name:basename(file)});
        else await workbench.execute('file.import',{input:alias.id});
      }
    }
    if(recipe)await workbench.execute('recipe.run',{commands:Array.isArray(recipe)?recipe:recipe.commands||recipe.steps});
    if(macro)await workbench.execute('macro.run',{text:macro,variables:{inputs,...(inputs[0]?{input:inputs[0]}:{})}});
    if(options.output){
      const audio=await workbench.editor.execute('audio.render',conversionOnly?{scope:'clip',raw:true}:{scope:options.scope||'mix'});
      const bytes=await encodeAudioBytes(audio,{...finalOptions,metadata:workbench.editor.getState().metadata});
      await writeFile(options.output,bytes);console.log('Saved '+options.output+' ('+bytes.length+' bytes).');
    }else if(sink&&!workbench.outputs.length)await workbench.exportFile({...finalOptions,scope:options.scope||'mix'});
    if(options['save-project']){await writeFile(options['save-project'],JSON.stringify(await workbench.editor.execute('project.save')));console.log('Saved '+options['save-project']+'.');}
  }finally{await workbench.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error('WebSoundEdit: '+error.message);process.exitCode=1;});
