import { serviceFetch } from './mcp-feedback-tools.ts';
const schema = (extra: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false,
  properties: { projectId: { type: 'string' }, expectedInputRevision: { type: 'integer', minimum: 0 }, ...extra }, required: ['projectId', ...required] });
export const vocalToolDefinitions = [
  { name: 'project_vocal_import_audio', description: '导入外部处理好的人声干轨作为待渲染草稿，不依赖声库。复制并哈希冻结原始文件、归一单声道44100Hz、按offsetMs对齐并补齐歌曲长度；超长拒绝。可带plan生成实测音高报告，referencePath为同时间范围的分离参考人声，渲染自动生成频段dBFS及差值报告。不会自动采用；project_vocal_render处理混音，再由人试听采用。', inputSchema:schema({audioPath:{type:'string'},offsetMs:{type:'number',minimum:0},referencePath:{type:'string'},referenceOffsetMs:{type:'number',minimum:0},plan:{type:'object'},mix:{type:'object'}},['expectedInputRevision','audioPath']) },
  { name: 'project_vocal_import_midi', description: 'MIDI type0/1→单声部乐谱草稿：保留变速的绝对时间，trackIndex/channel显式选主旋律，复音拒绝。lyrics为逐音节数组或日语假名文本（不能猜汉字读音）；不填则用逐音符MIDI歌词。按本机声库验证CV/VCV别名，aliasReport列出缺失项；prefix/suffix显式选择多音阶。只读，不落修订/任务。检查后用project_vocal_submit提交；采用仍由人决定。', inputSchema: schema({ midiPath:{type:'string'}, trackIndex:{type:'integer',minimum:0}, channel:{type:'integer',minimum:0,maximum:15}, tempo:{type:'number',minimum:20,maximum:400}, lyrics:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]}, aliasMode:{enum:['auto','cv','vcv','literal']}, prefix:{type:'string'},suffix:{type:'string'} }, ['midiPath']) },
  { name: 'project_vocal_get', description: '读取歌声乐谱草稿、独立版本号、候选 WAV/LRC/USTX 和已采用混音。歌词时间为乐谱时间，未做音频对齐；采用不会自动覆盖视频歌词。', inputSchema: schema({}, []) },
  { name: 'project_vocal_check', description: '检查本机配置的声库与重采样器，返回 oto 别名（最多1000项）。无需启动 OpenUtau GUI。不要猜别名；目前无 phonemizer。', inputSchema: schema({}, []) },
  { name: 'project_vocal_submit', description: '提交固定 BPM、单轨单 part 乐谱。note: lyric=oto别名，pitch=C4，startBeats/durationBeats（或整数startTick/durationTicks，480 tick/拍）、text显示歌词；pitchCurve=[{x:相对起点毫秒,y:10音分,shape:lin/io/i/o/sp}]，vibrato={length:百分比,period:毫秒,depth:音分,in/out:百分比}，volume/velocity/attack=0..200、decay=0..100。part.pitchDeviation=[{timeMs:全曲绝对毫秒,cents:偏移}]，dynamics=[{timeMs,db:-24..12}]。mix.processing={}启用默认EQ/压缩/立体声混响，具体字段见VOCAL指南。无phonemizer/多轨。保留active，清除候选，409重读。', inputSchema: schema({ plan: { type: 'object' }, mix: { type: 'object', additionalProperties: false, properties: {
          backingGain: { type: 'number', minimum: 0, maximum: 2 }, vocalGain: { type: 'number', minimum: 0, maximum: 2 },
          processing: { type: 'object', additionalProperties: false, properties: {
              eq: { type: 'object', additionalProperties: false, properties: { lowCutHz: { type: 'number', minimum: 20, maximum: 400 }, lowGainDb: { type: 'number', minimum: -12, maximum: 12 }, midHz: { type: 'number', minimum: 300, maximum: 6000 }, midGainDb: { type: 'number', minimum: -12, maximum: 12 }, highGainDb: { type: 'number', minimum: -12, maximum: 12 } } },
              compressor: { type: 'object', additionalProperties: false, properties: { thresholdDb: { type: 'number', minimum: -60, maximum: 0 }, ratio: { type: 'number', minimum: 1, maximum: 20 }, attackMs: { type: 'number', minimum: 0.1, maximum: 2000 }, releaseMs: { type: 'number', minimum: 1, maximum: 9000 }, makeupDb: { type: 'number', minimum: 0, maximum: 24 } } },
              reverb: { type: 'object', additionalProperties: false, properties: { wet: { type: 'number', minimum: 0, maximum: 0.6 }, decayMs: { type: 'number', minimum: 100, maximum: 2000 }, roomSize: { type: 'number', minimum: 0.5, maximum: 2 }, damping: { type: 'number', minimum: 0, maximum: 0.95 } } },
              exciter: { type:'object',additionalProperties:false,properties:{amount:{type:'number',minimum:0,maximum:.5},frequencyHz:{type:'number',minimum:1000,maximum:10000},drive:{type:'number',minimum:1,maximum:8}} },
              saturation: { type:'object',additionalProperties:false,properties:{amount:{type:'number',minimum:0,maximum:1},drive:{type:'number',minimum:1,maximum:8}} },
              doubling: { type:'object',additionalProperties:false,properties:{wet:{type:'number',minimum:0,maximum:.5},delayMs:{type:'number',minimum:5,maximum:50},depthMs:{type:'number',minimum:0,maximum:4},rateHz:{type:'number',minimum:.05,maximum:3}} },
            } },
        } } }, ['expectedInputRevision', 'plan']) },
  { name: 'project_vocal_render', description: '后台渲染曲线/颤音、五点包络与力度，按mix处理人声并混合原音频，冻结输入版本。project_job_get查询、project_job_cancel取消；返回干轨、混音、缓存及实测音高report.pitchQuality，pitchReportFile含逐帧JSON。检查可靠覆盖、目标音分误差和起伏率/深度，null不等于唱准。旧版本不可采用；采用仍由人在界面试听决定。', inputSchema: schema({}, ['expectedInputRevision']) },
];
export const vocalToolNames = new Set(vocalToolDefinitions.map((tool) => tool.name));
export function callVocalTool(name: string, args: Record<string, unknown>) {
  const path = `/projects/${encodeURIComponent(String(args.projectId))}/vocal`;
  if (name === 'project_vocal_import_midi') return serviceFetch(`${path}/import-midi`, args);
  if (name === 'project_vocal_import_audio') return serviceFetch(`${path}/import-audio`, args);
  if (name === 'project_vocal_get')
    return serviceFetch(path);
  if (name === 'project_vocal_check')
    return serviceFetch(`${path}/check`);
  if (name === 'project_vocal_submit')
    return serviceFetch(path, { expectedInputRevision: args.expectedInputRevision, plan: args.plan, mix: args.mix });
  if (name === 'project_vocal_render')
    return serviceFetch(`${path}/render`, { expectedInputRevision: args.expectedInputRevision });
  throw new Error(`Unknown vocal tool: ${name}`);
}
