import test from 'node:test';
import assert from 'node:assert/strict';
import { readMidi, midiScore } from '../../../src/vocal/midi.mjs';
import { japaneseMora, japaneseAliases } from '../../../src/vocal/japanese.mjs';
const smf=(events,format=0)=>{
  const header=Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,format,0,1,1,0xe0]);
  const track=Buffer.from(events),chunk=Buffer.alloc(8);chunk.write('MTrk');chunk.writeUInt32BE(track.length,4);return Buffer.concat([header,chunk,track]);
};
const melody=smf([0,0xff,0x51,3,7,0xa1,0x20,0,0x90,60,100,0x83,0x60,0x80,60,0,0,0xff,0x51,3,15,0x42,0x40,0,0x90,62,80,0x83,0x60,0x80,62,0,0,0xff,0x2f,0]);
test('MIDI tempo changes preserve absolute seconds and dynamics in a fixed tempo score',()=>{
 const midi=readMidi(melody);assert.equal(midi.tracks[0].notes[0].end,.5);assert.equal(midi.tracks[0].notes[1].end,1.5);
 const result=midiScore(midi,{tempo:120,lyrics:['あ','い']});assert.deepEqual(result.plan.parts[0].notes.map(n=>[n.startTick,n.durationTicks]),[[0,480],[480,960]]);assert.equal(result.report.sourceTempoChanges,2);assert(result.plan.parts[0].notes[1].volume<result.plan.parts[0].notes[0].volume);
});
test('MIDI rejects truncated chunks, unsupported clocks, unmatched notes and polyphony',()=>{
 assert.throws(()=>readMidi(melody.subarray(0,30)),/截断/);const smpte=Buffer.from(melody);smpte[12]=0x80;assert.throws(()=>readMidi(smpte),/SMPTE/);
 assert.throws(()=>readMidi(smf([0,0x90,60,90,0,0xff,0x2f,0])),/悬空/);
 assert.throws(()=>readMidi(smf([0,0x90,60,90,0,0xff,1,0,0x83,0x60,60,0,0,0xff,0x2f,0])),/running status/);
 const poly=readMidi(smf([0,0x90,60,90,0,64,90,0x83,0x60,0x80,60,0,0,64,0,0,0xff,0x2f,0]));assert.throws(()=>midiScore(poly,{lyrics:['a','b']}),/复音/);
});
test('Japanese kana expands mora and VCV aliases without inventing missing readings',()=>{
 assert.deepEqual(japaneseMora('キャー、あい'),['きゃ','あ','あ','い']);assert.throws(()=>japaneseMora('世界'),/读音/);
 const bank={findAlias:a=>['- あ','a い','- う'].includes(a)};
 const notes=[{lyric:'ア',startTick:0,durationTicks:480},{lyric:'イ',startTick:480,durationTicks:480},{lyric:'う',startTick:1440,durationTicks:480}];
 const r=japaneseAliases(notes,bank,{mode:'vcv'});assert.equal(r.report.ready,true);assert.deepEqual(r.notes.map(n=>n.lyric),['- あ','a い','- う']);
 assert.equal(japaneseAliases([{lyric:'え',startTick:0,durationTicks:480}],bank).report.ready,false);
});
