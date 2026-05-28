import { create } from 'zustand'
import type { Vec3Tuple } from '../../types/world'

/**
 * Cube-capture feature state machine.
 *
 * Flow (see plan "capture path"): the user walks the splat, captures a cube at
 * their current position, picks the single bad face, paints a mask, inpaints it,
 * chooses a Marble input mode (equirect stitch vs. 4 cardinal multi-image), then
 * re-Marbles into a patch world that gets placed/anchored back in the scene.
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

interface CubeCaptureState {
  phase: CubeCapturePhase
  captureIndex: number | null
  capturePosition: Vec3Tuple | null
  cubeFaceUrls: CubeFaceUrls | null
  selectedFace: CubeFaceKey | null
  maskDataUrl: string | null
  inpaintedUrl: string | null
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
  setInpainted: (inpaintedUrl: string | null) => void
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
  inpaintedUrl: null,
  marbleInputMode: null,
  equirectUrl: null,
  multiImageUrls: null,
  pendingWorldIndex: null,
}

export const useCubeCapture = create<CubeCaptureStore>((set) => ({
  ...initialState,
  setPhase: (phase) => set({ phase }),
  setCaptureResult: (index, faceUrls) =>
    set({ captureIndex: index, cubeFaceUrls: faceUrls, phase: 'picking' }),
  selectFace: (face) => set({ selectedFace: face, phase: 'masking' }),
  setMask: (maskDataUrl) => set({ maskDataUrl }),
  setInpainted: (inpaintedUrl) => set({ inpaintedUrl }),
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
export const selectInpaintedUrl = (s: CubeCaptureStore) => s.inpaintedUrl
export const selectMarbleInputMode = (s: CubeCaptureStore) => s.marbleInputMode
export const selectEquirectUrl = (s: CubeCaptureStore) => s.equirectUrl
export const selectMultiImageUrls = (s: CubeCaptureStore) => s.multiImageUrls
export const selectPendingWorldIndex = (s: CubeCaptureStore) => s.pendingWorldIndex

/** Imperative snapshot for use outside React (e.g. R3F render loops, event handlers). */
export const getCubeCaptureState = (): CubeCaptureStore => useCubeCapture.getState()
