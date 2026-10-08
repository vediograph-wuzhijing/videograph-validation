import * as THREE from 'three';
import { FSPass } from '../engine/gl';
export const ENVIRONMENTS = ['sky', 'ocean', 'underwater'] as const;
export type Environment = typeof ENVIRONMENTS[number];
const fragments: Record<Environment, string> = {
    sky: `float clouds=sin(uv.x*17.+time*.11)*sin(uv.y*13.+seed)+sin(uv.x*31.-time*.07)*.3; color=mix(bottom,top,smoothstep(0.,1.,uv.y)); color+=vec3(smoothstep(.35,.85,clouds)*strength*.15);`,
    ocean: `float horizon=.57; if(uv.y>horizon){color=mix(bottom,top,(uv.y-horizon)/(1.-horizon));}else{float distance=(horizon-uv.y);float wave=sin(uv.x*36./(distance+.2)+time*speed)*sin(distance*130.-time*speed*2.);color=mix(bottom*.25,bottom,distance);color+=vec3(pow(max(0.,wave),8.)*strength*.25/(distance+.3));}`,
    underwater: `float a=sin(uv.x*29.+sin(uv.y*19.+time*speed)+seed);float b=sin(uv.y*31.+sin(uv.x*23.-time*speed));float caustic=pow(max(0.,a*b),6.);color=mix(bottom,top,uv.y);color+=vec3(caustic*strength*.3);`,
};
/** Deterministic fullscreen environment. Use a layer target for selective effects. */
export function environment(kind: Environment, { top = '#143959', bottom = '#45b3bd', strength = 1, speed = 1, seed = 0 }: {
    top?: string;
    bottom?: string;
    strength?: number;
    speed?: number;
    seed?: number;
} = {}) {
    if (!ENVIRONMENTS.includes(kind) || ![strength, speed, seed].every(Number.isFinite) || strength < 0 || strength > 4)
        throw new Error('invalid environment');
    const pass = new FSPass(`uniform float time;uniform float strength;uniform float speed;uniform float seed;uniform vec3 top;uniform vec3 bottom;void main(){vec2 uv=vUv;vec3 color;${fragments[kind]}fragColor=vec4(color,1.);}`, { time: { value: 0 }, strength: { value: strength }, speed: { value: speed }, seed: { value: seed }, top: { value: new THREE.Color(top) }, bottom: { value: new THREE.Color(bottom) } });
    return { pass, render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, t: number) { if (!Number.isFinite(t))
            throw new Error('invalid environment time'); pass.u.time!.value = t; pass.render(renderer, target); }, dispose() { pass.mat.dispose(); } };
}
