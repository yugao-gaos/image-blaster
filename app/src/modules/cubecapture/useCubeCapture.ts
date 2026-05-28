import { create } from 'zustand'
import type { Vec3Tuple } from '../../types/world'

/**
 * Cube-capture feature state machine.
 *
 * Flow (see plan "capture path"): the user walks the splat, captures a cube at
 * their current position, then iteratively fixes faces — for each face they pick
 * it, paint a mask, inpaint, and return to the picker. Multiple faces of the same
 * capture can be inpainted; completed results accumulate in `inpaintedFaces` keyed
 * by face. Once at least one face is done the user proceeds to choose a Marble input
 * mode (equirect stitch vs. 4 cardinal multi-image), then re-Marbles into a patch
 * world that gets placed/anchored back in the scene. Prior capture sets can be
 * reloaded from disk (via GET /__cube-captures) with `reopenCapture` to revisit and
 * inpaint additional faces.
 */
export type CubeCapturePhase =
  | 'idle'
  | 'capturing'
  | 'picking'
  | 'masking'
  | 'inpainting'
  | 'reviewing'
  | 'mode-picking'
  | 'stitching'
  | 'marbling'
  | 'placing'

/** The six cube-camera face keys (+X,-X,+Y,-Y,+Z,-Z). */
export type CubeFaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'

/** Local URL (or data URL) per cube face. */
export type CubeFaceUrls = Record<CubeFaceKey, string>

/** Marble input conditioning mode chosen per capture. */
export type MarbleInputMode = 'equirect' | 'multi-image'

/** The four cardinal faces keyed by azimuth for the multi-image Marble path. */
export type MultiImageUrls = Record<'az0' | 'az90' | 'az180' | 'az270', string>

/** A completed inpaint result for a single face. */
export interface InpaintedFace {
  maskDataUrl: string
  inpaintedUrl: string
}

/** An inpaint result awaiting user review (accept/discard/remask). */
export interface PendingInpaint {
  face: CubeFaceKey
  maskDataUrl: string
  inpaintedUrl: string
}

interface CubeCaptureState {
  phase: CubeCapturePhase
  captureIndex: number | null
  capturePosition: Vec3Tuple | null
  cubeFaceUrls: CubeFaceUrls | null
  selectedFace: CubeFaceKey | null
  maskDataUrl: string | null
  /** Completed inpaint results, keyed by the face they replace. */
  inpaintedFaces: Partial<Record<CubeFaceKey, InpaintedFace>>
  /** The not-yet-accepted inpaint result currently under review, if any. */
  pendingInpaint: PendingInpaint | null
  marbleInputMode: MarbleInputMode | null
  equirectUrl: string | null
  multiImageUrls: MultiImageUrls | null
  pendingWorldIndex: number | null
  /** When set, a Canvas-side watcher snaps the viewer camera here, then clears it. */
  cameraSnapTarget: Vec3Tuple | null
}

interface CubeCaptureActions {
  setPhase: (phase: CubeCapturePhase) => void
  /** Records a completed cube capture (server-allocated index + per-face URLs) and advances to face picking. */
  setCaptureResult: (index: number, faceUrls: CubeFaceUrls) => void
  /** Selects the bad face to inpaint and advances to masking. */
  selectFace: (face: CubeFaceKey) => void
  setMask: (maskDataUrl: string | null) => void
  /** Records a completed inpaint for one face, clears the in-progress face/mask, and returns to the picker for another face. */
  recordInpainted: (face: CubeFaceKey, maskDataUrl: string, inpaintedUrl: string) => void
  /** Stages a fresh inpaint result for review (accept/discard/remask) without recording it yet. */
  reviewInpaint: (face: CubeFaceKey, maskDataUrl: string, inpaintedUrl: string) => void
  /** Accepts the pending inpaint: records it into inpaintedFaces, clears review/in-progress state, returns to the picker. */
  acceptInpaint: () => void
  /** Discards the pending inpaint without recording and returns to the picker. */
  discardInpaint: () => void
  /** Discards the pending inpaint and returns to masking to re-edit the same face's mask. */
  remaskInpaint: () => void
  /** Advances to Marble mode picking once at least one face has been inpainted. */
  proceedToMarble: () => void
  /** Reloads a prior capture set (from disk) back into the store and returns to the picker. */
  reopenCapture: (
    index: number,
    position: Vec3Tuple | null,
    faceUrls: CubeFaceUrls,
    inpaintedFaces: Partial<Record<CubeFaceKey, { maskDataUrl?: string; inpaintedUrl: string }>>,
  ) => void
  setMode: (mode: MarbleInputMode | null) => void
  setEquirect: (equirectUrl: string | null) => void
  setMultiImage: (multiImageUrls: MultiImageUrls | null) => void
  setPendingWorldIndex: (pendingWorldIndex: number | null) => void
  /** Requests the Canvas-side watcher snap the viewer camera to the given position. */
  setCameraSnapTarget: (pos: Vec3Tuple | null) => void
  /** Clears the pending camera-snap request (called by the watcher once it has moved). */
  clearCameraSnapTarget: () => void
  /** Convenience: clear prior capture state and start a fresh capture at the given position. */
  beginCapture: (position: Vec3Tuple) => void
  /** Return to idle and clear everything. */
  reset: () => void
}

export type CubeCaptureStore = CubeCaptureState & CubeCaptureActions

const initialState: CubeCaptureState = {
  phase: 'idle',
  captureIndex: null,
  capturePosition: null,
  cubeFaceUrls: null,
  selectedFace: null,
  maskDataUrl: null,
  inpaintedFaces: {},
  pendingInpaint: null,
  marbleInputMode: null,
  equirectUrl: null,
  multiImageUrls: null,
  pendingWorldIndex: null,
  cameraSnapTarget: null,
}

export const useCubeCapture = create<CubeCaptureStore>((set, get) => ({
  ...initialState,
  setPhase: (phase) => set({ phase }),
  setCaptureResult: (index, faceUrls) =>
    set({ captureIndex: index, cubeFaceUrls: faceUrls, inpaintedFaces: {}, pendingInpaint: null, phase: 'picking' }),
  selectFace: (face) => set({ selectedFace: face, phase: 'masking' }),
  setMask: (maskDataUrl) => set({ maskDataUrl }),
  recordInpainted: (face, maskDataUrl, inpaintedUrl) =>
    set((s) => ({
      inpaintedFaces: { ...s.inpaintedFaces, [face]: { maskDataUrl, inpaintedUrl } },
      selectedFace: null,
      maskDataUrl: null,
      phase: 'picking',
    })),
  reviewInpaint: (face, maskDataUrl, inpaintedUrl) =>
    set({ pendingInpaint: { face, maskDataUrl, inpaintedUrl }, phase: 'reviewing' }),
  acceptInpaint: () => {
    const pending = get().pendingInpaint
    if (!pending) return
    get().recordInpainted(pending.face, pending.maskDataUrl, pending.inpaintedUrl)
    set({ pendingInpaint: null })
  },
  discardInpaint: () => set({ pendingInpaint: null, phase: 'picking' }),
  remaskInpaint: () => set({ pendingInpaint: null, phase: 'masking' }),
  proceedToMarble: () => set({ phase: 'mode-picking' }),
  reopenCapture: (index, position, faceUrls, inpaintedFaces) =>
    set({
      ...initialState,
      captureIndex: index,
      capturePosition: position,
      cubeFaceUrls: faceUrls,
      inpaintedFaces: Object.fromEntries(
        Object.entries(inpaintedFaces).map(([face, entry]) => [
          face,
          { maskDataUrl: entry?.maskDataUrl ?? '', inpaintedUrl: entry!.inpaintedUrl },
        ]),
      ) as Partial<Record<CubeFaceKey, InpaintedFace>>,
      phase: 'picking',
    }),
  setMode: (marbleInputMode) => set({ marbleInputMode }),
  setEquirect: (equirectUrl) => set({ equirectUrl }),
  setMultiImage: (multiImageUrls) => set({ multiImageUrls }),
  setPendingWorldIndex: (pendingWorldIndex) => set({ pendingWorldIndex }),
  setCameraSnapTarget: (pos) => set({ cameraSnapTarget: pos }),
  clearCameraSnapTarget: () => set({ cameraSnapTarget: null }),
  beginCapture: (position) =>
    set({ ...initialState, phase: 'capturing', capturePosition: position }),
  reset: () => set({ ...initialState }),
}))

// Selectors — read individual slices without re-rendering on unrelated changes.
export const selectPhase = (s: CubeCaptureStore) => s.phase
export const selectCaptureIndex = (s: CubeCaptureStore) => s.captureIndex
export const selectCapturePosition = (s: CubeCaptureStore) => s.capturePosition
export const selectCubeFaceUrls = (s: CubeCaptureStore) => s.cubeFaceUrls
export const selectSelectedFace = (s: CubeCaptureStore) => s.selectedFace
export const selectMaskDataUrl = (s: CubeCaptureStore) => s.maskDataUrl
export const selectInpaintedFaces = (s: CubeCaptureStore) => s.inpaintedFaces
export const selectPendingInpaint = (s: CubeCaptureStore) => s.pendingInpaint
export const selectMarbleInputMode = (s: CubeCaptureStore) => s.marbleInputMode
export const selectEquirectUrl = (s: CubeCaptureStore) => s.equirectUrl
export const selectMultiImageUrls = (s: CubeCaptureStore) => s.multiImageUrls
export const selectPendingWorldIndex = (s: CubeCaptureStore) => s.pendingWorldIndex
export const selectCameraSnapTarget = (s: CubeCaptureStore) => s.cameraSnapTarget

/** Imperative snapshot for use outside React (e.g. R3F render loops, event handlers). */
export const getCubeCaptureState = (): CubeCaptureStore => useCubeCapture.getState()
