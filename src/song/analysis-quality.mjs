// Evidence quality, not a musical judgement. Estimated timings remain drafts.
export function analysisQuality(analysis){
  const lines=analysis.lyrics?.lines??[],legacy=analysis.provenance?.lyrics?.params?.fallbackLines;
  const inherited=analysis.lyrics?.timingSource;
  const unreliable=lines.flatMap((line,index)=>{
    const estimated=line.fallback===true||(line.timingSource??inherited)==='estimated'||line.end<=line.start||line.words.some(w=>w.end<=w.start||(w.timingSource??line.timingSource??inherited)==='estimated');
    return estimated?[index]:[];
  });
  const inferred=Number.isInteger(legacy)&&legacy>=0?Math.min(lines.length,legacy):0;
  const count=Math.max(unreliable.length,inferred),blocked=lines.length>0&&count/lines.length>.5;
  const warnings=[];
  if(count)warnings.push(`${count}/${lines.length} 行含估算或无效时间，必须核对；超过半数时不能确认。`);
  const bpm=analysis.rhythm.bpm;
  const tempoCandidates=[bpm,bpm?bpm/2:undefined,bpm?bpm*2:undefined].filter(n=>Number.isFinite(n)&&n>=20&&n<=400);
  return {schema:'analysis-quality/v1',totalLines:lines.length,unreliableLines:unreliable,unreliableCount:count,blocked,warnings,tempoCandidates,
    rule:'超过半数歌词行估算/零时长禁止确认；BPM 半速/倍速仅列候选，不自动改拍点'};
}
