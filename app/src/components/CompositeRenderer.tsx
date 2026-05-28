import { useMemo, useRef, useEffect, type MutableRefObject } from 'react'
import { extend, useThree, useFrame } from '@react-three/fiber'
import {
  SplatMesh,
  SparkRenderer,
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  SplatEditRgbaBlendMode,
} from '@sparkjsdev/spark'
import * as THREE from 'three'
import { useDebugStore } from '../store/debug'
import {
  ViewerQuality,
  type World,
  type WorldSceneProject,
  type WorldCompositionLayer,
  type EraserRegion,
  type EraserSdfType,
} from '../types/world'
import { SplatRenderer } from '../modules/splat/SplatRenderer'

// ---------------------------------------------------------------------------
// Shared shader-patch constants (kept byte-identical to SplatRenderer so the
// inline primary layer behaves the same as the legacy single-splat mount).
// ---------------------------------------------------------------------------
const ORIGINAL_FOCUS_BLUR =
  'float focusBlur = abs((-viewCenter.z - focalDistance) / viewCenter.z);'
const CUSTOM_FOCUS_BLUR = `float dist = -viewCenter.z;
            float diff = abs(dist - focalDistance);
            float beyond = max(0.0, diff - sharpRange);
            float focusBlur = exp(beyond * falloffRate) - 1.0;`
const APERTURE_DECL = 'uniform float apertureAngle;'
const APERTURE_DECL_PLUS = `uniform float apertureAngle;
uniform float sharpRange;
uniform float falloffRate;`
const DEFAULT_SHARP_RANGE = 2
const DEFAULT_FALLOFF_RATE = 0.3

const SparkRendererEl = extend(SparkRenderer)
const SplatMeshEl = extend(SplatMesh)
const ignoreRaycast: THREE.Object3D['raycast'] = () => {}

// Spark's SplatEditSdfType is a superset of our EraserSdfType. Map the four
// shapes we expose to their spark enum value; default to SPHERE.
const SDF_TYPE_MAP: Record<EraserSdfType, SplatEditSdfType> = {
  sphere: SplatEditSdfType.SPHERE,
  box: SplatEditSdfType.BOX,
  ellipsoid: SplatEditSdfType.ELLIPSOID,
  capsule: SplatEditSdfType.CAPSULE,
}

// Build a single SplatEdit (MULTIPLY, opacity 0 => erase) carrying one SDF per
// eraser region. Returns the edit plus the SDF handles so callers can mutate
// position/scale/radius at runtime without rebuilding.
function buildEraserEdit(regions: EraserRegion[]): {
  edit: SplatEdit
  sdfs: SplatEditSdf[]
} {
  // softEdge is a per-edit property in spark; take the max requested across
  // this primary's eraser set (a reasonable single value for the shared edit).
  const softEdge = regions.reduce(
    (m, r) => Math.max(m, r.softEdge ?? 0),
    0,
  )
  const edit = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
    softEdge,
  })
  const sdfs: SplatEditSdf[] = []
  for (const region of regions) {
    const sdf = new SplatEditSdf({
      type: SDF_TYPE_MAP[region.type] ?? SplatEditSdfType.SPHERE,
      // opacity 0 => fully erase the splats the SDF selects.
      opacity: 0,
      // invert=false erases inside the SDF (the default eraser behaviour).
      invert: region.invert ?? false,
      radius: 1,
    })
    applyRegionTransform(sdf, region)
    edit.addSdf(sdf)
    sdfs.push(sdf)
  }
  return { edit, sdfs }
}

// SplatEditSdf is an Object3D — drive its transform directly so non-uniform
// region scales (ellipsoid/box extents) are honoured. `radius` stays 1 and the
// node scale carries the size.
function applyRegionTransform(sdf: SplatEditSdf, region: EraserRegion) {
  sdf.position.set(region.position[0], region.position[1], region.position[2])
  sdf.rotation.set(region.rotation[0], region.rotation[1], region.rotation[2])
  sdf.scale.set(region.scale[0], region.scale[1], region.scale[2])
  sdf.invert = region.invert ?? false
  sdf.updateMatrixWorld(true)
}

// ---------------------------------------------------------------------------
// Inline primary layer: replicates SplatRenderer's SparkRenderer + SplatMesh
// mount so we can grab the SplatMesh ref and assign `.edits` (which is the
// per-mesh erase scope confirmed by the spike).
// ---------------------------------------------------------------------------
interface PrimaryLayerProps {
  url: string
  visible: boolean
  groundPlaneOffset: number
  flipY: boolean
  metricScaleFactor: number
  erasers: EraserRegion[]
  /** Receives the primary layer's live SparkRenderer (for cube capture). */
  sparkRendererRef?: MutableRefObject<SparkRenderer | null>
}

function PrimaryLayer({
  url,
  visible,
  groundPlaneOffset,
  flipY,
  metricScaleFactor,
  erasers,
  sparkRendererRef,
}: PrimaryLayerProps) {
  const renderer = useThree((state) => state.gl)
  const viewerQuality = useDebugStore((s) => s.viewerQuality)
  const splatRef = useRef<SplatMesh>(null)
  const sparkRef = useRef<SparkRenderer>(null)
  const encodeLinear = viewerQuality === ViewerQuality.High
  const initialEncodeLinear = useRef(encodeLinear)

  // Forward this layer's SparkRenderer up to the caller so CubeCaptureController
  // can render the splat scene into a cube. Cleared on unmount.
  useEffect(() => {
    if (!sparkRendererRef) return
    sparkRendererRef.current = sparkRef.current
    return () => {
      if (sparkRendererRef.current === sparkRef.current) sparkRendererRef.current = null
    }
  }, [sparkRendererRef])

  // Custom CoC curve patch (identical to SplatRenderer).
  useEffect(() => {
    const spark = sparkRef.current
    if (!spark) return
    const mat = spark.material
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = mat.uniforms as any
    if (!u.sharpRange) u.sharpRange = { value: DEFAULT_SHARP_RANGE }
    if (!u.falloffRate) u.falloffRate = { value: DEFAULT_FALLOFF_RATE }
    if (!mat.vertexShader.includes('uniform float sharpRange;')) {
      mat.vertexShader = mat.vertexShader
        .replace(APERTURE_DECL, APERTURE_DECL_PLUS)
        .replace(ORIGINAL_FOCUS_BLUR, CUSTOM_FOCUS_BLUR)
      mat.needsUpdate = true
    }
  }, [])

  useFrame(() => {
    const spark = sparkRef.current
    if (!spark) return
    const s = useDebugStore.getState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = spark.material.uniforms as any
    if (s.viewerQuality === ViewerQuality.High && s.dofEnabled) {
      spark.focalDistance = s.focalDistance
      spark.apertureAngle = s.apertureAngle
      spark.falloff = s.falloff
      if (u.sharpRange) u.sharpRange.value = Number.isFinite(s.sharpRange) ? s.sharpRange : DEFAULT_SHARP_RANGE
      if (u.falloffRate) u.falloffRate.value = s.falloffRate > 0 ? s.falloffRate : DEFAULT_FALLOFF_RATE
    } else {
      spark.focalDistance = 0
      spark.apertureAngle = 0
      spark.falloff = 1
    }
  })

  useEffect(() => {
    if (splatRef.current) splatRef.current.raycast = ignoreRaycast
    if (sparkRef.current) sparkRef.current.raycast = ignoreRaycast
  }, [])

  useEffect(() => {
    if (sparkRef.current) sparkRef.current.encodeLinear = encodeLinear
  }, [encodeLinear])

  // Build + assign the eraser edits to THIS mesh only. Per-mesh `.edits` scopes
  // the carve to the primary splat — patch splats keep `.edits = null`.
  const eraserKey = useMemo(() => JSON.stringify(erasers), [erasers])
  useEffect(() => {
    const mesh = splatRef.current
    if (!mesh) return
    if (!erasers.length) {
      mesh.edits = null
      return
    }
    const { edit } = buildEraserEdit(erasers)
    mesh.edits = [edit]
    return () => {
      // Detach on unmount / eraser-set change so stale edits don't linger.
      if (splatRef.current) splatRef.current.edits = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eraserKey])

  const sparkArgs = useMemo(
    () => ({ renderer, enableLod: true, encodeLinear: initialEncodeLinear.current }),
    [renderer],
  )
  const splatArgs = useMemo(() => ({ url }), [url])

  return (
    <SparkRendererEl ref={sparkRef} args={[sparkArgs]} visible={visible}>
      <group position={[0, groundPlaneOffset, 0]} rotation={[flipY ? Math.PI : 0, 0, 0]} scale={metricScaleFactor}>
        <SplatMeshEl ref={splatRef} args={[splatArgs]} />
      </group>
    </SparkRendererEl>
  )
}

// ---------------------------------------------------------------------------
// Public component.
// ---------------------------------------------------------------------------
export interface CompositeRendererProps {
  /** Scene project; if `.worlds` is present we composite multiple layers. */
  project?: WorldSceneProject
  /** The index-0 world (legacy single-splat fallback source). */
  primaryWorld?: World
  /** Resolved splat URL for the primary layer (from getSplatUrl). */
  primarySplatUrl: string
  visible: boolean
  groundPlaneOffset: number
  metricScaleFactor: number
  flipY: boolean
  /** Resolve a patch layer's splat URL by its worldIndex. */
  resolveLayerSplatUrl?: (worldIndex: number) => string | undefined
  /**
   * Optional ref that receives the primary layer's live SparkRenderer instance.
   * Used by CubeCaptureController to render the splat scene into a cube. When
   * provided, even the legacy single-splat path mounts through PrimaryLayer so
   * the ref is populated (still byte-identical render output to SplatRenderer).
   */
  sparkRendererRef?: MutableRefObject<SparkRenderer | null>
}

export function CompositeRenderer({
  project,
  primarySplatUrl,
  visible,
  groundPlaneOffset,
  metricScaleFactor,
  flipY,
  resolveLayerSplatUrl,
  sparkRendererRef,
}: CompositeRendererProps) {
  const layers = project?.worlds

  // ---- Legacy fallback: single splat, no compositing. ----
  if (!layers || layers.length === 0) {
    // When a sparkRendererRef is requested we route through PrimaryLayer (an
    // exact replica of SplatRenderer) so the ref is populated for cube capture.
    // Otherwise stay on the plain SplatRenderer mount.
    if (sparkRendererRef) {
      return (
        <PrimaryLayer
          url={primarySplatUrl}
          visible={visible}
          groundPlaneOffset={groundPlaneOffset}
          flipY={flipY}
          metricScaleFactor={metricScaleFactor}
          erasers={[]}
          sparkRendererRef={sparkRendererRef}
        />
      )
    }
    return (
      <SplatRenderer
        url={primarySplatUrl}
        visible={visible}
        groundPlaneOffset={groundPlaneOffset}
        flipY={flipY}
        metricScaleFactor={metricScaleFactor}
      />
    )
  }

  // ---- Multi-layer composite. ----
  const primaryLayer =
    layers.find((l) => l.role === 'primary') ?? layers[0]
  const patchLayers = layers.filter((l) => l !== primaryLayer)

  // Collect every patch layer's erasers-on-primary into one set; they all carve
  // the single primary splat mesh.
  const primaryErasers: EraserRegion[] = patchLayers.flatMap(
    (l) => l.erasersOnPrimary ?? [],
  )

  return (
    <>
      <PrimaryLayer
        url={primarySplatUrl}
        visible={visible}
        groundPlaneOffset={groundPlaneOffset}
        flipY={flipY}
        metricScaleFactor={metricScaleFactor}
        erasers={primaryErasers}
        sparkRendererRef={sparkRendererRef}
      />
      {patchLayers.map((layer) => (
        <PatchLayer
          key={layer.id}
          layer={layer}
          visible={visible}
          groundPlaneOffset={groundPlaneOffset}
          flipY={flipY}
          metricScaleFactor={metricScaleFactor}
          resolveLayerSplatUrl={resolveLayerSplatUrl}
        />
      ))}
    </>
  )
}

// Patch layer: a SplatRenderer anchored at the layer's transform. No edits —
// only the primary is carved. The anchor's uniform scale multiplies the shared
// metric scale factor.
interface PatchLayerProps {
  layer: WorldCompositionLayer
  visible: boolean
  groundPlaneOffset: number
  flipY: boolean
  metricScaleFactor: number
  resolveLayerSplatUrl?: (worldIndex: number) => string | undefined
}

function PatchLayer({
  layer,
  visible,
  groundPlaneOffset,
  flipY,
  metricScaleFactor,
  resolveLayerSplatUrl,
}: PatchLayerProps) {
  const url = resolveLayerSplatUrl?.(layer.worldIndex)
  if (!url) return null

  const { position, rotation, scale } = layer.anchor
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <SplatRenderer
        url={url}
        visible={visible}
        groundPlaneOffset={groundPlaneOffset}
        flipY={flipY}
        metricScaleFactor={metricScaleFactor}
      />
    </group>
  )
}
