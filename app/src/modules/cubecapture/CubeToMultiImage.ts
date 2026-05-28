/**
 * Pure JS util for the Marble "multi-image" input path.
 *
 * Instead of stitching the 6 captured cube faces into a single equirect pano,
 * the multi-image path hands Marble the 4 cardinal (horizontal) faces keyed by
 * azimuth and lets it fuse them natively via `multi_image_prompt`
 * (`reconstruct_images: true`). Marble expects azimuths 0/90/180/270.
 *
 * Capture convention (must stay consistent with CubeCaptureController /
 * CubeToEquirect and the `CubeCaptureMeta` type in `types/world.ts`):
 *   px = +X, nx = -X, py = +Y, ny = -Y, pz = +Z, nz = -Z
 *
 * Cardinal → azimuth mapping:
 *   +Z (pz) → az0
 *   +X (px) → az90
 *   -Z (nz) → az180
 *   -X (nx) → az270
 *
 * The top/bottom faces (+Y / -Y) are not horizontal, so an inpaint on them
 * cannot be represented by the 4 horizontal azimuths — multi-image mode is
 * unavailable in that case and the UI falls back to the equirect path.
 */

export type CubeFaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'

export type CubeFaces = Record<CubeFaceKey, string>

/** The four cardinal faces keyed by azimuth for Marble's `multi_image_prompt`. */
export type CardinalFaces = { az0: string; az90: string; az180: string; az270: string }

/**
 * Select the 4 cardinal (horizontal) cube faces and key them by azimuth.
 *
 * Returns the 4 cardinal faces, or `null` when the inpainted/selected face is
 * +Y (`py`) or -Y (`ny`) — multi-image mode can't represent a top/bottom
 * inpaint via horizontal azimuths.
 *
 * When the inpainted face is one of the 4 horizontal faces it is naturally
 * included in the result (it is one of px/nx/pz/nz).
 */
export function cubeToMultiImage(
  faces: CubeFaces,
  inpaintedFaceKey: CubeFaceKey,
): CardinalFaces | null {
  if (inpaintedFaceKey === 'py' || inpaintedFaceKey === 'ny') {
    return null
  }
  return {
    az0: faces.pz, // +Z
    az90: faces.px, // +X
    az180: faces.nz, // -Z
    az270: faces.nx, // -X
  }
}
