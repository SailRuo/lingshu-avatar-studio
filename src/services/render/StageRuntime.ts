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
import { LayerVisibility } from './layerVisibility'
import { deformMouthPositions, type MouthControl, type MouthWeights } from './mouthDeform'

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
  // Fade the warp out at the chin cut; the neck below it belongs to the body
  // and stays perfectly still so the two can never separate.
  float neckWeight = 1.0 - smoothstep(uNeckY - 0.06, uNeckY, uv.y);
  float xp = mix(nx, warped, band * neckWeight);
  uv.x = uCenterX + xp * halfWidth;
  finalColor = texture(uTexture, uv);
}
`

const EYE_GAZE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uGazeX;
uniform float uGazeY;

void main(void) {
  vec2 uv = vTextureCoord;
  // Only the iris/pupil region moves. The mask fades out before the sclera
  // and the lash line, so the eye outline stays anchored to the socket.
  vec2 d = (uv - vec2(0.5, 0.52)) / vec2(0.34, 0.32);
  float inside = 1.0 - smoothstep(0.55, 1.0, length(d));
  vec2 shifted = uv - vec2(uGazeX, uGazeY) * inside;
  finalColor = texture(uTexture, shifted);
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

/** A mouth layer that is deformed by the continuous mouth field. */
interface MouthMeshNode {
  node: LayerNode
  mesh: Mesh
  /** The resting positions of the grid vertices, in the layer's own space. */
  base: Float32Array
  weights: MouthWeights
  control: MouthControl
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

/** Moves a point from character space into the space of a layer. */
function shiftPoint(point: { x: number; y: number }, offset: { x: number; y: number }) {
  return { x: point.x - offset.x, y: point.y - offset.y }
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
   * Every layer id maps to the renderables and the animation overlays that
   * belong to it, so a visibility switch hides the whole piece. The hair is a
   * mesh rather than a sprite, so it has to be registered just as carefully.
   */
  const visibility = new LayerVisibility()
  const layerVisibility = new Map<string, boolean>()
  let soloLayer: string | null = null
  const eyeOverlays: Array<{ sprite: Sprite; base: Sprite }> = []
  let mouthOverlays: MouthOverlays | null = null
  const mouthMeshes: MouthMeshNode[] = []
  let mouthCavityNode: LayerNode | null = null
  const gazeFilters: Filter[] = []

  // The continuous mouth rig needs the deformation field that was stored in
  // the character pack. Without it — an older pack, a broken import — the
  // stage falls back to the five pre-drawn mouth textures.
  const mouthField = rig.mouth
  const mouthWeights: MouthWeights | null = mouthField
    ? {
        upper: Float32Array.from(mouthField.upper),
        lower: Float32Array.from(mouthField.lower),
        corner: Float32Array.from(mouthField.corner),
        side: Float32Array.from(mouthField.side),
      }
    : null
  const mouthFieldMatches = (def: LayerDef): boolean => {
    if (!mouthField) return false
    return (
      Math.abs(def.offset.x - mouthField.rect.x) < 0.5 &&
      Math.abs(def.offset.y - mouthField.rect.y) < 0.5 &&
      Math.abs(def.size.w - mouthField.rect.w) < 0.5 &&
      Math.abs(def.size.h - mouthField.rect.h) < 0.5
    )
  }

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
    const isMouthCavity = def.id === 'mouthCavity'
    const isHair = def.id === 'hairFront' || def.id === 'hairBack'
    const meshDef = isHair ? rig.meshes?.[def.id] : undefined
    // Back hair is stored under the body node, but it belongs to the head:
    // keeping it static leaves a fixed copy behind the moving head, and the
    // head layer is cut at the neckline, so the lower hair would disappear.
    const parentToHead = def.parent !== 'body' || def.id === 'hairBack'

    // The mouth and the cavity behind it are deformed by the continuous mouth
    // field. Both use the same grid and the same weights, so the edge of the
    // cavity always follows the lips.
    // Only the lips deform. The cavity is a fixed picture that the parting
    // lips reveal: stretching it with the same field smears its contents into
    // streaks, which is exactly what an open mouth must not look like.
    if (isMouth && mouthField && mouthWeights && mouthFieldMatches(def)) {
      try {
        const geometry = new PlaneGeometry({
          width: def.size.w,
          height: def.size.h,
          verticesX: Math.max(2, mouthField.cols),
          verticesY: Math.max(2, mouthField.rows),
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
          meshDef: null,
          baseX: def.offset.x,
          baseY: def.offset.y,
          isEye: false,
          isMouth,
          isHair: false,
        }
        layerNodes.push(node)
        // A mesh that is not registered with its layer can never be hidden.
        visibility.register(def.id, mesh)
        // The control points live in character space; the mesh works in its
        // own space, so they are moved along with the layer.
        const control: MouthControl = {
          upper: shiftPoint(mouthField.control.upper, def.offset),
          lower: shiftPoint(mouthField.control.lower, def.offset),
          cornerL: shiftPoint(mouthField.control.cornerL, def.offset),
          cornerR: shiftPoint(mouthField.control.cornerR, def.offset),
          innerUpper: shiftPoint(mouthField.control.innerUpper, def.offset),
          innerLower: shiftPoint(mouthField.control.innerLower, def.offset),
        }
        mouthMeshes.push({
          node,
          mesh,
          base: node.basePositions!,
          weights: mouthWeights,
          control,
        })
        if (parentToHead) {
          headLayers.push(node)
          headGroup.addChild(mesh)
        } else {
          bodyLayers.push(node)
          bodyGroup.addChild(mesh)
        }
        continue
      } catch (err) {
        console.warn('[avatar] mouth mesh failed, falling back to sprites', def.id, err)
      }
    }

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
        // The hair is a mesh, not a sprite. It still has to be registered with
        // its layer, or the visibility and solo switches never reach it and
        // the hair keeps rendering on top of every other layer.
        visibility.register(def.id, mesh)
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
    if (isEye) {
      try {
        const gazeFilter = new Filter({
          glProgram: new GlProgram({ vertex: HEAD_TURN_VERTEX, fragment: EYE_GAZE_FRAGMENT }),
          resources: {
            gazeUniforms: {
              uGazeX: { value: 0, type: 'f32' },
              uGazeY: { value: 0, type: 'f32' },
            },
          },
        })
        sprite.filters = [gazeFilter]
        gazeFilters.push(gazeFilter)
      } catch (err) {
        console.warn('[avatar] eye gaze filter failed', def.id, err)
      }
    }
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
    if (isMouthCavity) mouthCavityNode = node
    visibility.register(def.id, sprite)
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
    // The head layer is baked from the full foreground and usually carries a
    // slice of neck. That slice must not travel with the head: the body layer
    // already owns the neck, and moving both copies is what tore the neckline
    // apart. Cut the head just below the chin so the neck stays on the body.
    // If the body layer starts lower than the chin (an asset whose split left
    // no neck behind the jaw), keep enough neck to overlap it instead of
    // cutting a hole.
    // The hair is painted back on top of the fade: a plain horizontal cut also
    // slices through the hair, which is what produced the rectangular edge.
    const chinY = headPivotY - 0.14 * faceHeight
    const chinCutY = chinY + faceHeight * 0.04
    const bodyTopY = manifest.layers.body?.offset.y
    const headBottomY = bodyTopY != null && bodyTopY > chinCutY ? bodyTopY : chinCutY
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
        const headMaskTexture = Texture.from(maskCanvas)
        textures.push(headMaskTexture)
        const mask = new Sprite(headMaskTexture)
        mask.position.set(headDef.offset.x, top)
        mask.width = headDef.size.w
        mask.height = headDef.size.h
        headGroup.addChild(mask)
        // The mask encodes the fade in its alpha channel: the gradient is
        // white with a falling alpha, and the hair slices are drawn back in
        // to stay fully opaque below the chin. Pixi reads the red channel by
        // default, which would take the hair's own dark colour as the mask
        // value and dim the hair baked into the head layer.
        headLayerNode.sprite.setMask({ mask, channel: 'alpha' })
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
        bodyLayerNode.sprite.setMask({ mask, channel: 'alpha' })
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
        visibility.registerOverlay(eyeId, overlay)
      } catch (err) {
        console.warn('[avatar] closed eye texture failed', eyeId, err)
      }
    }
  }

  const mouthDef = manifest.layers.mouth
  const mouthImage = images.get('mouth')
  const mouthBaseNode = layerNodes.find((node) => node.def.id === 'mouth')
  // Only the fallback path needs the pre-drawn mouth textures. When the
  // continuous mouth rig is in use the mouth is a mesh, and the old overlays
  // would draw a second mouth on top of it.
  if (mouthDef && mouthImage && mouthBaseNode?.sprite) {
    try {
      const variants = createMouthVariantTextures(mouthImage, mouthDef)
      if (variants && mouthBaseNode.sprite) {
        const makeOverlay = (texture: Texture, z: number) => {
          const sprite = new Sprite(texture)
          sprite.anchor.set(mouthBaseNode!.sprite!.anchor.x, mouthBaseNode!.sprite!.anchor.y)
          sprite.position.set(mouthBaseNode!.baseX, mouthBaseNode!.baseY)
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
        for (const overlay of Object.values(overlays)) {
          visibility.registerOverlay('mouth', overlay)
        }
      }
    } catch (err) {
      console.warn('[avatar] mouth variants failed', err)
    }
  }

  // A renderable that was never registered with its layer keeps rendering no
  // matter what the visibility switches say. Catch that here instead of
  // letting it show up as a layer that cannot be switched off.
  const unregistered = visibility.findUnregistered([
    ...layerNodes.flatMap((node) =>
      [node.sprite, node.mesh].filter((target): target is Sprite | Mesh => Boolean(target)),
    ),
    ...eyeOverlays.map((entry) => entry.sprite),
    ...(mouthOverlays ? Object.values(mouthOverlays) : []),
  ])
  if (unregistered.length) {
    console.warn(
      `[avatar] ${unregistered.length} renderable(s) are not registered with a layer and cannot be hidden`,
    )
  }

  let headTurnFilter: Filter | null = null
  const headLayerDef = manifest.layers.head
  if (headUnderBody && headLayerDef) {
    const bounds = headGroup.getLocalBounds()
    const centerX = (headPivot.x - bounds.x) / Math.max(1, bounds.width)
    const halfWidth = headLayerDef.size.w / Math.max(1, bounds.width) / 2
    // Anchor the warp at the chin cut. The neck below it belongs to the body
    // and must stay perfectly still, otherwise the two neck copies slide
    // against each other and the neckline tears.
    const chinCutY =
      faceHeight != null && headPivotY != null
        ? headPivotY - 0.1 * faceHeight
        : bounds.y + bounds.height
    const neckY = clamp((chinCutY - bounds.y) / Math.max(1, bounds.height), 0, 1)
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
  let gazeX = 0
  let gazeY = 0
  let gazeTargetX = 0
  let gazeTargetY = 0
  let nextGazeAt = 0.7 + Math.random() * 1.5
  let expressionSquint = 0
  let expressionSquintTarget = 0
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
    visibility.apply(soloLayer, layerVisibility)
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

    // A single sine reads as a metronome. Three incommensurate periods per
    // axis give a slow, non-repeating sway without needing a noise library.
    const organic = (t: number, p1: number, p2: number, p3: number, phase: number) =>
      Math.sin(t / p1 + phase) * 0.55 +
      Math.sin(t / p2 + phase * 1.7) * 0.3 +
      Math.sin(t / p3 + phase * 0.6) * 0.15
    const idleAngleX = idleEnabled ? organic(idleTime, 7.4, 3.1, 11.3, 0.2) * 0.13 : 0
    const idleAngleY = idleEnabled ? organic(idleTime, 9.2, 4.3, 13.1, 1.1) * 0.06 : 0
    const idleAngleZ = idleEnabled ? organic(idleTime, 8.1, 3.7, 12.4, 2.0) * 0.035 : 0
    const idleBody = idleEnabled ? organic(idleTime, 6.9, 2.9, 10.7, 0.7) * 0.09 : 0
    const idleBreath = idleEnabled
      ? 0.5 + 0.5 * organic(idleTime, 4.7, 2.3, 8.8, 0.6)
      : 0.35

    expressionSquint = smooth(expressionSquint, expressionSquintTarget, 180, dt)
    if (pointerActive) {
      gazeTargetX = pointerX * 0.85
      gazeTargetY = pointerY * 0.55
      nextGazeAt = idleTime + 1.4
    } else if (idleEnabled && idleTime > nextGazeAt) {
      gazeTargetX = (Math.random() * 2 - 1) * 0.85
      gazeTargetY = (Math.random() * 2 - 1) * 0.5
      nextGazeAt = idleTime + 0.7 + Math.random() * 2.2
    } else if (!idleEnabled) {
      gazeTargetX = 0
      gazeTargetY = 0
    }
    const gazeAlpha = 1 - Math.exp(-dt * 22)
    gazeX += (gazeTargetX - gazeX) * gazeAlpha
    gazeY += (gazeTargetY - gazeY) * gazeAlpha
    for (const filter of gazeFilters) {
      filter.resources.gazeUniforms.uniforms.uGazeX = gazeX * 0.06
      filter.resources.gazeUniforms.uniforms.uGazeY = gazeY * 0.04
    }

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
        if (node.isHair) updateHairMesh(node, ax, ay, hairLagX, hairLagY)
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
    const eyeClose = clamp(blinkClose + smileSquint + expressionSquint, 0, 1)
    for (const overlay of eyeOverlays) {
      overlay.base.alpha = 1 - eyeClose
      overlay.sprite.alpha = eyeClose
    }

    // The cavity only exists while the mouth is open. With it fully opaque the
    // dark interior leaks through the resting aperture and a closed mouth
    // reads as a black seam.
    if (mouthCavityNode?.sprite) {
      mouthCavityNode.sprite.alpha = clamp(mouth * 2.4, 0, 1)
    }

    if (mouthMeshes.length) {
      // The continuous mouth: one weighted sum over the vertices of the mouth
      // and of the cavity behind it. Both meshes share the weights, so the
      // cavity always stays glued to the lips.
      const deformShape: MouthShape = {
        viseme: shape?.viseme ?? 'rest',
        openness: mouth,
        width: lipWidth,
        roundness,
        teeth: teethAmount,
        level: shape?.level ?? mouth,
      }
      // The cavity is only visible while the mouth is open. With it fully
      // opaque the dark interior leaks through the resting aperture and the
      // closed mouth reads as a black seam; fading it in leaves the original
      // closed lips untouched.
      for (const entry of mouthMeshes) {
        const positions = entry.mesh.geometry.positions
        deformMouthPositions(entry.base, entry.weights, entry.control, deformShape, positions)
        // Changing the positions is not enough: the buffer has to be told.
        entry.mesh.geometry.getBuffer('aPosition').update()
      }
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
      smileTarget = id === 'smile' ? 1 : 0
      external.ParamMouthForm = 0
      external.ParamMouthOpenY = 0
      external.ParamAngleY = 0
      external.ParamAngleZ = 0
      expressionSquintTarget = 0
      gazeTargetX = 0
      gazeTargetY = 0
      nextGazeAt = idleTime + 1.6
      if (id === 'smile') {
        external.ParamMouthForm = 0.65
      } else if (id === 'sad') {
        external.ParamMouthForm = -0.45
        external.ParamAngleY = -0.12
        expressionSquintTarget = 0.1
        gazeTargetY = -0.45
      } else if (id === 'angry') {
        external.ParamMouthForm = -0.3
        external.ParamAngleY = -0.05
        external.ParamAngleZ = -0.05
        expressionSquintTarget = 0.26
      } else if (id === 'surprised') {
        external.ParamMouthOpenY = 0.55
        external.ParamAngleY = 0.12
        gazeTargetY = 0.2
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
