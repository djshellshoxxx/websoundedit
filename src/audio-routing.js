import { conversionMatrix, trackMixMatrix } from './channel-layout.js';
/** Explicit discrete routing prevents Web Audio's implicit speaker downmix. */
export function connectMatrix(context,source,from,to,destination,track){
  const matrix=track?trackMixMatrix(from,to,track):conversionMatrix(from,to),inputCount=matrix[0].length,split=context.createChannelSplitter(inputCount),merge=context.createChannelMerger(matrix.length),nodes=[split,merge];
  source.connect(split);
  for(let out=0;out<matrix.length;out++)for(let input=0;input<inputCount;input++)if(matrix[out][input]){const gain=context.createGain();gain.gain.value=matrix[out][input];gain.channelCount=1;gain.channelCountMode='explicit';gain.channelInterpretation='discrete';split.connect(gain,input);gain.connect(merge,0,out);nodes.push(gain);}
  merge.connect(destination);return{output:merge,dispose(){try{source.disconnect(split);}catch{}for(const node of nodes)try{node.disconnect();}catch{}}};
}
