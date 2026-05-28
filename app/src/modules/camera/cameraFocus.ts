import * as THREE from 'three'

export const cameraFocusTarget = { current: null as THREE.Vector3 | null }

/** Set this to an object id; ObjectGrid resolves it to a world position next frame. */
export const pendingFocusId = { current: null as string | null }

/**
 * Pending camera-snap world position, shared between CameraSnapController (which
 * sets it after moving `camera.position`) and the active controller.
 *
 * The Fly controller derives its next position incrementally from the live
 * `camera.position`, so it respects an external `camera.position.set(...)` with
 * no further help. The Character (FPS) controller instead syncs the camera from
 * its Rapier rigid body every frame, which would immediately overwrite an
 * externally-set camera position. It therefore consumes this ref each frame and
 * teleports its body to match, clearing the ref once applied.
 */
export const pendingCameraSnap = { current: null as THREE.Vector3 | null }
