import * as THREE from 'three'

/**
 * CubeToEquirect — pure browser GPU util.
 *
 * Stitches 6 cube-face images into a single 2:1 equirectangular panorama PNG
 * (default 4096x2048). This is the "equirect" Marble input path: 5 original
 * cube faces + 1 inpainted face → one panoramic image fed back to Marble with
 * `is_pano: true`.
 *
 * ── Axis / face convention (MUST match the capture side) ─────────────────────
 * Faces follow the standard WebGL cubemap layout, the same order a
 * `THREE.CubeCamera` writes into a `WebGLCubeRenderTarget`:
 *
 *     px = +X   nx = -X   py = +Y   ny = -Y   pz = +Z   nz = -Z
 *
 * The fragment shader maps each output texel (u,v) ∈ [0,1]² to a spherical
 * direction and samples the cubemap with that direction:
 *
 *     longitude θ = (u - 0.5) · 2π      // θ=0 faces +Z, +90° faces +X
 *     latitude  φ = (0.5 - v) · π       // +φ is up (+Y), top row v=0 → +Y pole
 *     dir = ( cosφ·sinθ,  sinφ,  cosφ·cosθ )
 *
 * So θ sweeps +Z → +X → -Z → -X → +Z left-to-right and the image is right-side
 * up. This is the convention three.js' own `samplerCube` uses (textureCube does
 * the per-axis face selection / sign flips internally — we just hand it the
 * world-space direction), and it matches a CubeCamera placed at the capture
 * point looking down -Z by default. CubeCaptureController must label its faces
 * with these same keys for the panorama to align.
 *
 * Note: cube *texture* sampling in WebGL is left-handed, so three.js negates the
 * X axis of the lookup internally for a CubeTexture built from images. Building
 * the CubeTexture from CubeCamera-rendered faces (this util's intended input)
 * round-trips correctly because both sides use the same layout.
 */

export interface CubeFaceUrls {
  px: string
  nx: string
  py: string
  ny: string
  pz: string
  nz: string
}

export interface CubeToEquirectOptions {
  /** Output width in px. Height is always width / 2. Default 4096. */
  width?: number
}

// Standard WebGL cubemap face order expected by THREE.CubeTexture.images:
//   [ +X, -X, +Y, -Y, +Z, -Z ]
const FACE_ORDER: (keyof CubeFaceUrls)[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform samplerCube cubeMap;
  varying vec2 vUv;

  const float PI = 3.141592653589793;

  void main() {
    // uv (0..1)^2 -> spherical. v=0 is the top row -> north pole (+Y).
    float theta = (vUv.x - 0.5) * 2.0 * PI;   // longitude
    float phi   = (0.5 - vUv.y) * PI;          // latitude, +phi up

    float cosPhi = cos(phi);
    vec3 dir = vec3(
      cosPhi * sin(theta),  // +X to the right
      sin(phi),             // +Y up
      cosPhi * cos(theta)   // +Z forward (theta = 0)
    );

    gl_FragColor = textureCube(cubeMap, dir);
  }
`

/** Loads a single image URL (data URL or http(s)/relative) into an ImageBitmap. */
async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`CubeToEquirect: failed to fetch face image (${response.status}) ${url}`)
  }
  const blob = await response.blob()
  return createImageBitmap(blob)
}

/**
 * Convert 6 cube-face images into a single equirectangular panorama PNG.
 *
 * @param faces  Per-face image URLs (data URLs or `/worlds/...` URLs).
 * @param options.width  Output width; height is width/2. Default 4096 (→ 4096x2048).
 * @returns PNG-encoded Blob of the equirectangular panorama.
 */
export async function cubeToEquirect(
  faces: CubeFaceUrls,
  options: CubeToEquirectOptions = {},
): Promise<Blob> {
  const width = Math.max(2, Math.floor(options.width ?? 4096))
  const height = Math.floor(width / 2)

  // 1. Load the 6 faces into a CubeTexture (sRGB source images).
  const bitmaps = await Promise.all(FACE_ORDER.map((key) => loadImageBitmap(faces[key])))

  const cubeTexture = new THREE.CubeTexture(bitmaps as unknown as HTMLImageElement[])
  cubeTexture.colorSpace = THREE.SRGBColorSpace
  cubeTexture.needsUpdate = true

  // 2. Offscreen renderer. preserveDrawingBuffer keeps readback deterministic.
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
  renderer.setSize(width, height, false)

  // 3. Render target receives the equirect projection (sRGB output).
  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
  renderTarget.texture.colorSpace = THREE.SRGBColorSpace

  // 4. Fullscreen quad in clip space + identity camera.
  const scene = new THREE.Scene()
  const camera = new THREE.Camera()
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.ShaderMaterial({
    uniforms: { cubeMap: { value: cubeTexture } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(geometry, material)
  scene.add(quad)

  try {
    // 5. Render the projection into the target.
    renderer.setRenderTarget(renderTarget)
    renderer.render(scene, camera)

    // 6. Read pixels (RGBA, bottom-up from GL) and flip Y into a top-down canvas.
    const rawPixels = new Uint8Array(width * height * 4)
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, rawPixels)

    // Back the buffer with a concrete ArrayBuffer so the type is
    // Uint8ClampedArray<ArrayBuffer> (ImageData rejects SharedArrayBuffer-backed views).
    const flipped = new Uint8ClampedArray(new ArrayBuffer(width * height * 4))
    const rowBytes = width * 4
    for (let y = 0; y < height; y++) {
      const srcStart = (height - 1 - y) * rowBytes
      const dstStart = y * rowBytes
      flipped.set(rawPixels.subarray(srcStart, srcStart + rowBytes), dstStart)
    }

    return await encodePng(flipped, width, height)
  } finally {
    // 7. Dispose GL resources.
    geometry.dispose()
    material.dispose()
    cubeTexture.dispose()
    renderTarget.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    bitmaps.forEach((bitmap) => bitmap.close())
  }
}

/** Encode raw RGBA pixels to a PNG blob via a 2D canvas. */
async function encodePng(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Blob> {
  const imageData = new ImageData(pixels, width, height)

  // Prefer OffscreenCanvas (worker-safe, no DOM); fall back to a detached <canvas>.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('CubeToEquirect: failed to acquire 2D context (OffscreenCanvas)')
    ctx.putImageData(imageData, 0, 0)
    return canvas.convertToBlob({ type: 'image/png' })
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('CubeToEquirect: failed to acquire 2D context (canvas)')
  ctx.putImageData(imageData, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('CubeToEquirect: canvas.toBlob returned null'))
    }, 'image/png')
  })
}
