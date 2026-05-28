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

interface CubeCaptureState {
  phase: CubeCapturePhase
  captureIndex: number | null
  capturePosition: Vec3Tuple | null
  cubeFaceUrls: CubeFaceUrls | null
  selectedFace: CubeFaceKey | null
  maskDataUrl: string | null
  /** Completed inpaint results, keyed by the face they replace. */
  inpaintedFaces: Partial<Record<CubeFaceKey, InpaintedFace>>
  marbleInputMode: MarbleInputMode | null
  equirectUrl: string | null
  multiImageUrls: MultiImageUrls | null
  pendingWorldIndex: number | null
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
  marbleInputMode: null,
  equirectUrl: null,
  multiImageUrls: null,
  pendingWorldIndex: null,
}

export const useCubeCapture = create<CubeCaptureStore>((set) => ({
  ...initialState,
  setPhase: (phase) => set({ phase }),
  setCaptureResult: (index, faceUrls) =>
    set({ captureIndex: index, cubeFaceUrls: faceUrls, inpaintedFaces: {}, phase: 'picking' }),
  selectFace: (face) => set({ selectedFace: face, phase: 'masking' }),
  setMask: (maskDataUrl) => set({ maskDataUrl }),
  recordInpainted: (face, maskDataUrl, inpaintedUrl) =>
    set((s) => ({
      inpaintedFaces: { ...s.inpaintedFaces, [face]: { maskDataUrl, inpaintedUrl } },
      selectedFace: null,
      maskDataUrl: null,
      phase: 'picking',
    })),
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
export const selectMarbleInputMode = (s: CubeCaptureStore) => s.marbleInputMode
export const selectEquirectUrl = (s: CubeCaptureStore) => s.equirectUrl
export const selectMultiImageUrls = (s: CubeCaptureStore) => s.multiImageUrls
export const selectPendingWorldIndex = (s: CubeCaptureStore) => s.pendingWorldIndex

/** Imperative snapshot for use outside React (e.g. R3F render loops, event handlers). */
export const getCubeCaptureState = (): CubeCaptureStore => useCubeCapture.getState()
