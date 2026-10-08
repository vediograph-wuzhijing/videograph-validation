import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMix,colorVocal,doubleVocal} from '../../../src/vocal/mix.mjs';
import {compareBands} from '../../../src/vocal/spectrum.mjs';
const rate=44100, tone=(hz,a=.5)=>Float32Array.from({length:rate},(_,i)=>a*Math.sin(i/rate*2*Math.PI*hz));
test('calibrated band RMS distinguishes a 10dB reference difference and never reports silence as agreement',()=>{
 const reference={sampleRate:rate,channels:1,samples:tone(6000)};
 const measured={...reference,samples:tone(6000,.5/Math.sqrt(10))};
 const report=compareBands(measured,reference);assert(Math.abs(report.differences[4].deltaDb+10)<.05);assert(Math.abs(report.reference.bands[4].dbFS+9.03)<.2);
 const silent=compareBands({...reference,samples:new Float32Array(rate)},reference);assert.equal(silent.differences[4].deltaDb,null);
});
test('color defaults are exact bypass; opt-in harmonics and stereo doubling are deterministic and finite',()=>{
 const dry=tone(440,.9),bypass=normalizeMix({processing:{}}).processing;
 assert.deepEqual(colorVocal(dry,rate,bypass),dry);
 const p=normalizeMix({processing:{exciter:{amount:.4},saturation:{amount:.5,drive:4},doubling:{wet:.3}}}).processing;
 const colored=colorVocal(dry,rate,p),left=doubleVocal([colored,colored],rate,p.doubling);
 assert(colored.every(Number.isFinite));assert.notDeepEqual(left[0],left[1]);assert.deepEqual(left,doubleVocal([colored,colored],rate,p.doubling));
 assert.throws(()=>normalizeMix({processing:{saturation:{drive:Infinity}}}));
});
