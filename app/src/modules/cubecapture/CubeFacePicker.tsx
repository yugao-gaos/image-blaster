import { useCallback, useEffect, useState } from 'react'
import { CrosshairSimpleIcon, XIcon } from '@phosphor-icons/react'
import { AppButton } from '../../components/AppButton'
import { ChromePanel } from '../../components/AppChrome'
import { BlurOverlay, type BlurMapResult } from './BlurDetector'
import {
  selectCaptureIndex,
  selectCubeFaceUrls,
  selectInpaintedFaces,
  selectPhase,
  useCubeCapture,
  type CubeFaceKey,
  type CubeFaceUrls,
} from './useCubeCapture'
import type { Vec3Tuple } from '../../types/world'

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
 * Multi-face flow: clicking a face advances to 'masking' via selectFace(key);
 * after inpaint the store returns here so the user can fix more faces. Faces that
 * have already been inpainted show a green "✓ inpainted" badge but stay clickable
 * (re-inpaint overwrites). Once at least one face is done, "Proceed to Marble"
 * advances to mode-picking. A captures list (fetched from GET /__cube-captures)
 * lets the user jump back to any prior capture set and keep inpainting it.
 *
 * The close button resets the store back to idle. Renders nothing unless
 * phase==='picking'.
 */

/** One capture set as returned by GET /__cube-captures. */
interface CaptureSetSummary {
  captureIndex: number
  /** Camera position where this capture was taken, for snapping back. May be
   *  null for older captures recorded before positions were persisted. */
  capturePosition: Vec3Tuple | null
  faceUrls: CubeFaceUrls
  inpaintedFaces: Partial<Record<CubeFaceKey, string>>
}

/** Size (px) of each face cell in the cross layout. */
const FACE_SIZE = 144

/**
 * Coerce an unknown JSON value into a Vec3Tuple, or null if it isn't a
 * length-3 array of finite numbers. Guards against missing/legacy
 * `capturePosition` fields in the /__cube-captures response.
 */
function toVec3Tuple(value: unknown): Vec3Tuple | null {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return value as Vec3Tuple
  }
  return null
}

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

export function CubeFacePicker({ slug }: { slug: string }) {
  const phase = useCubeCapture(selectPhase)
  const cubeFaceUrls = useCubeCapture(selectCubeFaceUrls)
  const captureIndex = useCubeCapture(selectCaptureIndex)
  const inpaintedFaces = useCubeCapture(selectInpaintedFaces)
  const selectFace = useCubeCapture((s) => s.selectFace)
  const proceedToMarble = useCubeCapture((s) => s.proceedToMarble)
  const reopenCapture = useCubeCapture((s) => s.reopenCapture)
  const setCameraSnapTarget = useCubeCapture((s) => s.setCameraSnapTarget)
  const reset = useCubeCapture((s) => s.reset)

  // Per-face containment state, populated as each BlurOverlay finishes analysis.
  const [results, setResults] = useState<Partial<Record<CubeFaceKey, BlurMapResult & { crossesEdge: boolean }>>>({})

  // Disk-backed list of all capture sets for this project, for revisiting.
  const [captureSets, setCaptureSets] = useState<CaptureSetSummary[]>([])

  // Refetch the captures list whenever we (re-)enter the picking phase. Each
  // completed inpaint returns the store to 'picking', so this keeps the
  // per-set inpaint counts fresh. Errors are swallowed → empty list.
  const refreshCaptures = useCallback(() => {
    if (phase !== 'picking') return
    let cancelled = false
    fetch(`/__cube-captures?slug=${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => {
        if (cancelled) return
        // Normalize each row, coercing capturePosition into a valid Vec3Tuple
        // or null (older captures predate persisted positions).
        const list = Array.isArray(data)
          ? (data as CaptureSetSummary[]).map((set) => ({
              ...set,
              capturePosition: toVec3Tuple((set as { capturePosition?: unknown }).capturePosition),
            }))
          : []
        setCaptureSets(list)
      })
      .catch(() => {
        if (!cancelled) setCaptureSets([])
      })
    return () => {
      cancelled = true
    }
  }, [phase, slug])

  useEffect(() => refreshCaptures(), [refreshCaptures])

  const inpaintedCount = Object.keys(inpaintedFaces).length

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
              neighbor, so reposition and re-capture. You can{' '}
              <span className="text-emerald-300">inpaint multiple faces</span> (each one returns you
              here), <span className="text-sky-300">switch between captures</span> on the left, then{' '}
              <span className="text-white/80">Proceed to Marble</span> when you&apos;re happy.
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

        <div className="flex items-start gap-4">
          {/* Captures list — every capture set on disk for this project. Click
              one to reopen it and keep inpainting its faces. */}
          <aside className="flex w-40 flex-shrink-0 flex-col gap-1.5">
            <h3 className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-white/40">
              Captures
            </h3>
            {captureSets.length === 0 ? (
              <p className="px-0.5 text-[11px] leading-snug text-white/35">
                No other capture sets yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {captureSets.map((set) => {
                  const active = set.captureIndex === captureIndex
                  const count = Object.keys(set.inpaintedFaces ?? {}).length
                  const canSnap = set.capturePosition !== null
                  return (
                    <li key={set.captureIndex} className="flex items-stretch gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          reopenCapture(
                            set.captureIndex,
                            set.capturePosition,
                            set.faceUrls,
                            // Server returns a bare inpainted URL per face; the
                            // store wants { inpaintedUrl } (mask is reloaded on
                            // demand when a face is re-inpainted).
                            Object.fromEntries(
                              Object.entries(set.inpaintedFaces ?? {}).map(([face, url]) => [
                                face,
                                { inpaintedUrl: url as string },
                              ]),
                            ),
                          )
                          // Fly the viewer camera back to where this capture was
                          // taken so the picked face lines up with the vantage.
                          if (set.capturePosition) setCameraSnapTarget(set.capturePosition)
                        }}
                        aria-current={active ? 'true' : undefined}
                        className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60 ${
                          active
                            ? 'border-sky-400/60 bg-sky-400/15 text-white'
                            : 'border-white/10 bg-black/30 text-white/65 hover:border-white/30 hover:bg-white/5'
                        }`}
                      >
                        <span className="truncate font-medium">Capture #{set.captureIndex}</span>
                        <span
                          className={`tabular-nums ${count > 0 ? 'text-emerald-300' : 'text-white/35'}`}
                          title={`${count} face(s) inpainted`}
                        >
                          {count}✓
                        </span>
                      </button>
                      {/* Standalone snap-to-vantage: flies the camera to this
                          capture's position without reopening it. Hidden when the
                          capture has no recorded position. */}
                      {canSnap && (
                        <button
                          type="button"
                          onClick={() => setCameraSnapTarget(set.capturePosition)}
                          aria-label={`Snap camera to capture #${set.captureIndex}`}
                          title="Snap camera to capture"
                          className="flex w-7 flex-shrink-0 items-center justify-center rounded border border-white/10 bg-black/30 text-white/55 transition-colors hover:border-sky-400/50 hover:bg-sky-400/15 hover:text-sky-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
                        >
                          <CrosshairSimpleIcon size={14} weight="bold" />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>

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
              const isInpainted = key in inpaintedFaces
              // Border keys off the 3-way quality: gray = empty (no data),
              // amber/red = blurry (fixable, fix target), green = ready. Falls
              // back to neutral until the face finishes analyzing. An inpainted
              // face overrides with a solid emerald border regardless of quality.
              let borderClass = 'border-white/15 hover:border-white/40'
              if (result?.quality === 'empty')
                borderClass = 'border-zinc-500/50 hover:border-zinc-400'
              else if (result?.quality === 'blurry')
                borderClass = 'border-red-400/60 hover:border-red-300'
              else if (result?.quality === 'ready')
                borderClass = 'border-emerald-400/50 hover:border-emerald-300'
              if (isInpainted) borderClass = 'border-emerald-400 hover:border-emerald-300'
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectFace(key)}
                  title={isInpainted ? `Re-inpaint ${label}` : `Select ${label}`}
                  className={`group relative flex flex-col items-stretch gap-1 rounded border bg-black/40 p-1 text-left transition-[border-color,background-color] hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60 ${borderClass}`}
                  style={{ gridColumnStart: col, gridRowStart: row }}
                >
                  <div className="overflow-hidden rounded">
                    <BlurOverlay
                      faceUrl={faceUrl}
                      size={FACE_SIZE - 8}
                      onResult={(r) => setResults((prev) => ({ ...prev, [key]: r }))}
                    />
                  </div>
                  {isInpainted && (
                    <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow ring-1 ring-emerald-300/60">
                      ✓ inpainted
                    </span>
                  )}
                  <span className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-white/45">
                    {label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Proceed footer — advances to Marble mode picking. Gated on having
            inpainted at least one face of the current capture. */}
        <footer className="mt-4 flex items-center justify-end gap-3">
          {inpaintedCount === 0 && (
            <span className="text-[11px] text-white/45">inpaint at least one face</span>
          )}
          <AppButton
            onClick={proceedToMarble}
            disabled={inpaintedCount === 0}
            active={inpaintedCount > 0}
            title={
              inpaintedCount === 0
                ? 'Inpaint at least one face first'
                : 'Continue to Marble mode picking'
            }
            className={
              inpaintedCount === 0
                ? 'cursor-not-allowed border border-white/10 bg-white/5 text-white/40 opacity-100 hover:bg-white/5'
                : 'border border-emerald-400/70 bg-emerald-500/25 px-3 py-1.5 font-medium text-emerald-100 opacity-100 hover:bg-emerald-500/35'
            }
          >
            Proceed to Marble · {inpaintedCount} face{inpaintedCount === 1 ? '' : 's'}
          </AppButton>
        </footer>
      </ChromePanel>
    </div>
  )
}
