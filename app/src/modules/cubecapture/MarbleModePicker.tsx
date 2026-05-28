import { useMemo, useState } from 'react'
import {
  CircleNotchIcon,
  ImagesIcon,
  PanoramaIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { AppButton } from '../../components/AppButton'
import { ChromePanel } from '../../components/AppChrome'
import { cubeToEquirect } from './CubeToEquirect'
import { cubeToMultiImage } from './CubeToMultiImage'
import {
  selectCubeFaceUrls,
  selectInpaintedUrl,
  selectPhase,
  selectSelectedFace,
  useCubeCapture,
  type CubeFaceKey,
  type CubeFaceUrls,
} from './useCubeCapture'

/**
 * MarbleModePicker — modal overlay shown after a cube face has been inpainted,
 * while the capture store is in the 'mode-picking' phase (and the spinner states
 * 'stitching'/'marbling').
 *
 * Presents two ways to condition Marble on the captured + inpainted cube:
 *
 *   1. Equirect (stitched pano): all 6 faces (5 original + 1 inpainted) are
 *      GPU-stitched into a single 4096x2048 equirectangular PNG and sent to
 *      Marble with `is_pano: true`.
 *   2. Multi-image (4 cardinal views): the 4 horizontal faces are packaged by
 *      azimuth (0/90/180/270) and fused natively by Marble via
 *      `multi_image_prompt`. Unavailable when the inpainted face is +Y / -Y
 *      (a top/bottom inpaint can't be represented by horizontal azimuths) — the
 *      card is disabled with an explainer and the user falls back to equirect.
 *
 * Either path POSTs to `/__marble-from-cube` with a mode-discriminated payload,
 * then advances the store to 'placing' once Marble returns a pending world index.
 *
 * Renders nothing unless phase is one of 'mode-picking' | 'stitching' | 'marbling'.
 */

interface MarbleModePickerProps {
  /** Project/world slug — scopes the `/__marble-from-cube` request. */
  slug: string
  /** Seed shared with primary World A so World B stays structurally consistent. */
  marbleSeed: number
}

/** Strip the `data:<mime>;base64,` prefix to match the API contract (raw base64). */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** Convert a Blob to raw base64 (no `data:` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('blobToBase64: read failed'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('blobToBase64: unexpected reader result'))
        return
      }
      resolve(stripDataUrlPrefix(result))
    }
    reader.readAsDataURL(blob)
  })
}

/** Fetch an image URL (data URL or `/worlds/...`) and convert it to raw base64. */
async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`urlToBase64: failed to fetch ${url} (${response.status})`)
  }
  const blob = await response.blob()
  return blobToBase64(blob)
}

type MarbleResponse = { pendingWorldIndex: number }

/**
 * Build the faces object used by both Marble paths: clone the captured faces and
 * substitute the inpainted image in for the selected face key.
 */
function buildFacesWithInpaint(
  cubeFaceUrls: CubeFaceUrls,
  selectedFace: CubeFaceKey,
  inpaintedUrl: string,
): CubeFaceUrls {
  return { ...cubeFaceUrls, [selectedFace]: inpaintedUrl }
}

export function MarbleModePicker({ slug, marbleSeed }: MarbleModePickerProps) {
  const phase = useCubeCapture(selectPhase)
  const cubeFaceUrls = useCubeCapture(selectCubeFaceUrls)
  const selectedFace = useCubeCapture(selectSelectedFace)
  const inpaintedUrl = useCubeCapture(selectInpaintedUrl)
  const captureIndex = useCubeCapture((s) => s.captureIndex)
  const setMode = useCubeCapture((s) => s.setMode)
  const setEquirect = useCubeCapture((s) => s.setEquirect)
  const setMultiImage = useCubeCapture((s) => s.setMultiImage)
  const setPendingWorldIndex = useCubeCapture((s) => s.setPendingWorldIndex)
  const setPhase = useCubeCapture((s) => s.setPhase)
  const reset = useCubeCapture((s) => s.reset)

  const [error, setError] = useState<string | null>(null)

  // The faces object with the inpainted face swapped in for the selected key.
  const facesWithInpaint = useMemo<CubeFaceUrls | null>(() => {
    if (!cubeFaceUrls || !selectedFace || !inpaintedUrl) return null
    return buildFacesWithInpaint(cubeFaceUrls, selectedFace, inpaintedUrl)
  }, [cubeFaceUrls, selectedFace, inpaintedUrl])

  // Multi-image is only available when the inpainted face is one of the 4
  // horizontal faces. cubeToMultiImage returns null for +Y / -Y.
  const cardinalFaces = useMemo(() => {
    if (!facesWithInpaint || !selectedFace) return null
    return cubeToMultiImage(facesWithInpaint, selectedFace)
  }, [facesWithInpaint, selectedFace])
  const multiImageDisabled =
    !cardinalFaces || selectedFace === 'py' || selectedFace === 'ny'

  const isBusy = phase === 'stitching' || phase === 'marbling'

  if (phase !== 'mode-picking' && phase !== 'stitching' && phase !== 'marbling') {
    return null
  }

  async function postMarble(body: unknown): Promise<MarbleResponse> {
    const params = new URLSearchParams({ slug })
    if (captureIndex != null) params.set('captureIndex', String(captureIndex))
    const response = await fetch(`/__marble-from-cube?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`/__marble-from-cube failed (${response.status})`)
    }
    return (await response.json()) as MarbleResponse
  }

  async function runEquirect() {
    if (!facesWithInpaint) return
    setError(null)
    setMode('equirect')
    setPhase('stitching')
    try {
      const blob = await cubeToEquirect(facesWithInpaint)
      const equirectPng = await blobToBase64(blob)
      setEquirect(URL.createObjectURL(blob))
      setPhase('marbling')
      const { pendingWorldIndex } = await postMarble({
        mode: 'equirect',
        equirectPng,
        seed: marbleSeed,
      })
      setPendingWorldIndex(pendingWorldIndex)
      setPhase('placing')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('mode-picking')
    }
  }

  async function runMultiImage() {
    if (!cardinalFaces) return
    setError(null)
    setMode('multi-image')
    setPhase('marbling')
    try {
      const [az0, az90, az180, az270] = await Promise.all([
        urlToBase64(cardinalFaces.az0),
        urlToBase64(cardinalFaces.az90),
        urlToBase64(cardinalFaces.az180),
        urlToBase64(cardinalFaces.az270),
      ])
      setMultiImage({
        az0: cardinalFaces.az0,
        az90: cardinalFaces.az90,
        az180: cardinalFaces.az180,
        az270: cardinalFaces.az270,
      })
      const { pendingWorldIndex } = await postMarble({
        mode: 'multi-image',
        azimuthFaces: { '0': az0, '90': az90, '180': az180, '270': az270 },
        seed: marbleSeed,
      })
      setPendingWorldIndex(pendingWorldIndex)
      setPhase('placing')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('mode-picking')
    }
  }

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Pick a Marble input mode"
    >
      <ChromePanel className="relative max-h-full w-[40rem] max-w-full overflow-auto p-4">
        <header className="mb-3 flex items-start justify-between gap-6">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-white/90">
              Pick a Marble input mode
            </h2>
            <p className="mt-1 max-w-[30rem] text-xs leading-snug text-white/55">
              Choose how the inpainted cube is fed back into Marble. Both reuse the same seed
              as the primary world so the patch stays structurally consistent.
            </p>
          </div>
          <AppButton
            onClick={reset}
            disabled={isBusy}
            aria-label="Cancel"
            className="h-7 w-7 flex-shrink-0 justify-center px-0"
          >
            <XIcon size={16} weight="bold" />
          </AppButton>
        </header>

        {isBusy ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <CircleNotchIcon size={28} weight="bold" className="animate-spin text-white/80" />
            <div>
              <p className="text-sm font-medium text-white/90">
                {phase === 'stitching' ? 'Stitching equirect pano…' : 'Marble is generating…'}
              </p>
              <p className="mt-1 text-xs text-white/50">
                {phase === 'stitching'
                  ? 'GPU-projecting 6 cube faces into a 4096×2048 panorama.'
                  : 'This usually takes about 2 minutes. Hang tight.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {/* Equirect card */}
              <button
                type="button"
                onClick={runEquirect}
                disabled={!facesWithInpaint}
                title="Stitch 6 faces into an equirectangular panorama"
                className="group flex flex-col items-stretch gap-2 rounded border border-white/15 bg-black/40 p-3 text-left transition-[border-color,background-color] hover:border-white/40 hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-white/90">
                  <PanoramaIcon size={18} weight="regular" className="text-white/70" />
                  Equirect (stitched pano)
                </span>
                <span className="text-xs leading-snug text-white/55">
                  Stitches all 6 faces (5 original + 1 inpainted) into one 4096×2048
                  equirectangular image and re-Marbles it with{' '}
                  <code className="text-white/70">is_pano</code>.
                </span>
              </button>

              {/* Multi-image card */}
              <button
                type="button"
                onClick={runMultiImage}
                disabled={multiImageDisabled}
                title={
                  multiImageDisabled
                    ? 'Unavailable: the inpainted face is the top/bottom of the cube'
                    : 'Send the 4 cardinal faces for native Marble fusion'
                }
                className="group flex flex-col items-stretch gap-2 rounded border border-white/15 bg-black/40 p-3 text-left transition-[border-color,background-color] hover:border-white/40 hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-white/90">
                  <ImagesIcon size={18} weight="regular" className="text-white/70" />
                  Multi-image (4 cardinal views)
                </span>
                <span className="text-xs leading-snug text-white/55">
                  Sends the 4 horizontal faces by azimuth (0/90/180/270) for Marble to fuse
                  natively via <code className="text-white/70">multi_image_prompt</code>. No
                  stitching.
                </span>
                {multiImageDisabled && (
                  <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-snug text-amber-300/90">
                    <WarningIcon size={13} weight="bold" className="mt-px flex-shrink-0" />
                    The inpainted face is the top/bottom of the cube. A vertical inpaint can't be
                    represented by horizontal azimuths — use Equirect instead.
                  </span>
                )}
              </button>
            </div>

            {error && (
              <p className="mt-3 flex items-start gap-1.5 text-xs leading-snug text-red-300">
                <WarningIcon size={13} weight="bold" className="mt-px flex-shrink-0" />
                {error}
              </p>
            )}
          </>
        )}
      </ChromePanel>
    </div>
  )
}
