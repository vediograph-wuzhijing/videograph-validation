export const TEXT_MOTIONS = ['fade', 'rise', 'drop', 'slide', 'scale', 'blur', 'typewriter'] as const;
export type TextMotion = typeof TEXT_MOTIONS[number];
const clamp = (v: number) => Math.min(1, Math.max(0, v));
/** Per-grapheme state; compose entrance/exit without changing lyric timings. */
export function textMotion(t: number, start: number, end: number, index: number, count: number, { enter = 'rise', exit = 'fade', duration = .3, stagger = .035, distance = 36 }: {
    enter?: TextMotion;
    exit?: TextMotion;
    duration?: number;
    stagger?: number;
    distance?: number;
} = {}) {
    if (![t, start, end, index, count, duration, stagger, distance].every(Number.isFinite) || start >= end || duration <= 0 || stagger < 0 || index < 0 || index >= count || !TEXT_MOTIONS.includes(enter) || !TEXT_MOTIONS.includes(exit))
        throw new Error('invalid text motion');
    const budget = Math.max(0, end - start - duration * 2), delay = Math.min(index * stagger, budget);
    const into = clamp((t - start - delay) / duration), out = clamp((end - t - (count - 1 - index) * Math.min(stagger, budget / Math.max(1, count - 1))) / duration);
    const state = { opacity: 1, x: 0, y: 0, scale: 1, blur: 0 };
    const apply = (mode: TextMotion, p: number, sign: number) => {
        const amount = (1 - p) ** 3;
        state.opacity *= mode === 'typewriter' ? (p > 0 ? 1 : 0) : p;
        if (mode === 'rise')
            state.y += distance * amount * sign;
        if (mode === 'drop')
            state.y -= distance * amount * sign;
        if (mode === 'slide')
            state.x += distance * amount * sign;
        if (mode === 'scale')
            state.scale *= 1 - .25 * amount;
        if (mode === 'blur')
            state.blur += 12 * amount;
    };
    apply(enter, into, 1);
    apply(exit, out, -1);
    return state;
}
export function graphemes(text: string) { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment); }
