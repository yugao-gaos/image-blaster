import { useState } from 'react'

import { AppButton } from '../../components/AppButton'
import { ChromePanel } from '../../components/AppChrome'
import {
  selectCubeFaceUrls,
  selectPendingInpaint,
  selectPhase,
  useCubeCapture,
  type CubeFaceKey,
} from './useCubeCapture'

/**
 * InpaintReview — modal shown while `phase === 'reviewing'`.
 *
 * After a face is inpainted the store stages the result in `pendingInpaint`
 * (rather than recording it immediately) and flips to the 'reviewing' phase.
 * This modal shows a clear BEFORE/AFTER comparison of that single face:
 *
 *   - Original  = the originally captured face (`cubeFaceUrls[face]`)
 *   - Inpainted = the freshly generated result (`pendingInpaint.inpaintedUrl`)
 *
 * The two are shown side-by-side, labeled. A "wipe" toggle stacks them and
 * exposes an opacity slider so the user can cross-fade between original and
 * inpainted in place — handy for spotting subtle seam/lighting changes.
 *
 * Decisions map straight onto the store actions:
 *   - "Use this result" → acceptInpaint()  (records + back to picker)
 *   - "Re-mask"         → remaskInpaint()  (back to masking, redo the mask)
 *   - "Discard"         → discardInpaint() (back to picker, nothing recorded)
 *
 * Renders nothing unless phase==='reviewing' && a pendingInpaint exists.
 */

/** Friendly, readable labels for each cube face key. */
const FACE_LABELS: Record<CubeFaceKey, string> = {
  px: '+X (right)',
  nx: '-X (left)',
  py: '+Y (up)',
  ny: '-Y (down)',
  pz: '+Z (front)',
  nz: '-Z (back)',
}

/** Side length (px) of each comparison image. */
const IMAGE_SIZE = 416

export function InpaintReview() {
  const phase = useCubeCapture(selectPhase)
  const pendingInpaint = useCubeCapture(selectPendingInpaint)
  const cubeFaceUrls = useCubeCapture(selectCubeFaceUrls)
  const acceptInpaint = useCubeCapture((s) => s.acceptInpaint)
  const discardInpaint = useCubeCapture((s) => s.discardInpaint)
  const remaskInpaint = useCubeCapture((s) => s.remaskInpaint)

  // 'wipe' mode stacks the two images and uses `wipe` (0=original → 100=inpainted)
  // to cross-fade between them; otherwise they sit side-by-side.
  const [wipe, setWipe] = useState(false)
  const [wipeValue, setWipeValue] = useState(50)

  if (phase !== 'reviewing' || !pendingInpaint) return null

  const { face, inpaintedUrl } = pendingInpaint
  const originalUrl = cubeFaceUrls?.[face]
  const label = FACE_LABELS[face] ?? face

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Review inpaint for face ${label}`}
    >
      <ChromePanel className="relative max-h-full overflow-auto p-4">
        <header className="mb-3 flex items-start justify-between gap-6">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-white/90">
              Review inpaint — face {label}
            </h2>
            <p className="mt-1 max-w-[30rem] text-xs leading-snug text-white/55">
              Compare the <span className="text-white/80">original</span> capture against the{' '}
              <span className="text-emerald-300">inpainted</span> result. Keep it if the fix looks
              clean, re-mask to redo the painted region, or discard to leave the face untouched.
            </p>
          </div>
          <label className="flex flex-shrink-0 items-center gap-2 text-[11px] text-white/55">
            <input
              type="checkbox"
              checked={wipe}
              onChange={(event) => setWipe(event.target.checked)}
              className="accent-white/80"
            />
            <span className="uppercase tracking-wider">Wipe</span>
          </label>
        </header>

        {wipe ? (
          <div className="flex flex-col items-center gap-3">
            <div
              className="relative overflow-hidden rounded ring-1 ring-white/10"
              style={{ width: IMAGE_SIZE, height: IMAGE_SIZE }}
            >
              {originalUrl ? (
                <img
                  src={originalUrl}
                  alt={`original face ${label}`}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                  draggable={false}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-white/40">
                  no original image
                </div>
              )}
              <img
                src={inpaintedUrl}
                alt={`inpainted face ${label}`}
                className="absolute inset-0 h-full w-full select-none object-cover"
                style={{ opacity: wipeValue / 100 }}
                draggable={false}
              />
            </div>
            <label className="flex w-full items-center gap-2 text-[11px] text-white/55">
              <span className="w-16 flex-shrink-0">Original</span>
              <input
                type="range"
                min={0}
                max={100}
                value={wipeValue}
                onChange={(event) => setWipeValue(Number(event.target.value))}
                className="flex-1 accent-white/80"
                aria-label="Cross-fade between original and inpainted"
              />
              <span className="w-16 flex-shrink-0 text-right text-emerald-300">Inpainted</span>
            </label>
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <figure className="flex flex-col gap-1.5">
              <figcaption className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-white/45">
                Original
              </figcaption>
              <div
                className="overflow-hidden rounded ring-1 ring-white/10"
                style={{ width: IMAGE_SIZE, height: IMAGE_SIZE }}
              >
                {originalUrl ? (
                  <img
                    src={originalUrl}
                    alt={`original face ${label}`}
                    className="h-full w-full select-none object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-white/40">
                    no original image
                  </div>
                )}
              </div>
            </figure>
            <figure className="flex flex-col gap-1.5">
              <figcaption className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                Inpainted
              </figcaption>
              <div
                className="overflow-hidden rounded ring-1 ring-emerald-400/30"
                style={{ width: IMAGE_SIZE, height: IMAGE_SIZE }}
              >
                <img
                  src={inpaintedUrl}
                  alt={`inpainted face ${label}`}
                  className="h-full w-full select-none object-cover"
                  draggable={false}
                />
              </div>
            </figure>
          </div>
        )}

        <footer className="mt-4 flex items-center justify-end gap-2">
          <AppButton onClick={discardInpaint} title="Leave the face untouched">
            Discard
          </AppButton>
          <AppButton onClick={remaskInpaint} title="Redo the painted mask for this face">
            Re-mask
          </AppButton>
          <AppButton
            onClick={acceptInpaint}
            active
            title="Record this inpaint and return to the picker"
            className="border border-emerald-400/70 bg-emerald-500/25 px-3 py-1.5 font-medium text-emerald-100 hover:bg-emerald-500/35"
          >
            Use this result
          </AppButton>
        </footer>
      </ChromePanel>
    </div>
  )
}

export default InpaintReview
