// Kana mora segmentation and bank-verified CV/VCV aliases. Kanji readings are
// supplied by the caller; missing aliases never silently become another sound.
import { UstxError } from './errors.mjs';
const small = new Set([...'ゃゅょぁぃぅぇぉゎ']);
const rows = ['あいうえお', 'かきくけこ', 'がぎぐげご', 'さしすせそ', 'ざじずぜぞ', 'たちつてと', 'だぢづでど', 'なにぬねの', 'はひふへほ', 'ばびぶべぼ', 'ぱぴぷぺぽ', 'まみむめも', 'らりるれろ'];
const vowel = new Map(rows.flatMap(row => [...row].map((c, i) => [c, 'aiueo'[i]])));
for (const [c, v] of Object.entries({ 'や': 'a', 'ゆ': 'u', 'よ': 'o', 'わ': 'a', 'を': 'o', 'ん': 'n', 'ゔ': 'u', 'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o' }))
    vowel.set(c, v);
const kana = text => text.normalize('NFKC').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 96));
export function japaneseMora(text) {
    if (typeof text !== 'string' || text.length > 50000)
        throw new UstxError('日语歌词必须为 ≤50000 字的假名文本');
    const result = [];
    for (const c of kana(text)) {
        if (/[\s、。，！？!?,.「」『』]/.test(c))
            continue;
        if (small.has(c) && result.length)
            result[result.length - 1] += c;
        else if (c === 'ー') {
            const v = vowel.get(result.at(-1)?.at(-1));
            if (!v || v === 'n')
                throw new UstxError('长音符需要前置元音');
            result.push('あいうえお'['aiueo'.indexOf(v)]);
        }
        else if (vowel.has(c) || c === 'っ')
            result.push(c);
        else
            throw new UstxError(`无法确定「${c}」的读音；请提供假名或逐音符 oto 别名`);
    }
    return result;
}
export function japaneseAliases(notes, bank, { mode = 'auto', prefix = '', suffix = '' } = {}) {
    if (!['auto', 'cv', 'vcv', 'literal'].includes(mode) || typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length + suffix.length > 100)
        throw new UstxError('alias mode/prefix/suffix 非法');
    let previous = '-', end = -1;
    const missing = [], changes = [];
    const resolved = notes.map((n, i) => {
        const syllable = mode === 'literal' ? n.lyric : kana(n.lyric);
        if (n.startTick > end)
            previous = '-';
        const options = mode === 'literal' ? [syllable] : mode === 'cv' ? [syllable] : mode === 'vcv' ? [`${previous} ${syllable}`, `- ${syllable}`] : [`${previous} ${syllable}`, `- ${syllable}`, syllable];
        const alias = [...new Set(options)].map(a => prefix + a + suffix).find(a => bank.findAlias(a));
        if (!alias)
            missing.push({ noteIndex: i, syllable, candidates: options.map(a => prefix + a + suffix) });
        previous = vowel.get(syllable.at(-1)) ?? '-';
        end = n.startTick + n.durationTicks;
        changes.push({ noteIndex: i, text: n.text, alias: alias ?? null });
        return { ...n, lyric: alias ?? n.lyric };
    });
    return { notes: resolved, report: { mode, prefix, suffix, missing, changes, ready: missing.length === 0 } };
}
