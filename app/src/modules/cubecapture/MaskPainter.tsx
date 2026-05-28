import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { AppButton } from '../../components/AppButton'
import { chrome } from '../../components/AppChrome'
import {
  useCubeCapture,
  type CubeCaptureStore,
  type CubeFaceKey,
} from './useCubeCapture'

/**
 * MaskPainter — modal shown while `phase === 'masking'`.
 *
 * Renders the selected cube face and a paintable canvas overlay. The user
 * paints white strokes over the region they want Marble to regenerate; the
 * canvas is exported as a black-background / white-stroke PNG matching the
 * inpaint contract (white = regenerate). On submit it POSTs the mask to
 * `/__cube-inpaint` and advances the capture flow to mode picking.
 */

const CANVAS_SIZE = 512
const DEFAULT_BRUSH = 48
const MIN_BRUSH = 10
const MAX_BRUSH = 120

interface Props {
  /** World slug — the picker/controller owns it; passed down for the API call. */
  slug: string
}

/** Strip the `data:image/png;base64,` prefix; the API contract wants raw base64. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

export function MaskPainter({ slug }: Props) {
  const phase = useCubeCapture((s: CubeCaptureStore) => s.phase)
  const selectedFace = useCubeCapture((s: CubeCaptureStore) => s.selectedFace)
  const cubeFaceUrls = useCubeCapture((s: CubeCaptureStore) => s.cubeFaceUrls)
  const captureIndex = useCubeCapture((s: CubeCaptureStore) => s.captureIndex)
  const setMask = useCubeCapture((s: CubeCaptureStore) => s.setMask)
  const recordInpainted = useCubeCapture(
    (s: CubeCaptureStore) => s.recordInpainted,
  )
  const setPhase = useCubeCapture((s: CubeCaptureStore) => s.setPhase)
  const reset = useCubeCapture((s: CubeCaptureStore) => s.reset)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const paintingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)

  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasStrokes, setHasStrokes] = useState(false)

  const faceUrl =
    selectedFace && cubeFaceUrls ? cubeFaceUrls[selectedFace] : undefined

  // Initialize / reset the canvas to a fully black (no-regenerate) background
  // whenever the modal opens or the selected face changes.
  useEffect(() => {
    if (phase !== 'masking') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#ffffff'
    ctx.fillStyle = '#ffffff'
    setHasStrokes(false)
    setError(null)
  }, [phase, selectedFace])

  const clearMask = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.fillStyle = '#ffffff'
    setHasStrokes(false)
  }, [])

  /** Map a pointer event to canvas-space coordinates (handles CSS scaling). */
  const pointFromEvent = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      const scaleX = CANVAS_SIZE / rect.width
      const scaleY = CANVAS_SIZE / rect.height
      return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }
    },
    [],
  )

  /** Stamp a filled circle at a point — gives round brush dabs / endpoints. */
  const dab = useCallback(
    (x: number, y: number) => {
      const ctx = ctxRef.current
      if (!ctx) return
      ctx.beginPath()
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2)
      ctx.fill()
    },
    [brushSize],
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (submitting) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      paintingRef.current = true
      const point = pointFromEvent(event)
      lastPointRef.current = point
      dab(point.x, point.y)
      setHasStrokes(true)
    },
    [dab, pointFromEvent, submitting],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!paintingRef.current) return
      const ctx = ctxRef.current
      if (!ctx) return
      const point = pointFromEvent(event)
      const last = lastPointRef.current ?? point
      // Connect the last point to the current one so fast drags stay solid.
      ctx.lineWidth = brushSize
      ctx.beginPath()
      ctx.moveTo(last.x, last.y)
      ctx.lineTo(point.x, point.y)
      ctx.stroke()
      dab(point.x, point.y)
      lastPointRef.current = point
    },
    [brushSize, dab, pointFromEvent],
  )

  const endStroke = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!paintingRef.current) return
      paintingRef.current = false
      lastPointRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [],
  )

  const handleInpaint = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas || !selectedFace || captureIndex == null) return

    const maskDataUrl = canvas.toDataURL('image/png')
    const maskPng = stripDataUrlPrefix(maskDataUrl)

    setSubmitting(true)
    setError(null)
    setMask(maskDataUrl)
    setPhase('inpainting')

    try {
      const params = new URLSearchParams({
        slug,
        captureIndex: String(captureIndex),
        faceKey: selectedFace as CubeFaceKey,
      })
      const response = await fetch(`/__cube-inpaint?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maskPng, prompt: prompt.trim() || undefined }),
      })
      if (!response.ok) {
        throw new Error(
          `/__cube-inpaint responded ${response.status}: ${await response.text()}`,
        )
      }
      const result = (await response.json()) as { inpaintedUrl: string }
      if (!result?.inpaintedUrl) {
        throw new Error('/__cube-inpaint returned no inpaintedUrl')
      }
      // Record this face's result and return to the picker (recordInpainted
      // sets phase back to 'picking') so the user can inpaint another face.
      recordInpainted(selectedFace, maskDataUrl, result.inpaintedUrl)
    } catch (err) {
      console.error('MaskPainter: inpaint failed', err)
      setError(err instanceof Error ? err.message : 'inpaint failed')
      // Revert to masking so the user can retry with the same strokes.
      setPhase('masking')
    } finally {
      setSubmitting(false)
    }
  }, [
    captureIndex,
    prompt,
    recordInpainted,
    selectedFace,
    setMask,
    setPhase,
    slug,
  ])

  if (phase !== 'masking') return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className={`${chrome.panel} flex max-w-[90vw] flex-col gap-3 p-4`}>
        <div className={chrome.sectionHeader}>
          <span>paint mask · {selectedFace ?? 'face'}</span>
          <span className="text-white/40">white = regenerate</span>
        </div>

        <div
          className="relative overflow-hidden rounded ring-1 ring-white/10"
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        >
          {faceUrl ? (
            <img
              src={faceUrl}
              alt={`cube face ${selectedFace ?? ''}`}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/40">
              no face image
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none opacity-50 mix-blend-screen"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endStroke}
            onPointerLeave={endStroke}
            onPointerCancel={endStroke}
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-white/55">
          <span className="w-12">brush</span>
          <input
            type="range"
            min={MIN_BRUSH}
            max={MAX_BRUSH}
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="flex-1 accent-white/80"
            disabled={submitting}
          />
          <span className="w-8 text-right tabular-nums text-white/70">
            {brushSize}
          </span>
        </label>

        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="inpaint prompt (optional)"
          disabled={submitting}
          className="w-full rounded border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/90 placeholder:text-white/30 focus:border-white/30 focus:outline-none"
        />

        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <AppButton onClick={reset} disabled={submitting}>
            cancel
          </AppButton>
          <div className="flex items-center gap-1">
            <AppButton onClick={clearMask} disabled={submitting || !hasStrokes}>
              clear
            </AppButton>
            <AppButton
              onClick={() => void handleInpaint()}
              active
              disabled={submitting || !hasStrokes}
              className="bg-white/15 hover:bg-white/25"
            >
              {submitting ? 'inpainting…' : 'inpaint'}
            </AppButton>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MaskPainter
