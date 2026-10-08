import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productRoot } from './project-repository.mjs';
import { ProjectError } from './errors.mjs';
const cards = [
    { id: 'world', title: '3D 相机、投影、世界卡片', tags: ['3d', 'camera', '相机', '投影', '卡片'], exports: ['worldCamera', 'projectWorld', 'worldCard', 'disposeCard'], usage: 'worldCamera({position:[0,0,5],target:[0,0,0],fov:45,drift:.02},f.t); 相机按绝对时间计算；卡片纹理由调用方管理。' },
    { id: 'environment', title: '海、天空、水下', tags: ['海', '海洋', 'ocean', 'sky', '天空', '水下', 'underwater', '环境'], exports: ['environment'], usage: "const sea=environment('ocean',{strength:1,speed:.7}); sea.render(renderer,out,f.t); dispose()释放材质。" },
    { id: 'text-motion', title: '逐字进场与退场', tags: ['文字', 'text', '动画', '逐字', '进场', '退场'], exports: ['textMotion', 'graphemes'], usage: "textMotion(f.t,start,end,index,count,{enter:'rise',exit:'fade',duration:.3,stagger:.035}); 返回opacity/x/y/scale/blur，按字素分割，歌词时间保持原值。" },
    { id: 'layers', title: '独立图层与选择性后期', tags: ['layer', '图层', '合成', '人物', '文字', '后期'], exports: ['LayerStack'], usage: "new LayerStack(comp); add('world',{effects:[pass]}); add('text'); clear(renderer); 分别绘制target；compose(renderer,out)。pass声明sampler2D tex；dispose释放RT，材质由调用方管理。" },
];
export function sceneComponents(query = '') {
    if (typeof query !== 'string' || query.length > 200)
        throw new ProjectError('组件检索 query 非法');
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return { schema: 'scene-components/v1', version: '0.2.0', components: cards.filter(c => terms.every(t => `${c.title} ${c.tags.join(' ')}`.toLowerCase().includes(t))) };
}
export function sceneComponent(id) {
    const card = cards.find(c => c.id === id);
    if (!card)
        throw new ProjectError('scene component not found', 404);
    return { ...card, license: 'GPL-3.0-only', importPath: `../components/${id}`, code: readFileSync(join(productRoot, `engine-base/components/${id}.ts`), 'utf8'), compatibility: '新工程包含组件；旧工程可将返回代码放进场景源码，保留 imports，不覆盖其冻结引擎。' };
}
