import type * as THREE from 'three';
import { makeRT, clearRT, Compositor, FSPass, type BlendMode } from '../engine/gl';
export type SceneLayer = {
    name: string;
    target: THREE.WebGLRenderTarget;
    opacity: number;
    mode: BlendMode;
    effects: FSPass[];
};
/** Ordered named targets. Each effect only sees its own layer; text may stay dry.
 * Effects/materials and input textures are caller-owned. Targets are stack-owned. */
export class LayerStack {
    readonly layers: SceneLayer[] = [];
    private scratch: THREE.WebGLRenderTarget;
    constructor(private comp: Compositor, private width = 1920, private height = 1080) {
        if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 7680))
            throw new Error('invalid layer size');
        this.scratch = makeRT(width, height, { depthBuffer: false });
    }
    add(name: string, options: {
        opacity?: number;
        mode?: BlendMode;
        effects?: FSPass[];
    } = {}) {
        if (!name || this.layers.some(l => l.name === name) || this.layers.length >= 8)
            throw new Error('layer name must be unique; at most 8 layers');
        const opacity = options.opacity ?? 1;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
            throw new Error('invalid layer opacity');
        const layer: SceneLayer = { name, target: makeRT(this.width, this.height), opacity, mode: options.mode ?? 'normal', effects: options.effects ?? [] };
        this.layers.push(layer);
        return layer;
    }
    clear(renderer: THREE.WebGLRenderer) { for (const layer of this.layers)
        clearRT(renderer, layer.target, [0, 0, 0], 0); }
    compose(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget) {
        clearRT(renderer, out);
        for (const layer of this.layers) {
            let current = layer.target;
            for (const effect of layer.effects) {
                if (!effect.u.tex)
                    throw new Error('layer effect must declare sampler2D tex');
                const next = current === this.scratch ? layer.target : this.scratch;
                effect.u.tex.value = current.texture;
                effect.render(renderer, next);
                current = next;
            }
            this.comp.draw(renderer, current.texture, out, { mode: layer.mode, opacity: layer.opacity, premult: false });
        }
    }
    dispose() { for (const layer of this.layers)
        layer.target.dispose(); this.scratch.dispose(); this.layers.length = 0; }
}
