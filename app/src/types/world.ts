export interface WorldAssets {
  mesh: { collider_mesh_url: string }
  imagery: { pano_url: string }
  splats: {
    spz_urls: {
      '500k'?: string
      '100k'?: string
      '150k'?: string
      full_res?: string
    }
    semantics_metadata: {
      metric_scale_factor: number
      ground_plane_offset: number
      flip_y?: boolean
    }
  }
  thumbnail_url: string
  caption: string
}

export interface World {
  world_id: string
  display_name: string
  assets: WorldAssets
  world_marble_url: string
  tags: string[] | null
  world_prompt: string | null
  created_at: string | null
  updated_at: string | null
}

export interface WorldProject {
  slug: string
  display_name?: string
  created_at?: string
  updated_at?: string
  notes?: string
}

export interface WorldObjectAsset {
  id: string
  assetId: string
  sourceWorldSlug: string
  baseObjectId: string
  index?: number
  variantLabel?: string
  fileName?: string
  name: string
  url: string
  referenceImageUrl?: string
  thumbnailUrl?: string
  sfxUrls: string[]
  complete: boolean
  status?: string
}

export type Vec3Tuple = [number, number, number]
export type WorldObjectPhysics = 'rigidbody' | 'static' | 'ghost'

export interface WorldObjectPlacement {
  instanceId: string
  objectId: string
  assetId?: string
  physics?: WorldObjectPhysics
  position: Vec3Tuple
  rotation: Vec3Tuple
  scale: Vec3Tuple
}

export interface WorldSceneSun {
  intensity: number
  rotation: Vec3Tuple
  environmentIntensity?: number
}

export type EraserSdfType = 'sphere' | 'box' | 'ellipsoid' | 'capsule'

export interface EraserRegion {
  id: string
  type: EraserSdfType
  position: Vec3Tuple
  rotation: Vec3Tuple
  scale: Vec3Tuple
  softEdge?: number   // 0..1, defaults 0
  invert?: boolean    // defaults false (erase inside)
}

export interface CubeCaptureMeta {
  capturePosition: Vec3Tuple        // in scene meters
  faceSize: number                  // px, default 1024
  faceIndex: 0 | 1 | 2 | 3 | 4 | 5  // +X,-X,+Y,-Y,+Z,-Z
  facePngPath: string               // worlds/<slug>/...
  maskPngPath: string
  inpaintedFacePath: string
  inpaintModel: 'fal-ai/flux-pro/v1/fill'
  marbleSeed: number                // shared with World A
  marbleInputMode: 'equirect' | 'multi-image'
  // exactly one of these is populated based on mode:
  equirectPath?: string             // stitched 4096x2048 (equirect mode)
  multiImagePaths?: {               // 4 cardinal faces (multi-image mode)
    az0: string                     // +Z face
    az90: string                    // +X face
    az180: string                   // -Z face
    az270: string                   // -X face
  }
}

export interface WorldCompositionLayer {
  id: string
  role: 'primary' | 'patch'
  worldSlug: string
  worldIndex: number                // which N-world.json
  anchor: {
    position: Vec3Tuple             // patch layer's origin in primary's frame
    rotation: Vec3Tuple
    scale: number                   // uniform; multiplies layer's own metricScaleFactor
  }
  erasersOnPrimary?: EraserRegion[] // only meaningful on patch layers
  capture?: CubeCaptureMeta         // provenance, present on patch layers
}

export interface WorldSceneProject {
  version: 1
  instances: WorldObjectPlacement[]
  sun?: WorldSceneSun
  metricScaleFactor?: number
  groundPlaneOffset?: number
  groundPlaneColliderEnabled?: boolean
  shadowCatcherOpacity?: number
  shadowCatcherColor?: string
  worlds?: WorldCompositionLayer[]  // NEW — absence = single-splat legacy
}

export interface WorldVersion {
  index: number
  label: string
  world?: World
  plateImageUrl?: string
  complete: boolean
  status?: string
}

export interface SourceImageVersion {
  url: string
  label: string
  fileName: string
  index?: number
}

export interface WorldHoverPreview {
  slug: string
  imageUrl?: string
  alt: string
}

export interface WorldEntry {
  slug: string
  project: WorldProject
  world?: World
  worldVersions: WorldVersion[]
  objectAssets: WorldObjectAsset[]
  allObjectAssets: WorldObjectAsset[]
  sourceImageUrl?: string
  sourceImageVersions: SourceImageVersion[]
  worldSfxUrls: string[]
  sceneProject?: WorldSceneProject
}

export enum WorldRenderMode {
  SplatOnly = 'splat-only',
  ObjectOnly = 'object-only',
  Combined = 'combined',
}

export enum ObjectRenderMode {
  Lit = 'lit',
  Wireframe = 'wireframe',
  ShadedWireframe = 'shaded-wireframe',
}

export enum ViewerQuality {
  Low = 'low',
  High = 'high',
}
