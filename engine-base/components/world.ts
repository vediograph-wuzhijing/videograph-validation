import * as THREE from 'three';
export type CameraPose = {
    position: [
        number,
        number,
        number
    ];
    target: [
        number,
        number,
        number
    ];
    fov?: number;
    drift?: number;
    speed?: number;
};
/** Absolute-time drift: seeking/export order never changes the camera. */
export function worldCamera(pose: CameraPose, t: number, aspect = 16 / 9) {
    const fov = pose.fov ?? 45, drift = pose.drift ?? 0, speed = pose.speed ?? .7;
    if (![...pose.position, ...pose.target, t, aspect, fov, drift, speed].every(Number.isFinite) || aspect <= 0 || fov < 1 || fov > 150 || drift < 0)
        throw new Error('invalid camera pose');
    const camera = new THREE.PerspectiveCamera(fov, aspect, .01, 10000);
    camera.position.set(...pose.position);
    camera.position.x += Math.sin(t * speed * 1.13) * drift;
    camera.position.y += Math.sin(t * speed * .83 + .7) * drift;
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
    return camera;
}
/** Normalized canvas coordinates; null means behind/outside the camera. */
export function projectWorld(point: THREE.Vector3, camera: THREE.Camera) {
    camera.updateMatrixWorld();
    const p = point.clone().project(camera);
    return p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 ? { x: (p.x + 1) / 2, y: (1 - p.y) / 2 } : null;
}
/** Texture ownership remains with the caller; disposeCard frees geometry/material. */
export function worldCard(texture: THREE.Texture, width = 2, height = 2) {
    if (![width, height].every(n => Number.isFinite(n) && n > 0))
        throw new Error('invalid card size');
    return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }));
}
export function disposeCard(card: ReturnType<typeof worldCard>) { card.geometry.dispose(); card.material.dispose(); }
