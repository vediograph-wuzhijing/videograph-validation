// Bounded Standard MIDI File reader. Tempo changes become absolute times;
// the renderer's fixed-BPM score preserves those times within half a tick.
import { UstxError } from './errors.mjs';
const fail = message => { throw new UstxError(message); };
export function readMidi(bytes) {
    const data = Buffer.from(bytes);
    if (data.length > 16 * 1024 * 1024)
        fail('MIDI 超过 16 MB');
    let at = 0;
    const requireBytes = length => { if (at + length > data.length)
        fail('MIDI 文件截断'); };
    const u8 = () => { requireBytes(1); return data[at++]; };
    const u16 = () => { requireBytes(2); const n = data.readUInt16BE(at); at += 2; return n; };
    const u32 = () => { requireBytes(4); const n = data.readUInt32BE(at); at += 4; return n; };
    const id = () => { requireBytes(4); const s = data.toString('ascii', at, at + 4); at += 4; return s; };
    const vlq = () => {
        let n = 0;
        for (let i = 0; i < 4; i++) {
            const b = u8();
            n = n * 128 + (b & 127);
            if (!(b & 128))
                return n;
        }
        fail('MIDI 可变长度整数超过四字节');
    };
    if (id() !== 'MThd')
        fail('不是标准 MIDI 文件');
    const headerLength = u32();
    if (headerLength < 6)
        fail('MIDI header 太短');
    const format = u16(), count = u16(), ppq = u16();
    if (![0, 1].includes(format) || !count || count > 256 || (format === 0 && count !== 1))
        fail('仅支持 MIDI type 0/1，最多 256 轨');
    if (!ppq || ppq & 0x8000)
        fail('仅支持 PPQ MIDI；SMPTE 时间制需要先转换');
    requireBytes(headerLength - 6);
    at += headerLength - 6;
    const tracks = [], tempos = [];
    let eventCount = 0;
    for (let track = 0; track < count; track++) {
        if (id() !== 'MTrk')
            fail('缺少 MIDI track chunk');
        const length = u32();
        requireBytes(length);
        const end = at + length;
        let tick = 0, running = 0, ended = false, name = '';
        const notes = [], lyrics = [], active = new Map();
        while (at < end && !ended) {
            if (++eventCount > 500000)
                fail('MIDI 事件数超过限制');
            tick += vlq();
            let status = u8();
            if (status < 128) {
                if (!running)
                    fail('MIDI running status 缺失');
                at--;
                status = running;
            }
            else if (status < 0xf0)
                running = status;
            if (status === 0xff) {
                running = 0; // SMF meta events cancel running status (MMA RP-001).
                const type = u8(), size = vlq();
                requireBytes(size);
                const payload = data.subarray(at, at + size);
                at += size;
                if (type === 0x51) {
                    if (size !== 3 || payload.readUIntBE(0, 3) === 0)
                        fail('非法 tempo 事件');
                    tempos.push({ tick, us: payload.readUIntBE(0, 3), track });
                }
                else if (type === 3)
                    name = payload.toString('utf8');
                else if (type === 5)
                    lyrics.push({ tick, text: payload.toString('utf8') });
                else if (type === 0x2f) {
                    if (size !== 0)
                        fail('非法 end-of-track');
                    ended = true;
                }
            }
            else if (status === 0xf0 || status === 0xf7) {
                running = 0;
                const size = vlq();
                requireBytes(size);
                at += size;
            }
            else if (status >= 0xf0)
                fail('不支持 MIDI system 事件');
            else {
                const kind = status >> 4, channel = status & 15, tone = u8();
                const value = [0xc, 0xd].includes(kind) ? 0 : u8();
                if (tone > 127 || value > 127)
                    fail('非法 MIDI channel 数据');
                const key = `${channel}:${tone}`;
                if (kind === 9 && value) {
                    if (active.has(key))
                        fail('同一通道/音高音符重复开启');
                    active.set(key, { track, channel, tone, velocity: value, startTick: tick });
                }
                else if (kind === 8 || kind === 9) {
                    const note = active.get(key);
                    if (!note)
                        fail('MIDI note-off 没有对应 note-on');
                    if (tick <= note.startTick)
                        fail('MIDI 音符时长必须为正');
                    notes.push({ ...note, endTick: tick });
                    active.delete(key);
                }
            }
            if (at > end)
                fail('MIDI 事件越过 track 边界');
        }
        if (!ended || active.size)
            fail('MIDI track 未结束或有悬空音符');
        at = end;
        tracks.push({ index: track, name, notes: notes.sort((a, b) => a.startTick - b.startTick || a.tone - b.tone), lyrics });
    }
    const ordered = tempos.sort((a, b) => a.tick - b.tick || a.track - b.track);
    const map = [{ tick: 0, us: 500000, seconds: 0 }];
    for (const tempo of ordered) {
        const prior = map.at(-1);
        if (prior.tick === tempo.tick) {
            if (prior.track !== undefined && prior.us !== tempo.us)
                fail('同一时刻有冲突的 MIDI tempo');
            Object.assign(prior, tempo);
        }
        else
            map.push({ ...tempo, seconds: prior.seconds + (tempo.tick - prior.tick) * prior.us / (ppq * 1e6) });
    }
    const seconds = tick => {
        let lo = 0, hi = map.length;
        while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (map[mid].tick <= tick)
                lo = mid;
            else
                hi = mid;
        }
        const t = map[lo];
        return t.seconds + (tick - t.tick) * t.us / (ppq * 1e6);
    };
    for (const track of tracks)
        for (const note of track.notes) {
            note.start = seconds(note.startTick);
            note.end = seconds(note.endTick);
        }
    return { format, ppq, tempos: map, tracks };
}
export function midiScore(midi, { trackIndex, channel, tempo = 120, lyrics, singer = 'voicebank' } = {}) {
    const candidates = midi.tracks.flatMap(t => [...new Set(t.notes.map(n => n.channel))].map(c => ({ trackIndex: t.index, channel: c, name: t.name, noteCount: t.notes.filter(n => n.channel === c).length })));
    if (trackIndex === undefined && candidates.length === 1)
        ({ trackIndex, channel } = candidates[0]);
    if (!Number.isInteger(trackIndex) || !midi.tracks[trackIndex])
        fail(`请显式选择主旋律 trackIndex/channel：${JSON.stringify(candidates)}`);
    const track = midi.tracks[trackIndex], channels = [...new Set(track.notes.map(n => n.channel))];
    if (channel === undefined && channels.length === 1)
        channel = channels[0];
    if (!Number.isInteger(channel) || !channels.includes(channel))
        fail('请显式选择包含音符的 channel');
    if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400)
        fail('tempo 必须在 20..400');
    const selected = track.notes.filter(n => n.channel === channel);
    if (!selected.length || selected.length > 2000)
        fail('主旋律必须包含 1..2000 音符');
    for (let i = 1; i < selected.length; i++)
        if (selected[i].start < selected[i - 1].end - 1e-9)
            fail('主旋律含复音；请先选择或拆出单声部');
    let syllables = lyrics;
    if (syllables === undefined) {
        syllables = selected.map(n => track.lyrics.find(l => l.tick === n.startTick)?.text);
        if (syllables.some(s => !s))
            fail('MIDI 没有逐音符歌词；请提供逐音节数组或日语假名文本');
    }
    if (!Array.isArray(syllables) || syllables.length !== selected.length || !syllables.every(s => typeof s === 'string' && s.trim() && s.length <= 200))
        fail(`需要 ${selected.length} 个歌词音节；一字多音请显式重复音节`);
    const ticksPerSecond = tempo * 480 / 60;
    const notes = selected.map((n, i) => ({ tone: n.tone, startTick: Math.round(n.start * ticksPerSecond), durationTicks: Math.round(n.end * ticksPerSecond) - Math.round(n.start * ticksPerSecond), lyric: syllables[i].trim(), text: syllables[i].trim(), volume: Math.round(n.velocity / 127 * 100) }));
    if (notes.some(n => n.durationTicks <= 0))
        fail('音符短于目标乐谱的一个 tick，请增大 tempo');
    return { plan: { name: track.name || 'MIDI melody', tempo, tracks: [{ singer }], parts: [{ trackNo: 0, positionTick: 0, notes }] },
        report: { schema: 'midi-import/v1', trackIndex, channel, noteCount: notes.length, sourcePpq: midi.ppq, sourceTempoChanges: midi.tempos.length, maxTimingErrorMs: 500 / ticksPerSecond, tempoNormalization: 'absolute-time', candidates } };
}
