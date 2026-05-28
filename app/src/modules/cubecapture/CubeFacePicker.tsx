import { useState } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { AppButton } from '../../components/AppButton'
import { ChromePanel } from '../../components/AppChrome'
import { BlurOverlay, type BlurMapResult } from './BlurDetector'
import {
  selectCubeFaceUrls,
  selectPhase,
  useCubeCapture,
  type CubeFaceKey,
} from './useCubeCapture'

/**
 * CubeFacePicker — modal overlay shown while the capture store is in the
 * 'picking' phase.
 *
 * Renders the six captured cube faces in a standard unfolded cube-cross layout,
 * each wrapped in a <BlurOverlay> so the user sees the heatmap + a 3-way status
 * badge: green "ready" / red "blurry · fixable" (real content — fix targets) vs.
 * gray "empty · no data" (directions Marble had no source for). The usual goal is
 * to pick a green/red face whose bad region is fully contained — inpainting one
 * face in isolation requires the blur not to spill across a cube-face edge — but
 * empty faces stay clickable for the "extend the world" use case.
 *
 * Clicking a face advances the store to 'masking' via selectFace(key); the close
 * button resets the store back to idle. Renders nothing unless phase==='picking'.
 */

/** Size (px) of each face cell in the cross layout. */
const FACE_SIZE = 144

/**
 * Cube-cross grid placement. A standard unfolded cube on a 4-wide × 3-tall grid:
 *
 * ```
 *        [ +Y ]
 *   [ -X ][ +Z ][ +X ][ -Z ]
 *        [ -Y ]
 * ```
 *
 * Mapped to face keys: top row py; middle row nx, pz, px, nz; bottom row ny.
 * `col`/`row` are 1-indexed CSS grid lines.
 */
const CROSS_CELLS: { key: CubeFaceKey; label: string; col: number; row: number }[] = [
  { key: 'py', label: '+Y (up)', col: 2, row: 1 },
  { key: 'nx', label: '-X (left)', col: 1, row: 2 },
  { key: 'pz', label: '+Z (front)', col: 2, row: 2 },
  { key: 'px', label: '+X (right)', col: 3, row: 2 },
  { key: 'nz', label: '-Z (back)', col: 4, row: 2 },
  { key: 'ny', label: '-Y (down)', col: 2, row: 3 },
]

export function CubeFacePicker() {
  const phase = useCubeCapture(selectPhase)
  const cubeFaceUrls = useCubeCapture(selectCubeFaceUrls)
  const selectFace = useCubeCapture((s) => s.selectFace)
  const reset = useCubeCapture((s) => s.reset)

  // Per-face containment state, populated as each BlurOverlay finishes analysis.
  const [results, setResults] = useState<Partial<Record<CubeFaceKey, BlurMapResult & { crossesEdge: boolean }>>>({})

  if (phase !== 'picking' || !cubeFaceUrls) return null

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Pick the face with the bad region"
    >
      <ChromePanel className="relative max-h-full overflow-auto p-4">
        <header className="mb-3 flex items-start justify-between gap-6">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-white/90">
              Pick the face with the bad region
            </h2>
            <p className="mt-1 max-w-[30rem] text-xs leading-snug text-white/55">
              <span className="text-emerald-300">Ready</span> (green) and{' '}
              <span className="text-red-300">blurry · fixable</span> (red) faces have real content —
              those are the fix targets. <span className="text-zinc-300">Empty · no data</span>{' '}
              (gray) faces are directions Marble had no source for; you can still pick one to{' '}
              <em>extend</em> the world, but it isn&apos;t a blur fix. For a fix, choose the face
              whose bad area sits fully inside it — if it&apos;s flagged{' '}
              <span className="text-red-300">blur crosses edge</span> the region spills onto a
              neighbor, so reposition and re-capture.
            </p>
          </div>
          <AppButton
            onClick={reset}
            aria-label="Cancel capture"
            className="h-7 w-7 flex-shrink-0 justify-center px-0"
          >
            <XIcon size={16} weight="bold" />
          </AppButton>
        </header>

        <div
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(4, ${FACE_SIZE}px)`,
            gridTemplateRows: `repeat(3, auto)`,
          }}
        >
          {CROSS_CELLS.map(({ key, label, col, row }) => {
            const faceUrl = cubeFaceUrls[key]
            const result = results[key]
            // Border keys off the 3-way quality: gray = empty (no data),
            // amber/red = blurry (fixable, fix target), green = ready. Falls
            // back to neutral until the face finishes analyzing.
            let borderClass = 'border-white/15 hover:border-white/40'
            if (result?.quality === 'empty')
              borderClass = 'border-zinc-500/50 hover:border-zinc-400'
            else if (result?.quality === 'blurry')
              borderClass = 'border-red-400/60 hover:border-red-300'
            else if (result?.quality === 'ready')
              borderClass = 'border-emerald-400/50 hover:border-emerald-300'
            return (
              <button
                key={key}
                type="button"
                onClick={() => selectFace(key)}
                title={`Select ${label}`}
                className={`group flex flex-col items-stretch gap-1 rounded border bg-black/40 p-1 text-left transition-[border-color,background-color] hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60 ${borderClass}`}
                style={{ gridColumnStart: col, gridRowStart: row }}
              >
                <div className="overflow-hidden rounded">
                  <BlurOverlay
                    faceUrl={faceUrl}
                    size={FACE_SIZE - 8}
                    onResult={(r) => setResults((prev) => ({ ...prev, [key]: r }))}
                  />
                </div>
                <span className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-white/45">
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </ChromePanel>
    </div>
  )
}
