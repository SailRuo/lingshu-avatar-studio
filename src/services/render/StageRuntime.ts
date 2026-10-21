import 'pixi.js/unsafe-eval'
import {
  Application,
  Container,
  Filter,
  GlProgram,
  Mesh,
  PlaneGeometry,
  Sprite,
  Texture,
} from 'pixi.js'
import type { CharacterManifest, LayerDef } from '../../types/character'
import type { MeshDef, RigDocument } from '../../types/rig'
import type { MouthShape } from '../audio/viseme'
import { loadHtmlImage } from '../imaging/blob'
import { createClosedEyeTexture, createMouthVariantTextures } from './faceVariants'

const HEAD_TURN_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`

const HEAD_TURN_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTurn;
uniform float uCenterX;
uniform float uHalfWidth;
uniform float uNeckY;

void main(void) {
  vec2 uv = vTextureCoord;
  float turn = clamp(uTurn, -1.0, 1.0);
  float halfWidth = max(uHalfWidth, 0.0001);
  // Not clamped: the band weight below needs the real distance from the
  // centre. A clamped coordinate would map every texel outside the head to
  // the edge column and smear it across the frame, which reads as a head
  // that grows much wider as the pointer moves away from the centre.
  float nx = (uv.x - uCenterX) / halfWidth;
  float band = 1.0 - smoothstep(0.9, 1.05, abs(nx));
  float x = clamp(nx, -1.0, 1.0);
  // A head turning away gets narrower, never wider. Compress the whole head
  // slightly and slide the face towards the pointer; stretching one side
  // reads as the head being pulled sideways.
  float squash = 1.0 - 0.1 * abs(turn);
  float warped = x * squash;
  // The face has to travel towards the target, so the sample offset points
  // the other way: a positive offset would show the left part of the face at
  // the centre and drag the head away from the pointer.
  // Only a few pixels of feature parallax: a large slide reads as the whole
  // face being dragged sideways instead of the head turning.
  warped -= turn * 0.05 * (1.0 - x * x);
  // Fade the warp out at the jaw so the neck stays anchored to the body.
  float neckWeight = 1.0 - smoothstep(uNeckY - 0.15, uNeckY, uv.y);
  float xp = mix(nx, warped, band * neckWeight);
  uv.x = uCenterX + xp * halfWidth;
  finalColor = texture(uTexture, uv);
}
`

export interface StageOptions {
  host: HTMLElement
  manifest: CharacterManifest
  rig: RigDocument
  layers: Record<string, Blob>
}

export interface StageHandle {
  setParams(partial: Record<string, number>): void
  setMouthOpen(value: number): void
  /** Drive the mouth from an analysed mouth shape instead of a raw level. */
  setMouthShape(shape: MouthShape): void
  /** Show or hide a single layer. */
  setLayerVisible(layerId: string, visible: boolean): void
  /** Show only this layer; pass null to go back to the per-layer switches. */
  setSoloLayer(layerId: string | null): void
  setExpression(id: string): void
  playMotion(id: string): void
  blink(): void
  stopSpeaking(): void
  resize(): void
  destroy(): void
  on(event: 'fps' | 'error' | 'degraded', cb: (payload: unknown) => void): () => void
}

interface LayerNode {
  def: LayerDef
  sprite: Sprite | null
  mesh: Mesh | null
  basePositions: Float32Array | null
  meshDef: MeshDef | null
  baseX: number
  baseY: number
  isEye: boolean
  isMouth: boolean
  isHair: boolean
}

interface MouthOverlays {
  half: Sprite
  open: Sprite
  smile: Sprite
  round: Sprite
  teeth: Sprite
}

type GestureType = 'nod' | 'shake' | 'tilt'

function smooth(current: number, target: number, tauMs: number, dt: number): number {
  if (tauMs <= 0) return target
  return current + (target - current) * (1 - Math.exp(-(dt * 1000) / tauMs))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function blinkCurve(progress: number): number {
  if (progress <= 0 || progress >= 1) return 0
  if (progress < 0.08) return smoothstep(progress / 0.08)
  if (progress < 0.6) return 1
  return 1 - smoothstep((progress - 0.6) / 0.4)
}

export async function createStageRuntime(options: StageOptions): Promise<StageHandle> {
  const { host, manifest, rig, layers } = options
  // A hot-reloaded component can mount again before the previous Pixi app was
  // torn down. Left alone, both canvases keep ticking and blink independently,
  // which looks like a second head sitting behind the first one.
  const stagedHost = host as HTMLElement & { __avatarStage?: StageHandle }
  stagedHost.__avatarStage?.destroy()
  stagedHost.__avatarStage = undefined
  host.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }

  let app: Application
  try {
    app = new Application()
    await app.init({
      preference: 'webgl',
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: host,
    })
  } catch (webglError) {
    console.warn('[avatar] WebGL init failed, retrying default renderer', webglError)
    app = new Application()
    await app.init({
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: host,
    })
  }
  app.ticker.maxFPS = 60
  const canvas = app.canvas as HTMLCanvasElement
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  host.appendChild(canvas)

  const urls: string[] = []
  const textures: Texture[] = []
  let maskTexture: Texture | null = null
  const maskTextureFor = (): Texture => {
    if (maskTexture) return maskTexture
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 4, 4)
    }
    maskTexture = Texture.from(canvas)
    textures.push(maskTexture)
    return maskTexture
  }
  const images = new Map<string, HTMLImageElement>()
  const root = new Container()
  const bodyGroup = new Container()
  const headGroup = new Container()
  app.stage.addChild(root)

  const bodyNode = rig.nodes.find((node) => node.id === 'body')
  const headNode = rig.nodes.find((node) => node.id === 'head')
  const bodyPivot = bodyNode?.pivot ?? { x: manifest.canvas.width / 2, y: manifest.canvas.height * 0.94 }
  const headPivot = headNode?.pivot ?? { x: manifest.canvas.width / 2, y: manifest.canvas.height * 0.55 }
  const headUnderBody = headNode?.parent === 'body'

  bodyGroup.pivot.set(bodyPivot.x, bodyPivot.y)
  bodyGroup.position.set(bodyPivot.x, bodyPivot.y)
  bodyGroup.sortableChildren = true
  root.addChild(bodyGroup)
  headGroup.pivot.set(headPivot.x, headPivot.y)
  headGroup.position.set(headPivot.x, headPivot.y)
  headGroup.zIndex = 1000
  headGroup.sortableChildren = true
  if (headUnderBody) {
    bodyGroup.addChild(headGroup)
  } else {
    root.addChild(headGroup)
  }

  const layerNodes: LayerNode[] = []
  const bodyLayers: LayerNode[] = []
  const headLayers: LayerNode[] = []
  /**
   * Every layer id maps to the sprites and the animation overlays that
   * belong to it, so a visibility switch hides the whole piece.
   */
  const layerParts = new Map<string, { nodes: LayerNode[]; overlays: Sprite[] }>()
  const layerVisibility = new Map<string, boolean>()
  let soloLayer: string | null = null
  const partOf = (id: string) => {
    let entry = layerParts.get(id)
    if (!entry) {
      entry = { nodes: [], overlays: [] }
      layerParts.set(id, entry)
    }
    return entry
  }
  const eyeOverlays: Array<{ sprite: Sprite; base: Sprite }> = []
  let mouthOverlays: MouthOverlays | null = null

  for (const def of Object.values(manifest.layers)) {
    if (!def) continue
    const blob = layers[def.id]
    if (!blob) {
      emit('degraded', { layer: def.id, reason: 'missing-blob' })
      continue
    }
    const url = URL.createObjectURL(blob)
    urls.push(url)
    let image: HTMLImageElement
    let texture: Texture
    try {
      image = await loadHtmlImage(url)
      images.set(def.id, image)
      texture = Texture.from(image)
      textures.push(texture)
    } catch (err) {
      console.warn('[avatar] layer texture failed', def.id, err)
      emit('degraded', { layer: def.id, reason: 'texture-load-failed' })
      continue
    }

    const isEye = def.id === 'eyeL' || def.id === 'eyeR'
    const isMouth = def.id === 'mouth'
    const isHair = def.id === 'hairFront' || def.id === 'hairBack'
    const meshDef = isHair ? rig.meshes?.[def.id] : undefined
    // Back hair is stored under the body node, but it belongs to the head:
    // keeping it static leaves a fixed copy behind the moving head, and the
    // head layer is cut at the neckline, so the lower hair would disappear.
    const parentToHead = def.parent !== 'body' || def.id === 'hairBack'

    if (isHair && meshDef) {
      try {
        const geometry = new PlaneGeometry({
          width: def.size.w,
          height: def.size.h,
          verticesX: Math.max(2, meshDef.cols),
          verticesY: Math.max(2, meshDef.rows),
        })
        const mesh = new Mesh({ geometry, texture })
        mesh.position.set(def.offset.x, def.offset.y)
        mesh.alpha = def.opacity
        mesh.zIndex = def.z
        const node: LayerNode = {
          def,
          sprite: null,
          mesh,
          basePositions: new Float32Array(geometry.positions),
          meshDef,
          baseX: def.offset.x,
          baseY: def.offset.y,
          isEye: false,
          isMouth: false,
          isHair: true,
        }
        layerNodes.push(node)
        if (parentToHead) {
          headLayers.push(node)
          headGroup.addChild(mesh)
        } else {
          bodyLayers.push(node)
          bodyGroup.addChild(mesh)
        }
        continue
      } catch (err) {
        console.warn('[avatar] hair mesh failed, falling back to sprite', def.id, err)
      }
    }

    const sprite = new Sprite(texture)
    sprite.zIndex = def.z
    sprite.alpha = def.opacity

    let baseX: number
    let baseY: number
    if (isEye || isMouth) {
      const anchorX = clamp((def.pivot.x - def.offset.x) / Math.max(1, def.size.w), 0, 1)
      const anchorY = clamp((def.pivot.y - def.offset.y) / Math.max(1, def.size.h), 0, 1)
      sprite.anchor.set(anchorX, anchorY)
      baseX = def.pivot.x
      baseY = def.pivot.y
    } else {
      sprite.anchor.set(0.5, 0.5)
      baseX = def.offset.x + def.size.w / 2
      baseY = def.offset.y + def.size.h / 2
    }
    sprite.position.set(baseX, baseY)
    const node: LayerNode = {
      def,
      sprite,
      mesh: null,
      basePositions: null,
      meshDef: null,
      baseX,
      baseY,
      isEye,
      isMouth,
      isHair: false,
    }
    layerNodes.push(node)
    partOf(def.id).nodes.push(node)
    if (parentToHead) {
      headLayers.push(node)
      headGroup.addChild(sprite)
    } else {
      bodyLayers.push(node)
      bodyGroup.addChild(sprite)
    }
  }

  // The head layer is baked from the full foreground, so it also carries the
  // neck and shoulders. Cut it at the estimated neckline; otherwise that copy
  // travels with the head and leaves a ghost over the static body.
  const headLayerNode = layerNodes.find((node) => node.def.id === 'head')
  const eyeYs = [manifest.layers.eyeL?.pivot.y, manifest.layers.eyeR?.pivot.y].filter(
    (y): y is number => typeof y === 'number',
  )
  const eyeLineY = eyeYs.length ? eyeYs.reduce((sum, y) => sum + y, 0) / eyeYs.length : null
  const headPivotY = headNode?.pivot.y
  const mouthPivotY = manifest.layers.mouth?.pivot.y
  // Eye line to mouth is roughly 0.30 of the face height; the mouth-based
  // estimate is much more stable than eye-to-pivot because the pivot itself is
  // defined relative to the chin. Over-estimate slightly so the cuts stay
  // below the chin.
  const faceHeight =
    eyeLineY != null && mouthPivotY != null && mouthPivotY > eyeLineY
      ? (mouthPivotY - eyeLineY) / 0.3
      : eyeLineY != null && headPivotY != null && eyeLineY < headPivotY
        ? (headPivotY - eyeLineY) / 0.72
        : null
  if (faceHeight != null && headPivotY != null) {
    // Keep the head layer down to the neck pivot, but fade its last slice so
    // the moving neck blends into the body instead of ending on a hard line.
    // The hair is painted back on top of the fade: a plain horizontal cut also
    // slices through the hair, which is what produced the rectangular edge.
    const headBottomY = headPivotY
    if (headLayerNode?.sprite) {
      const headDef = headLayerNode.def
      const top = headDef.offset.y
      const bottom = top + headDef.size.h
      const cutY = Math.min(bottom, Math.max(top + 8, headBottomY))
      if (cutY < bottom - 1) {
        const maskCanvas = document.createElement('canvas')
        maskCanvas.width = Math.max(1, Math.round(headDef.size.w))
        maskCanvas.height = Math.max(1, Math.round(headDef.size.h))
        const maskCtx = maskCanvas.getContext('2d')
        if (maskCtx) {
          const chinY = headPivotY - 0.14 * faceHeight
          const chinStop = clamp((chinY - headDef.offset.y) / maskCanvas.height, 0, 0.999)
          const cutStop = clamp((cutY - headDef.offset.y) / maskCanvas.height, chinStop + 0.001, 1)
          const gradient = maskCtx.createLinearGradient(0, 0, 0, maskCanvas.height)
          gradient.addColorStop(0, 'rgba(255,255,255,1)')
          gradient.addColorStop(chinStop, 'rgba(255,255,255,1)')
          gradient.addColorStop(cutStop, 'rgba(255,255,255,0)')
          if (cutStop < 1) gradient.addColorStop(1, 'rgba(255,255,255,0)')
          maskCtx.fillStyle = gradient
          maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
          for (const hairId of ['hairBack', 'hairFront'] as const) {
            const hairDef = manifest.layers[hairId]
            const hairImage = images.get(hairId)
            if (!hairDef || !hairImage) continue
            maskCtx.drawImage(
              hairImage,
              hairDef.offset.x - headDef.offset.x,
              hairDef.offset.y - headDef.offset.y,
              hairDef.size.w,
              hairDef.size.h,
            )
          }
        }
        const maskTexture = Texture.from(maskCanvas)
        textures.push(maskTexture)
        const mask = new Sprite(maskTexture)
        mask.position.set(headDef.offset.x, top)
        mask.width = headDef.size.w
        mask.height = headDef.size.h
        headGroup.addChild(mask)
        headLayerNode.sprite.mask = mask
      }
    }
    // The body bbox is expanded upward into the jaw. Keep only the part below
    // the chin so a static copy of the jaw cannot stay behind the head.
    const bodyLayerNode = layerNodes.find((node) => node.def.id === 'body')
    if (bodyLayerNode?.sprite) {
      const top = bodyLayerNode.def.offset.y
      const bottom = top + bodyLayerNode.def.size.h
      const cutY = Math.min(bottom, Math.max(top, headPivotY - 0.16 * faceHeight))
      if (cutY > top + 1) {
        const mask = new Sprite(maskTextureFor())
        mask.position.set(bodyLayerNode.def.offset.x, cutY)
        mask.width = bodyLayerNode.def.size.w
        mask.height = bottom - cutY
        bodyGroup.addChild(mask)
        bodyLayerNode.sprite.mask = mask
      }
    }
  }

  const headDef = manifest.layers.head
  const headImage = images.get('head')
  if (headDef && headImage) {
    for (const eyeId of ['eyeL', 'eyeR'] as const) {
      const eyeDef = manifest.layers[eyeId]
      const eyeImage = images.get(eyeId)
      const baseNode = layerNodes.find((node) => node.def.id === eyeId)
      if (!eyeDef || !eyeImage || !baseNode?.sprite) continue
      try {
        const variant = createClosedEyeTexture(eyeImage, headImage, eyeDef, headDef)
        if (!variant) continue
        const overlay = new Sprite(variant.texture)
        const baseAnchor = baseNode.sprite.anchor
        const totalW = eyeDef.size.w + variant.pad * 2
        const totalH = eyeDef.size.h + variant.pad * 2
        overlay.anchor.set(
          (variant.pad + baseAnchor.x * eyeDef.size.w) / totalW,
          (variant.pad + baseAnchor.y * eyeDef.size.h) / totalH,
        )
        overlay.position.set(baseNode.baseX, baseNode.baseY)
        overlay.zIndex = eyeDef.z + 0.2
        overlay.alpha = 0
        headGroup.addChild(overlay)
        textures.push(variant.texture)
        eyeOverlays.push({ sprite: overlay, base: baseNode.sprite })
        partOf(eyeId).overlays.push(overlay)
      } catch (err) {
        console.warn('[avatar] closed eye texture failed', eyeId, err)
      }
    }
  }

  const mouthDef = manifest.layers.mouth
  const mouthImage = images.get('mouth')
  if (mouthDef && mouthImage) {
    try {
      const variants = createMouthVariantTextures(mouthImage, mouthDef)
      const baseNode = layerNodes.find((node) => node.def.id === 'mouth')
      if (variants && baseNode?.sprite) {
        const makeOverlay = (texture: Texture, z: number) => {
          const sprite = new Sprite(texture)
          sprite.anchor.set(baseNode.sprite!.anchor.x, baseNode.sprite!.anchor.y)
          sprite.position.set(baseNode.baseX, baseNode.baseY)
          sprite.zIndex = mouthDef.z + z
          sprite.alpha = 0
          headGroup.addChild(sprite)
          textures.push(texture)
          return sprite
        }
        const overlays = {
          half: makeOverlay(variants.half.texture, 0.15),
          open: makeOverlay(variants.open.texture, 0.25),
          round: makeOverlay(variants.round.texture, 0.3),
          teeth: makeOverlay(variants.teeth.texture, 0.32),
          smile: makeOverlay(variants.smile.texture, 0.35),
        }
        mouthOverlays = overlays
        const mouthParts = partOf('mouth')
        for (const overlay of Object.values(overlays)) mouthParts.overlays.push(overlay)
      }
    } catch (err) {
      console.warn('[avatar] mouth variants failed', err)
    }
  }

  let headTurnFilter: Filter | null = null
  const headLayerDef = manifest.layers.head
  if (headUnderBody && headLayerDef) {
    const bounds = headGroup.getLocalBounds()
    const centerX = (headPivot.x - bounds.x) / Math.max(1, bounds.width)
    const halfWidth = headLayerDef.size.w / Math.max(1, bounds.width) / 2
    const chinY =
      faceHeight != null && headPivotY != null
        ? headPivotY - 0.14 * faceHeight
        : bounds.y + bounds.height * 0.82
    const neckY = (chinY - bounds.y) / Math.max(1, bounds.height)
    headTurnFilter = new Filter({
      glProgram: new GlProgram({ vertex: HEAD_TURN_VERTEX, fragment: HEAD_TURN_FRAGMENT }),
      resources: {
        headTurnUniforms: {
          uTurn: { value: 0, type: 'f32' },
          uCenterX: { value: centerX, type: 'f32' },
          uHalfWidth: { value: halfWidth, type: 'f32' },
          uNeckY: { value: neckY, type: 'f32' },
        },
      },
    })
    headGroup.filters = [headTurnFilter]
  }

  bodyLayers.sort((a, b) => a.def.z - b.def.z)
  headLayers.sort((a, b) => a.def.z - b.def.z)
  headGroup.visible = headLayers.length > 0
  bodyGroup.visible = bodyLayers.length > 0 || headUnderBody

  const baseHeadX = headGroup.position.x
  const baseHeadY = headGroup.position.y
  const params: Record<string, number> = {}
  const targets: Record<string, number> = {}
  for (const param of rig.parameters) {
    params[param.id] = param.default
    targets[param.id] = param.default
  }
  const external: Record<string, number> = {}
  const tauFor = (id: string) => rig.parameters.find((param) => param.id === id)?.smoothingMs ?? 120

  let idleTime = 0
  let nextBlinkAt = 1.8 + Math.random() * 3
  let blinkStart = -1
  let doubleBlinkAt = -1
  const blinkDuration = 0.26
  // The character holds still by default: only the hair keeps moving. The
  // full idle (head sway, breathing, blinking) is one click away.
  let idleEnabled = false
  let gesture: { type: GestureType; start: number; duration: number } | null = null
  let smileAmount = 0
  let smileTarget = 0
  /** Mouth shape driven by the audio analysis; null falls back to the levels. */
  let mouthShape: MouthShape | null = null
  let hairLagX = 0
  let hairLagY = 0
  let pointerX = 0
  let pointerY = 0
  let pointerActive = false

  const onPointerMove = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    pointerX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    pointerY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1)
    pointerActive = true
  }
  const onPointerLeave = () => {
    pointerActive = false
    pointerX = 0
    pointerY = 0
  }
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerleave', onPointerLeave)

  const fit = () => {
    const width = host.clientWidth || 1
    const height = host.clientHeight || 1
    const scale = Math.min(width / manifest.canvas.width, height / manifest.canvas.height)
    root.scale.set(scale)
    root.position.set(
      (width - manifest.canvas.width * scale) / 2,
      (height - manifest.canvas.height * scale) / 2,
    )
  }
  fit()
  const resizeObserver = new ResizeObserver(() => fit())
  resizeObserver.observe(host)

  let lastFpsSample = performance.now()
  let frames = 0

  const updateHairMesh = (
    node: LayerNode,
    ax: number,
    ay: number,
    lagX: number,
    lagY: number,
  ) => {
    if (!node.mesh || !node.basePositions) return
    const positions = node.mesh.geometry.positions
    const base = node.basePositions
    const width = Math.max(1, node.def.size.w)
    const height = Math.max(1, node.def.size.h)
    const front = node.def.id === 'hairFront'
    // Hair is also baked into the head layer, so keep the relative motion
    // small enough that the duplicate underneath never peeks out.
    const amplitude = front ? 7 : 5
    const speed = front ? 1.9 : 1.35
    for (let i = 0; i < base.length; i += 2) {
      const x = base[i]
      const y = base[i + 1]
      const u = x / width
      const v = y / height
      const weight = Math.pow(clamp(v, 0, 1), front ? 1.35 : 1.55)
      const sideFactor = front ? 0.34 + 0.66 * smoothstep(Math.abs(u - 0.5) * 2) : 1
      const phase = idleTime * speed + u * 2.1 + v * 2.7 + (front ? 0.2 : 1.1)
      const sway = Math.sin(phase) * amplitude + Math.sin(phase * 2.17 + 1.1) * amplitude * 0.4
      const dx = ((sway - lagX * 0.3) * sideFactor + ax * (front ? 2 : 2.5)) * weight
      const dy = (Math.cos(phase * 0.83) * (front ? 2 : 1.5) - lagY * 0.15 + ay * 1.6) * weight
      positions[i] = x + dx
      positions[i + 1] = y + dy
    }
    node.mesh.geometry.getBuffer('aPosition').update()
  }

  const applyLayerVisibility = () => {
    for (const [id, entry] of layerParts) {
      const on = soloLayer ? id === soloLayer : layerVisibility.get(id) !== false
      for (const node of entry.nodes) {
        if (node.sprite) node.sprite.visible = on
        if (node.mesh) node.mesh.visible = on
      }
      for (const overlay of entry.overlays) overlay.visible = on
    }
  }

  const tick = (ticker: { deltaMS: number }) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05)
    idleTime += dt
    frames += 1
    const now = performance.now()
    if (now - lastFpsSample > 1000) {
      emit('fps', { fps: (frames * 1000) / (now - lastFpsSample) })
      frames = 0
      lastFpsSample = now
    }

    const idleAngleX = idleEnabled
      ? Math.sin((idleTime / 7.4) * Math.PI * 2) * 0.13 +
        Math.sin((idleTime / 3.3) * Math.PI * 2) * 0.025
      : 0
    const idleAngleY = idleEnabled ? Math.sin((idleTime / 9.2) * Math.PI * 2) * 0.06 : 0
    const idleAngleZ = idleEnabled ? Math.sin((idleTime / 8.1) * Math.PI * 2) * 0.035 : 0
    const idleBody = idleEnabled ? Math.sin((idleTime / 6.9) * Math.PI * 2) * 0.09 : 0
    const idleBreath = idleEnabled
      ? 0.5 + 0.5 * Math.sin((idleTime / 4.7) * Math.PI * 2 + 0.6)
      : 0.35

    let gestureX = 0
    let gestureY = 0
    let gestureZ = 0
    let gestureBodyRot = 0
    if (gesture) {
      const progress = (idleTime - gesture.start) / gesture.duration
      if (progress >= 1) {
        gesture = null
      } else if (gesture.type === 'nod') {
        gestureY = Math.sin(progress * Math.PI * 2) * 0.4
        gestureBodyRot = Math.sin(progress * Math.PI * 2) * 0.008
      } else if (gesture.type === 'shake') {
        const phase = progress * Math.PI * 4
        const decay = 1 - progress * 0.28
        const osc = Math.sin(phase) * decay
        gestureX = osc * 0.3
        gestureZ = Math.sin(phase + 0.5) * 0.44 * decay
        gestureBodyRot = -osc * 0.018
      } else {
        const env = Math.sin(progress * Math.PI)
        gestureZ = env * 0.55
        gestureX = env * 0.05
        gestureBodyRot = -env * 0.012
      }
    }

    // Following the pointer is a direct response, not ambient motion, so it
    // stays on even when the idle animation is off. Only the pointer angle
    // is used — the head leans towards the cursor.
    const pointerAngleX = pointerActive ? pointerX * 0.8 : 0
    const pointerAngleY = pointerActive ? pointerY * 0.5 : 0
    targets.ParamAngleX = clamp(
      (external.ParamAngleX ?? 0) + idleAngleX + pointerAngleX + gestureX,
      -1,
      1,
    )
    targets.ParamAngleY = clamp(
      (external.ParamAngleY ?? 0) + idleAngleY + pointerAngleY + gestureY,
      -1,
      1,
    )
    targets.ParamAngleZ = clamp((external.ParamAngleZ ?? 0) + idleAngleZ + gestureZ, -1, 1)
    targets.ParamBodyAngleX = clamp(
      (external.ParamBodyAngleX ?? 0) + idleBody + pointerAngleX * 0.16,
      -1,
      1,
    )
    targets.ParamBreath = clamp(external.ParamBreath ?? idleBreath, 0, 1)
    targets.ParamMouthOpenY = clamp(external.ParamMouthOpenY ?? 0, 0, 1)
    targets.ParamMouthForm = clamp(external.ParamMouthForm ?? 0, -1, 1)

    // Blinking belongs to the idle motion. With it off the face holds still,
    // so only the hair moves.
    if (idleEnabled && idleTime > nextBlinkAt && blinkStart < 0) {
      blinkStart = idleTime
      nextBlinkAt = idleTime + 2.5 + Math.random() * 4
    }
    if (doubleBlinkAt > 0 && idleTime >= doubleBlinkAt) {
      blinkStart = idleTime
      doubleBlinkAt = -1
    }
    let blinkClose = 0
    if (blinkStart >= 0) {
      const progress = (idleTime - blinkStart) / blinkDuration
      if (progress >= 1) {
        blinkStart = -1
        nextBlinkAt = idleTime + 2.4 + Math.random() * 4
        if (Math.random() < 0.28) doubleBlinkAt = idleTime + 0.14
      } else {
        blinkClose = blinkCurve(progress)
      }
    }
    targets.ParamEyeLOpen = 1 - blinkClose
    targets.ParamEyeROpen = 1 - blinkClose

    for (const key of Object.keys(params)) {
      params[key] = smooth(params[key], targets[key] ?? 0, tauFor(key), dt)
    }

    const ax = params.ParamAngleX
    const ay = params.ParamAngleY
    const az = params.ParamAngleZ
    const bodyAx = params.ParamBodyAngleX
    const breath = params.ParamBreath
    const shape = mouthShape
    // An analysed shape replaces the plain level so the lips can also narrow,
    // round up or show teeth.
    const mouth = clamp(shape ? shape.openness : params.ParamMouthOpenY, 0, 1)
    const mouthForm = clamp(params.ParamMouthForm, -1, 1)
    const lipWidth = clamp(shape ? shape.width : 0, -1, 1)
    const roundness = clamp(shape ? shape.roundness : 0, 0, 1)
    const teethAmount = clamp(shape ? shape.teeth : 0, 0, 1)
    smileAmount = smooth(
      smileAmount,
      Math.max(smileTarget, clamp(mouthForm, 0, 1)),
      120,
      dt,
    )

    // The turn itself is a shader warp on the whole head group: eyes, mouth
    // and hair all move together, so the baked face and the sprite overlays
    // never split into two copies.
    const headTurn = headUnderBody ? clamp(ax, -1, 1) : 0
    bodyGroup.rotation = bodyAx * 0.024 + gestureBodyRot
    // The horizontal turn happens inside the head texture, so the group itself
    // must not slide: moving it would pull the neck away from the shoulders.
    headGroup.position.x = baseHeadX
    headGroup.position.y = baseHeadY + ay * 9 - breath * 1.6
    headGroup.rotation = az * 0.18 + ax * 0.02 + bodyAx * 0.01
    if (headTurnFilter) {
      headTurnFilter.resources.headTurnUniforms.uniforms.uTurn = headTurn
    }

    const headOffsetX = headGroup.position.x - baseHeadX
    const headOffsetY = headGroup.position.y - baseHeadY
    hairLagX = smooth(hairLagX, headOffsetX, 170, dt)
    hairLagY = smooth(hairLagY, headOffsetY, 190, dt)

    for (const node of layerNodes) {
      if (node.mesh) {
        updateHairMesh(node, ax, ay, hairLagX, hairLagY)
        continue
      }
      if (!node.sprite) continue
      if (node.isEye && !eyeOverlays.length) {
        node.sprite.scale.y = 0.14 + 0.86 * (1 - blinkClose)
      } else if (node.isMouth && !mouthOverlays) {
        node.sprite.scale.y = 0.94 + mouth * 0.35
        node.sprite.scale.x = 1 + mouth * 0.04 + mouthForm * 0.06 + lipWidth * 0.1
        node.sprite.position.y = node.baseY + mouth * 1.2 + mouthForm * 1.2
      }
    }

    const smileSquint = smileAmount * 0.12
    const eyeClose = clamp(blinkClose + smileSquint, 0, 1)
    for (const overlay of eyeOverlays) {
      overlay.base.alpha = 1 - eyeClose
      overlay.sprite.alpha = eyeClose
    }

    if (mouthOverlays) {
      const halfAlpha = clamp(mouth / 0.4, 0, 1)
      const openAlpha = clamp((mouth - 0.35) / 0.5, 0, 1)
      // Rounded and sibilant shapes take over the mouth completely; the rest
      // of the opening stays a plain jaw drop.
      const generic = 1 - Math.max(roundness, teethAmount)
      const shapedOpen = openAlpha * generic
      const shapedHalf = halfAlpha * generic * (1 - shapedOpen)
      const roundAlpha = roundness * clamp(mouth * 4, 0, 1)
      const teethAlpha = teethAmount * clamp(mouth * 4, 0, 1)
      mouthOverlays.half.alpha = Math.max(0, shapedHalf)
      mouthOverlays.open.alpha = shapedOpen
      mouthOverlays.round.alpha = roundAlpha
      mouthOverlays.teeth.alpha = teethAlpha
      mouthOverlays.smile.alpha =
        smileAmount * (1 - Math.max(shapedOpen, roundAlpha, teethAlpha))
      const widthScale = 1 + lipWidth * 0.1
      mouthOverlays.half.scale.x = widthScale
      mouthOverlays.open.scale.x = widthScale
      mouthOverlays.round.scale.x = widthScale
      mouthOverlays.teeth.scale.x = widthScale
      mouthOverlays.smile.scale.x = widthScale
    }
  }

  app.ticker.add(tick)

  const handle: StageHandle = {
    setParams(partial) {
      for (const [key, value] of Object.entries(partial)) external[key] = value
    },
    setMouthOpen(value) {
      external.ParamMouthOpenY = clamp(value, 0, 1)
      mouthShape = null
    },
    setMouthShape(shape) {
      mouthShape = shape
    },
    setLayerVisible(layerId, visible) {
      layerVisibility.set(layerId, visible)
      applyLayerVisibility()
    },
    setSoloLayer(layerId) {
      soloLayer = layerId
      applyLayerVisibility()
    },
    setExpression(id) {
      if (id === 'smile') {
        smileTarget = 1
        external.ParamMouthForm = 0.65
      } else if (id === 'neutral') {
        smileTarget = 0
        external.ParamMouthForm = 0
      }
    },
    playMotion(id) {
      if (id === 'nod' || id === 'shake' || id === 'tilt') {
        gesture = {
          type: id,
          start: idleTime,
          duration: id === 'shake' ? 1.35 : 1.05,
        }
        return
      }
      idleEnabled = id !== 'none'
    },
    blink() {
      blinkStart = idleTime
      doubleBlinkAt = -1
      nextBlinkAt = idleTime + 2.4 + Math.random() * 4
    },
    stopSpeaking() {
      external.ParamMouthOpenY = 0
      mouthShape = null
    },
    resize() {
      fit()
    },
    destroy() {
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      resizeObserver.disconnect()
      app.ticker.remove(tick)
      for (const node of layerNodes) node.mesh?.geometry.destroy()
      for (const url of urls) URL.revokeObjectURL(url)
      for (const texture of textures) texture.destroy(true)
      app.destroy(true, { children: true, texture: true })
      if (stagedHost.__avatarStage === handle) stagedHost.__avatarStage = undefined
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(cb)
      return () => listeners.get(event)?.delete(cb)
    },
  }
  stagedHost.__avatarStage = handle
  return handle
}

// The stage is a long-lived Pixi instance; a hot-swapped module cannot rebuild
// it, so force a full page reload instead of silently keeping the old runtime.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate()
  })
}
