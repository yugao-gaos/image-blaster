import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { pendingCameraSnap } from '../camera/cameraFocus'
import { useCubeCapture, selectCameraSnapTarget } from './useCubeCapture'

/**
 * CameraSnapController
 *
 * Logic-only R3F component (renders nothing). Mounts INSIDE the `<Canvas>` so it
 * can drive the live camera via `useThree()`.
 *
 * When the cube-capture store's `cameraSnapTarget` (a world-space `[x,y,z]`)
 * becomes non-null, it "flies" the viewer camera there with a short eased tween
 * (~0.3s), then clears the target via `clearCameraSnapTarget()`. This powers the
 * Captures list "fly the camera back" action — the capture position was recorded
 * with `camera.getWorldPosition()`, i.e. world space, so it maps straight onto
 * `camera.position` with no splat-group transform.
 *
 * ── Why it cooperates with the active controller ────────────────────────────
 * The Fly controller derives its next position incrementally from the live
 * `camera.position`, so directly mutating `camera.position` persists. The
 * Character (FPS) controller, however, rewrites `camera.position` from its
 * Rapier rigid body every frame, which would clobber the snap. To cover both,
 * this controller also publishes the destination on the shared `pendingCameraSnap`
 * ref; the Character controller consumes it each frame and teleports its body to
 * match. We publish on the FINAL frame of the tween so the body lands exactly
 * where the camera settles.
 */

const SNAP_DURATION = 0.3 // seconds

// Cubic ease-out: fast start, gentle settle.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function CameraSnapController() {
  const { camera } = useThree()
  const snapTarget = useCubeCapture(selectCameraSnapTarget)
  const clearCameraSnapTarget = useCubeCapture((s) => s.clearCameraSnapTarget)

  // Active tween, if any. Held in a ref so useFrame reads live state without
  // re-subscribing each frame.
  const tween = useRef<{
    from: THREE.Vector3
    to: THREE.Vector3
    elapsed: number
  } | null>(null)

  useEffect(() => {
    if (!snapTarget) {
      tween.current = null
      return
    }
    tween.current = {
      from: camera.position.clone(),
      to: new THREE.Vector3(snapTarget[0], snapTarget[1], snapTarget[2]),
      elapsed: 0,
    }
  }, [snapTarget, camera])

  useFrame((_state, delta) => {
    const t = tween.current
    if (!t) return

    t.elapsed += delta
    const progress = Math.min(1, t.elapsed / SNAP_DURATION)
    const eased = easeOut(progress)
    camera.position.lerpVectors(t.from, t.to, eased)

    if (progress >= 1) {
      // Snap to exact destination and notify the Character controller so its
      // rigid body follows (Fly mode needs no further help).
      camera.position.copy(t.to)
      pendingCameraSnap.current = t.to.clone()
      tween.current = null
      clearCameraSnapTarget()
    }
  })

  return null
}
