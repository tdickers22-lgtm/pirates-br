import * as THREE from 'three';

/**
 * Zero-scale matrix used to collapse an InstancedMesh slot whose prop is gone.
 * InstancedMesh has no "hide instance N" — writing a degenerate transform is the
 * standard way, and sharing ONE frozen matrix keeps every caller collapsing a
 * slot the same way with no per-removal allocation.
 */
export const ZERO_SCALE_MAT4 = new THREE.Matrix4().makeScale(0, 0, 0);
