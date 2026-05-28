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
 *   2. calls Spark's native `SparkRenderer.renderCubeMap(...)` at the camera's
 *      current world position to render the splat scene into a 1024² cube,
 *   3. reads back all six faces with `SparkRenderer.readCubeTargets()`,
 *   4. encodes each face to a PNG data URL (flipping rows — WebGL readback is
 *      bottom-up), maps them to px/nx/py/ny/pz/nz,
 *   5. POSTs base64 PNGs to `/__cube-capture?slug=<slug>`,
 *   6. records the server result in the store and restores the prior quality.
 */

/** Cube-face buffer order returned by Spark/three: +X,-X,+Y,-Y,+Z,-Z. */
const FACE_ORDER: readonly CubeFaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

const FACE_SIZE = 1024

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

    const run = async () => {
      try {
        // Spark renders all six faces of the splat scene into its internal
        // WebGLCubeRenderTarget. `update: true` re-sorts gaussians around the
        // capture position; `filter: false` keeps SRGBColorSpace + no mipmaps.
        await spark.renderCubeMap({
          scene,
          worldCenter: capturePos,
          size: FACE_SIZE,
          update: true,
          filter: false,
          hideObjects: [],
        })

        // Read all six faces back as RGBA byte buffers, in +X,-X,+Y,-Y,+Z,-Z
        // order. This reads directly from Spark's cube render target — no need
        // to hand-roll a fullscreen-quad pass per face.
        const buffers = await spark.readCubeTargets()
        if (cancelled) return
        if (!buffers || buffers.length < FACE_ORDER.length) {
          throw new Error(
            `CubeCaptureController: expected ${FACE_ORDER.length} face buffers, got ${buffers?.length ?? 0}`,
          )
        }

        const faces = {} as CubeFaceUrls
        const facesBase64 = {} as CubeFaceUrls
        for (let i = 0; i < FACE_ORDER.length; i++) {
          const key = FACE_ORDER[i]
          const dataUrl = rgbaBufferToPngDataUrl(buffers[i], FACE_SIZE)
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
