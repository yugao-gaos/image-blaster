import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
// SparkRenderer type is exported from the package root; used only for prop typing.
import type { SparkRenderer } from '@sparkjsdev/spark'
import { useDebugStore } from '../../store/debug'
import { ViewerQuality } from '../../types/world'
import {
  useCubeCapture,
  type CubeCaptureStore,
  type CubeFaceKey,
  type CubeFaceUrls,
} from './useCubeCapture'

/**
 * CubeCaptureController
 *
 * Logic-only R3F component (renders nothing). It lives inside the existing
 * `<Canvas>` so it has access to the live WebGL renderer, scene and camera via
 * `useThree()`.
 *
 * When the cube-capture store transitions to `phase === 'capturing'`, it:
 *   1. forces `viewerQuality = High` so Spark renders with `encodeLinear = true`
 *      (consistent sRGB gamma for the inpaint → stitch → Marble pipeline),
 *   2. renders each of the six cube faces SEPARATELY with its own
 *      `THREE.PerspectiveCamera` (fov 90, aspect 1) positioned at the capture
 *      world position, into a 1024² `WebGLRenderTarget`,
 *   3. reads back each face with `readRenderTargetPixelsAsync`,
 *   4. encodes each face to a PNG data URL (flipping rows — WebGL readback is
 *      bottom-up), maps them to px/nx/py/ny/pz/nz,
 *   5. POSTs base64 PNGs to `/__cube-capture?slug=<slug>`,
 *   6. records the server result in the store and restores the prior quality.
 *
 * ── Why per-face cameras instead of `SparkRenderer.renderCubeMap()` ──────────
 * Spark's `renderCubeMap` does a single radial gaussian sort around the capture
 * point, then drives a `THREE.CubeCamera` which calls `renderer.render(scene,
 * faceCamera)` six times in sequence. Because the SparkRenderer's `autoUpdate`
 * is on, each of those six face renders is seen as a "new frame" by Spark's
 * `onBeforeRender` hook, which kicks off a fresh async sort and swaps the splat
 * accumulators mid-sequence. There are only two spare accumulators, so after the
 * first ~2 faces the ordering texture is left stale/empty and the remaining
 * faces render with mis-ordered (effectively invisible) gaussians — the empty
 * faces bug.
 *
 * The radial sort metric is `length(center - worldCenter)` (see Spark's
 * `computeSort` with `sortRadial`), which is direction-independent: ONE sort
 * around the capture point is correct for all six face directions. So the fix is
 * to (a) disable `autoUpdate` during capture so `onBeforeRender` uploads the
 * per-face view matrix but does NOT re-sort/swap accumulators, (b) perform a
 * single awaited radial sort via `spark.update(...)`, then (c) render each face
 * with our own camera into a 2D render target. The face camera orientations
 * exactly mirror three's `CubeCamera.updateCoordinateSystem()` (WebGL layout) so
 * the faces round-trip through `CubeToEquirect` / `CubeToMultiImage` unchanged.
 */

const FACE_SIZE = 1024

/**
 * Per-face camera orientations. These MUST match three.js'
 * `CubeCamera.updateCoordinateSystem()` for `WebGLCoordinateSystem` so that the
 * captured faces are identical to what the old `CubeCamera`-backed path produced
 * and stitch correctly in `CubeToEquirect` / `CubeToMultiImage`.
 *
 *   +X look (+1,0,0) up (0,1,0)   -X look (-1,0,0) up (0,1,0)
 *   +Y look (0,1,0)  up (0,0,-1)  -Y look (0,-1,0) up (0,0,1)
 *   +Z look (0,0,1)  up (0,1,0)   -Z look (0,0,-1) up (0,1,0)
 */
const FACE_ORIENTATIONS: readonly {
  key: CubeFaceKey
  look: readonly [number, number, number]
  up: readonly [number, number, number]
}[] = [
  { key: 'px', look: [1, 0, 0], up: [0, 1, 0] },
  { key: 'nx', look: [-1, 0, 0], up: [0, 1, 0] },
  { key: 'py', look: [0, 1, 0], up: [0, 0, -1] },
  { key: 'ny', look: [0, -1, 0], up: [0, 0, 1] },
  { key: 'pz', look: [0, 0, 1], up: [0, 1, 0] },
  { key: 'nz', look: [0, 0, -1], up: [0, 1, 0] },
]

/** Near/far for the face cameras — matches Spark's `renderCubeMap` defaults. */
const FACE_NEAR = 0.1
const FACE_FAR = 1e3

/**
 * The `sparkRenderer` prop may be supplied as a live instance, a React ref
 * holding the instance, or a getter function. Wave 3 wires this from
 * `SplatRenderer`'s `sparkRef`. Accepting all three shapes keeps integration
 * flexible without forcing the caller into one pattern.
 */
type SparkRendererSource =
  | SparkRenderer
  | { current: SparkRenderer | null }
  | (() => SparkRenderer | null)
  | null
  | undefined

interface Props {
  slug: string
  sparkRenderer: SparkRendererSource
}

function isSparkRenderer(value: unknown): value is SparkRenderer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { renderCubeMap?: unknown }).renderCubeMap === 'function'
  )
}

function resolveSparkRenderer(source: SparkRendererSource): SparkRenderer | null {
  if (!source) return null
  // Getter form: () => SparkRenderer | null
  if (typeof source === 'function') return source()
  // A live SparkRenderer also exposes a `.current` member, so check the
  // instance shape before treating `source` as a React ref.
  if (isSparkRenderer(source)) return source
  return (source as { current: SparkRenderer | null }).current
}

/**
 * Convert one RGBA readback buffer (bottom-up, as WebGL returns it) into a
 * PNG data URL via an offscreen canvas. Rows are flipped vertically so the
 * resulting image is upright.
 */
function rgbaBufferToPngDataUrl(buffer: Uint8Array, size: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('CubeCaptureController: failed to acquire 2D context')

  const image = ctx.createImageData(size, size)
  const dest = image.data
  const rowBytes = size * 4
  // Flip vertically: source row 0 is the bottom of the image.
  for (let y = 0; y < size; y++) {
    const srcStart = (size - 1 - y) * rowBytes
    const destStart = y * rowBytes
    dest.set(buffer.subarray(srcStart, srcStart + rowBytes), destStart)
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Strip the `data:image/png;base64,` prefix; the API contract wants raw base64. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

export function CubeCaptureController({ slug, sparkRenderer }: Props) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)

  const phase = useCubeCapture((s: CubeCaptureStore) => s.phase)
  const setCaptureResult = useCubeCapture((s: CubeCaptureStore) => s.setCaptureResult)
  const setPhase = useCubeCapture((s: CubeCaptureStore) => s.setPhase)
  const reset = useCubeCapture((s: CubeCaptureStore) => s.reset)

  // Guard against re-entrancy: phase stays 'capturing' across the async render,
  // and we don't want a second effect run to kick off a duplicate capture.
  const capturingRef = useRef(false)

  useEffect(() => {
    if (phase !== 'capturing') return
    if (capturingRef.current) return

    const spark = resolveSparkRenderer(sparkRenderer)
    if (!spark) {
      console.error('CubeCaptureController: no SparkRenderer instance available; aborting capture')
      reset()
      return
    }

    capturingRef.current = true
    let cancelled = false

    // Lock to High quality so Spark renders with encodeLinear=true (sRGB output).
    const debug = useDebugStore.getState()
    const priorQuality = debug.viewerQuality
    if (priorQuality !== ViewerQuality.High) {
      debug.setViewerQuality(ViewerQuality.High)
    }

    const capturePos = camera.getWorldPosition(new THREE.Vector3())

    // Preserve the scene camera's clip range when it is tighter/wider than the
    // Spark defaults, so the captured faces match what the user sees.
    const near =
      camera instanceof THREE.PerspectiveCamera && camera.near > 0 ? camera.near : FACE_NEAR
    const far =
      camera instanceof THREE.PerspectiveCamera && camera.far > 0 ? camera.far : FACE_FAR

    const run = async () => {
      // GL resources we create and must always dispose.
      const renderTarget = new THREE.WebGLRenderTarget(FACE_SIZE, FACE_SIZE, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      })
      // SRGBColorSpace matches Spark's `filter:false` cube target so the bytes
      // we read back carry the same gamma as the old renderCubeMap path.
      renderTarget.texture.colorSpace = THREE.SRGBColorSpace

      const renderer = spark.renderer
      const priorRenderTarget = renderer.getRenderTarget()
      // Disable Spark's per-frame auto-sort so the six sequential face renders
      // don't each kick off an async sort + accumulator swap (the root cause of
      // the empty-faces bug). `onBeforeRender` still runs and uploads each
      // face camera's view matrix — it just skips re-sorting.
      const priorAutoUpdate = spark.autoUpdate
      const priorSortRadial = spark.sortRadial
      spark.autoUpdate = false
      spark.sortRadial = true

      try {
        // ONE radial gaussian sort around the capture point. The radial metric
        // (distance from worldCenter) is direction-independent, so this single
        // sort is valid for all six face directions. `update` awaits the async
        // worker sort to completion before returning.
        const sortCamera = new THREE.PerspectiveCamera(90, 1, near, far)
        sortCamera.position.copy(capturePos)
        sortCamera.lookAt(capturePos.x, capturePos.y, capturePos.z - 1)
        sortCamera.updateMatrixWorld(true)
        await spark.update({ scene, camera: sortCamera })
        if (cancelled) return

        const faces = {} as CubeFaceUrls
        const facesBase64 = {} as CubeFaceUrls

        for (const { key, look, up } of FACE_ORIENTATIONS) {
          const faceCamera = new THREE.PerspectiveCamera(90, 1, near, far)
          faceCamera.position.copy(capturePos)
          faceCamera.up.set(up[0], up[1], up[2])
          faceCamera.lookAt(
            capturePos.x + look[0],
            capturePos.y + look[1],
            capturePos.z + look[2],
          )
          faceCamera.updateMatrixWorld(true)

          // Render this face. Spark's `onBeforeRender` (autoUpdate off) uploads
          // faceCamera's view matrix and the already-computed ordering texture,
          // so the splat draws correctly ordered for this direction. We render
          // twice: the first pass guarantees Spark's uniforms/ordering texture
          // are bound to the GL state for this target; the second is the clean
          // frame we read back.
          renderer.setRenderTarget(renderTarget)
          renderer.render(scene, faceCamera)
          renderer.render(scene, faceCamera)

          const buffer = new Uint8Array(FACE_SIZE * FACE_SIZE * 4)
          await renderer.readRenderTargetPixelsAsync(
            renderTarget,
            0,
            0,
            FACE_SIZE,
            FACE_SIZE,
            buffer,
          )
          if (cancelled) return

          const dataUrl = rgbaBufferToPngDataUrl(buffer, FACE_SIZE)
          faces[key] = dataUrl
          facesBase64[key] = stripDataUrlPrefix(dataUrl)
        }

        const response = await fetch(`/__cube-capture?slug=${encodeURIComponent(slug)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            capturePosition: [capturePos.x, capturePos.y, capturePos.z],
            faceSize: FACE_SIZE,
            faces: facesBase64,
          }),
        })
        if (!response.ok) {
          throw new Error(`/__cube-capture responded ${response.status}: ${await response.text()}`)
        }
        const result = (await response.json()) as {
          captureIndex: number
          faceUrls: CubeFaceUrls
        }
        if (cancelled) return

        // Prefer the server-returned local URLs; fall back to the freshly
        // captured data URLs if the server omitted them for any reason.
        const faceUrls = result.faceUrls ?? faces
        setCaptureResult(result.captureIndex, faceUrls)
      } catch (error) {
        if (cancelled) return
        console.error('CubeCaptureController: capture failed', error)
        // Drop back to idle so the UI isn't stuck in 'capturing'.
        setPhase('idle')
      } finally {
        // Restore Spark's render state so the live viewport resumes normally.
        spark.autoUpdate = priorAutoUpdate
        spark.sortRadial = priorSortRadial
        renderer.setRenderTarget(priorRenderTarget)
        renderTarget.dispose()
        // Restore the user's prior viewer quality regardless of outcome.
        if (priorQuality !== ViewerQuality.High) {
          useDebugStore.getState().setViewerQuality(priorQuality)
        }
        capturingRef.current = false
      }
    }

    void run()

    return () => {
      cancelled = true
    }
    // `gl` is read implicitly via Spark; we intentionally key only on phase and
    // the stable inputs needed to (re)trigger a capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, slug, sparkRenderer, scene, camera, gl])

  return null
}

export default CubeCaptureController
