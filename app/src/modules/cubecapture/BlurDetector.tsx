import { useEffect, useRef, useState } from 'react'

/**
 * BlurDetector — 2D image-processing utility (+ optional overlay) for the
 * cube-capture flow.
 *
 * Marble hallucinates geometry/texture for regions that were occluded or poorly
 * lit in the source image. In the resulting splat those regions tend to read as
 * soft, low-frequency mush: little high-frequency structure, low local contrast.
 * A Laplacian-variance pass is the classic cheap detector for exactly this —
 * the Laplacian responds to edges/texture, so a region with a near-zero
 * Laplacian magnitude is "blurry / low-structure".
 *
 * This module works on the *captured face PNGs* (data URLs), not the live 3D
 * scene, so it needs no three.js — pure canvas + JS. The picker component
 * composes `computeBlurMap` (per face) and `bboxCrossesFaceEdge` to decide
 * whether a bad region is safely contained within a single cube face (a hard
 * requirement before inpainting that face in isolation).
 */

/** Bounding box in normalized 0..1 face coordinates. */
export interface NormalizedBBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Three-way face classification.
 *
 * The key insight (from real Marble captures off a single non-pano plate): the
 * directions Marble had no source data for come back as near-uniform flat-color
 * fills — they're *empty*, not blurry. They have NO data, so they're a candidate
 * to extend/fill (or skip), never to inpaint+re-Marble. A *blurry* face has real
 * (varied) content that's just degraded/hallucinated — that's the inpaint
 * candidate. A *ready* face has crisp structure throughout.
 */
export type FaceQuality = 'empty' | 'blurry' | 'ready'

export interface BlurMapResult {
  /** Transparent PNG data URL with blurry windows painted translucent red and empty windows neutral gray. Same aspect as the analysis canvas. */
  heatmapDataUrl: string
  /** Bounding box of the largest low-structure cluster, in normalized 0..1 face coords, or null if negligible. */
  blurBBox: NormalizedBBox | null
  /** Fraction (0..1) of windows flagged as low-structure. */
  lowStructureRatio: number
  /** Three-way classification: 'empty' (no data) | 'blurry' (fixable) | 'ready'. */
  quality: FaceQuality
  /** Mean Rec.601 luma (0..255) over the downscaled face. */
  meanLuminance: number
  /** Global variance of Rec.601 luma over the downscaled face. */
  luminanceVariance: number
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Downscale every face to this square resolution before analysis (speed). */
const ANALYSIS_SIZE = 256
/** Side length (px) of the averaging window over the squared-Laplacian map. */
const WINDOW = 16
/** Windows-per-side after the WINDOW reduction (256 / 16 = 16). */
const GRID = ANALYSIS_SIZE / WINDOW

/**
 * Structure-score threshold. Score = mean squared Laplacian over a 16×16 window
 * on a 0..255 luminance image. Sharp, textured regions easily exceed several
 * hundred; flat/blurry mush sits in the single digits. ~12 is a conservative
 * cutoff that flags genuine low-structure regions without catching mildly
 * smooth-but-valid surfaces. Tuned empirically against Marble splat captures.
 */
const STRUCTURE_THRESHOLD = 12
/** Below this flagged-window fraction the blur is treated as negligible (no bbox). */
const NEGLIGIBLE_RATIO = 0.02
/** Margin (in normalized coords) within which a bbox edge counts as touching a face edge. */
const EDGE_MARGIN = 0.04

/**
 * Global luma-variance cutoff for "empty" (no-data) faces. A face Marble had no
 * source for is a near-uniform flat fill, so its luma variance collapses toward
 * zero. Real interior content — even out-of-focus content — has wide luma spread
 * (shadows, highlights, color blocks) and sits orders of magnitude higher (often
 * thousands). 150 (≈ stddev 12 on a 0..255 scale) cleanly separates a flat
 * 77–102 KB PNG from a detailed 1.5 MB interior without catching low-contrast-
 * but-real surfaces. Empty is decided on variance alone, regardless of mean
 * (the flat color can be black, white, sky, etc.).
 */
const EMPTY_VARIANCE_THRESHOLD = 150
/**
 * Low-structure fraction above which a *non-empty* face is called "blurry".
 * If more than ~35% of windows lack Laplacian structure yet the face has real
 * luma variation, the content is degraded/hallucinated mush — the inpaint
 * candidate. Below this it's treated as 'ready' (enough crisp structure).
 */
const BLURRY_RATIO_THRESHOLD = 0.35

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`BlurDetector: failed to load image ${src.slice(0, 64)}…`))
    img.src = src
  })
}

/** A 2D drawing surface — prefers OffscreenCanvas, falls back to a detached <canvas>. */
function makeCanvas(size: number): {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  toDataURL: () => string
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null
    if (!ctx) throw new Error('BlurDetector: OffscreenCanvas 2D context unavailable')
    // OffscreenCanvas has no toDataURL; convert via a synchronous draw onto a real canvas only when needed.
    return {
      ctx,
      toDataURL: () => offscreenToDataURL(canvas),
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('BlurDetector: 2D context unavailable')
  return { ctx, toDataURL: () => canvas.toDataURL('image/png') }
}

/** OffscreenCanvas lacks toDataURL; blit its ImageData onto a real canvas to serialize. */
function offscreenToDataURL(off: OffscreenCanvas): string {
  const real = document.createElement('canvas')
  real.width = off.width
  real.height = off.height
  const ctx = real.getContext('2d')
  if (!ctx) throw new Error('BlurDetector: 2D context unavailable for serialization')
  const offCtx = off.getContext('2d') as OffscreenCanvasRenderingContext2D | null
  if (!offCtx) throw new Error('BlurDetector: OffscreenCanvas 2D context unavailable for serialization')
  ctx.putImageData(offCtx.getImageData(0, 0, off.width, off.height), 0, 0)
  return real.toDataURL('image/png')
}

/**
 * Compute a per-face blurriness heatmap via Laplacian variance.
 *
 * Steps:
 *  1. Draw the image to a 256×256 analysis canvas (downscale for speed).
 *  2. Convert to luminance, apply the 4-neighbor Laplacian kernel
 *     [0 -1 0; -1 4 -1; 0 -1 0] per pixel, take the squared magnitude.
 *  3. Average the squared Laplacian over non-overlapping 16×16 windows
 *     → a 16×16 grid of "structure scores".
 *  4. Flag windows whose score < STRUCTURE_THRESHOLD as low-structure.
 *  5. Classify the face (empty/blurry/ready) from global luma variance + the
 *     flagged fraction, then paint the heatmap: gray wash for empty (no-data),
 *     translucent red windows for blurry/ready low-structure regions.
 *  6. Bounding box = bbox of the largest connected (4-neighbor) cluster of
 *     flagged windows, normalized to 0..1; null if the flagged fraction is
 *     negligible.
 */
export async function computeBlurMap(imageDataUrl: string): Promise<BlurMapResult> {
  const img = await loadImage(imageDataUrl)

  const { ctx } = makeCanvas(ANALYSIS_SIZE)
  ctx.drawImage(img, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  const { data } = ctx.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)

  // 1. Luminance (Rec. 601) per pixel, accumulating global mean/variance.
  const lum = new Float32Array(ANALYSIS_SIZE * ANALYSIS_SIZE)
  let lumSum = 0
  let lumSumSq = 0
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
    lum[i] = l
    lumSum += l
    lumSumSq += l * l
  }
  const meanLuminance = lumSum / lum.length
  // Population variance: E[L²] - E[L]².
  const luminanceVariance = lumSumSq / lum.length - meanLuminance * meanLuminance

  // 2. Squared Laplacian per pixel (skip the 1px border; treat it as 0).
  const sqLap = new Float32Array(ANALYSIS_SIZE * ANALYSIS_SIZE)
  for (let y = 1; y < ANALYSIS_SIZE - 1; y++) {
    for (let x = 1; x < ANALYSIS_SIZE - 1; x++) {
      const i = y * ANALYSIS_SIZE + x
      const l =
        4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - ANALYSIS_SIZE] - lum[i + ANALYSIS_SIZE]
      sqLap[i] = l * l
    }
  }

  // 3. Mean squared Laplacian over each 16×16 window → structure score grid.
  const scores = new Float32Array(GRID * GRID)
  const winArea = WINDOW * WINDOW
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0
      const x0 = gx * WINDOW
      const y0 = gy * WINDOW
      for (let wy = 0; wy < WINDOW; wy++) {
        const row = (y0 + wy) * ANALYSIS_SIZE + x0
        for (let wx = 0; wx < WINDOW; wx++) sum += sqLap[row + wx]
      }
      scores[gy * GRID + gx] = sum / winArea
    }
  }

  // 4. Flag low-structure windows + paint heatmap.
  const flagged = new Uint8Array(GRID * GRID)
  let flaggedCount = 0
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < STRUCTURE_THRESHOLD) {
      flagged[i] = 1
      flaggedCount++
    }
  }
  const lowStructureRatio = flaggedCount / (GRID * GRID)

  // 5. Three-way classification.
  //  - 'empty':  near-uniform luma (no-data direction) → variance below cutoff,
  //              regardless of mean. These faces have NO content to fix.
  //  - 'blurry': real luma variation but mostly low-structure → degraded content,
  //              the inpaint candidate.
  //  - 'ready':  enough crisp Laplacian structure across the face.
  let quality: FaceQuality
  if (luminanceVariance < EMPTY_VARIANCE_THRESHOLD) quality = 'empty'
  else if (lowStructureRatio >= BLURRY_RATIO_THRESHOLD) quality = 'blurry'
  else quality = 'ready'

  // 6. Heatmap. Empty faces get a neutral gray wash (no-data, nothing to fix);
  //    blurry/ready faces keep the red low-structure overlay so the two read
  //    differently at a glance.
  const heat = makeCanvas(ANALYSIS_SIZE)
  heat.ctx.clearRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  if (quality === 'empty') {
    heat.ctx.fillStyle = 'rgba(140, 140, 150, 0.40)'
    heat.ctx.fillRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  } else {
    heat.ctx.fillStyle = 'rgba(255, 40, 40, 0.45)'
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        if (flagged[gy * GRID + gx]) {
          heat.ctx.fillRect(gx * WINDOW, gy * WINDOW, WINDOW, WINDOW)
        }
      }
    }
  }
  const heatmapDataUrl = heat.toDataURL()

  // 7. Largest connected cluster bbox (4-neighbor flood fill over the grid).
  const blurBBox =
    lowStructureRatio < NEGLIGIBLE_RATIO ? null : largestClusterBBox(flagged, GRID)

  return { heatmapDataUrl, blurBBox, lowStructureRatio, quality, meanLuminance, luminanceVariance }
}

/**
 * Flood-fill the flagged-window grid, find the largest 4-connected cluster, and
 * return its bbox normalized to 0..1 face coords. Returns null if no flagged
 * windows exist.
 */
function largestClusterBBox(flagged: Uint8Array, grid: number): NormalizedBBox | null {
  const visited = new Uint8Array(flagged.length)
  const stack: number[] = []
  let best: { minX: number; minY: number; maxX: number; maxY: number; size: number } | null = null

  for (let start = 0; start < flagged.length; start++) {
    if (!flagged[start] || visited[start]) continue
    let minX = grid
    let minY = grid
    let maxX = -1
    let maxY = -1
    let size = 0
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length) {
      const idx = stack.pop() as number
      const cx = idx % grid
      const cy = (idx - cx) / grid
      size++
      if (cx < minX) minX = cx
      if (cy < minY) minY = cy
      if (cx > maxX) maxX = cx
      if (cy > maxY) maxY = cy
      // 4-neighbors.
      if (cx > 0 && flagged[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1
        stack.push(idx - 1)
      }
      if (cx < grid - 1 && flagged[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1
        stack.push(idx + 1)
      }
      if (cy > 0 && flagged[idx - grid] && !visited[idx - grid]) {
        visited[idx - grid] = 1
        stack.push(idx - grid)
      }
      if (cy < grid - 1 && flagged[idx + grid] && !visited[idx + grid]) {
        visited[idx + grid] = 1
        stack.push(idx + grid)
      }
    }
    if (!best || size > best.size) best = { minX, minY, maxX, maxY, size }
  }

  if (!best) return null
  // Windows span [min, max] inclusive; bbox covers their full extent in pixels,
  // then normalize by the analysis size (grid * WINDOW).
  const x = (best.minX * WINDOW) / ANALYSIS_SIZE
  const y = (best.minY * WINDOW) / ANALYSIS_SIZE
  const w = ((best.maxX - best.minX + 1) * WINDOW) / ANALYSIS_SIZE
  const h = ((best.maxY - best.minY + 1) * WINDOW) / ANALYSIS_SIZE
  return { x, y, w, h }
}

/**
 * True if the bbox touches any of the four face edges (left/top/right/bottom)
 * within EDGE_MARGIN. Inpainting a single cube face in isolation requires the
 * bad region to be fully contained — a bbox crossing an edge means the blur
 * spills onto a neighboring face and the user should reposition.
 */
export function bboxCrossesFaceEdge(bbox: NormalizedBBox | null, margin = EDGE_MARGIN): boolean {
  if (!bbox) return false
  return (
    bbox.x <= margin ||
    bbox.y <= margin ||
    bbox.x + bbox.w >= 1 - margin ||
    bbox.y + bbox.h >= 1 - margin
  )
}

// ---------------------------------------------------------------------------
// Optional React overlay
// ---------------------------------------------------------------------------

export interface BlurOverlayProps {
  /** Data URL (or local URL) of the captured cube face to analyze + display. */
  faceUrl: string
  /** Rendered thumbnail size in px. Defaults to 160. */
  size?: number
  className?: string
  /** Fires once analysis completes, so a parent picker can read containment state. */
  onResult?: (result: BlurMapResult & { crossesEdge: boolean }) => void
}

/**
 * Renders a face thumbnail with the Laplacian-variance heatmap layered on top,
 * plus a 3-way status badge: gray "empty · no data" | red "blurry · fixable"
 * (or "blur crosses edge") | green "ready". Kept deliberately minimal — the
 * CubeFacePicker composes six of these in its cross layout.
 */
export function BlurOverlay({ faceUrl, size = 160, className, onResult }: BlurOverlayProps) {
  const [result, setResult] = useState<BlurMapResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setError(null)
    computeBlurMap(faceUrl)
      .then((r) => {
        if (cancelled) return
        setResult(r)
        onResultRef.current?.({ ...r, crossesEdge: bboxCrossesFaceEdge(r.blurBBox) })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [faceUrl])

  const crossesEdge = result ? bboxCrossesFaceEdge(result.blurBBox) : false

  let badge: { label: string; color: string }
  if (error) badge = { label: 'error', color: 'rgba(120,120,120,0.85)' }
  else if (!result) badge = { label: 'analyzing…', color: 'rgba(120,120,120,0.85)' }
  // 'empty' (no data) reads gray; 'blurry' (fixable) reads red and still surfaces
  // the crosses-edge caveat; 'ready' reads green.
  else if (result.quality === 'empty') badge = { label: 'empty · no data', color: 'rgba(120,124,135,0.92)' }
  else if (result.quality === 'blurry')
    badge = crossesEdge
      ? { label: 'blur crosses edge', color: 'rgba(220,60,60,0.9)' }
      : { label: 'blurry · fixable', color: 'rgba(220,60,60,0.9)' }
  else badge = { label: 'ready', color: 'rgba(60,170,90,0.9)' }

  return (
    <div
      className={className}
      style={{ position: 'relative', width: size, height: size, overflow: 'hidden' }}
    >
      <img
        src={faceUrl}
        alt="cube face"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {result && (
        <img
          src={result.heatmapDataUrl}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
          }}
        />
      )}
      <span
        style={{
          position: 'absolute',
          left: 4,
          bottom: 4,
          padding: '1px 6px',
          fontSize: 10,
          lineHeight: '14px',
          borderRadius: 4,
          color: '#fff',
          background: badge.color,
          pointerEvents: 'none',
        }}
      >
        {badge.label}
      </span>
    </div>
  )
}
