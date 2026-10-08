import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisQuality} from '../../../src/song/analysis-quality.mjs';
import {validateAnalysis} from '../../../src/song/contract.mjs';
import {baseAnalysis} from './analysis-fixture.mjs';
test('estimated timing survives contract normalization and a majority blocks confirmation',()=>{
 const lyrics={language:'ja',textSource:'user',humanConfirmed:true,lines:[0,1,2].map((i)=>({text:'あ',start:i,end:i+.5,fallback:i!==2,timingSource:i===2?'audio-aligned':'estimated',words:[{w:'あ',start:i,end:i+.5,timingSource:i===2?'audio-aligned':'estimated'}]}))};
 const analysis=validateAnalysis(baseAnalysis({lyrics,provenance:{...baseAnalysis().provenance,lyrics:{tool:'test',version:'1',startedAt:0,confidence:.5}}}));
 const quality=analysisQuality(analysis);assert.equal(quality.blocked,true);assert.deepEqual(quality.unreliableLines,[0,1]);assert.equal(analysis.lyrics.lines[0].words[0].timingSource,'estimated');
 const corrected=structuredClone(analysis);corrected.lyrics.lines.forEach(l=>{delete l.fallback;l.timingSource='manual';l.words.forEach(w=>w.timingSource='manual');});assert.equal(analysisQuality(corrected).blocked,false);
});
test('legacy fallback counts and zero-length timing are not lost; instrumental truth stays valid',()=>{
 const analysis={rhythm:{bpm:162},lyrics:{lines:[{start:0,end:1,words:[{start:0,end:1}]},{start:1,end:2,words:[{start:1,end:2}]}]},provenance:{lyrics:{params:{fallbackLines:2}}}};
 assert.equal(analysisQuality(analysis).blocked,true);assert.deepEqual(analysisQuality(analysis).tempoCandidates,[162,81,324]);delete analysis.provenance.lyrics;analysis.lyrics.lines.forEach(l=>l.words[0].end=l.words[0].start);assert.equal(analysisQuality(analysis).blocked,true);
 assert.equal(analysisQuality({rhythm:{bpm:120}}).blocked,false);
});
