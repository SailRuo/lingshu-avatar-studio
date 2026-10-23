/**
 * Upgrades the mouth cavity with a real open-mouth reference.
 *
 * A character generated from a closed-mouth picture has no interior to show:
 * the lips are pressed together, so the only thing the bake can synthesise is
 * a dark oval. Teeth and the shading of a real mouth cannot be invented from
 * that, which is why the cavity is painted rather than photographed.
 *
 * This module asks the image model to open the mouth of the *existing*
 * character, keeps everything outside the mouth untouched with a mask, and
 * then cuts the cavity from those real pixels. Only the cavity layer is
 * replaced — the rest of the character, the rig and the deformation field are
 * left exactly as they were.
 */

import type { CharacterRecord } from '../../types/character'
import type { ProviderConfig } from '../../types/provider'
import type { CharacterProgressEvent } from './createCharacter'
import { editImage } from '../providers/image'
import { editSizeForProvider } from '../providers/imageSizes'
import { canvasToBlob } from '../imaging/canvas'
import {
  canvasToPngBlob,
  composePartMask,
  composeRecordCanvas,
  flattenOnColor,
  maskToProviderPng,
  pasteCropBack,
  scaleBlobToCanvas,
  scaleCanvas,
} from '../imaging/compose'
import {
  createMouthCavityCanvas,
  MOUTH_APERTURE_HEIGHT,
  MOUTH_APERTURE_WIDTH,
  punchMouthAperture,
  softenMouthCorners,
} from '../imaging/mouthCavity'
import { extractLayerCanvas } from '../imaging/canvas'
import { createCanvas, erodeMask, maskFromEllipse } from '../cv/masks'
import type { Mask } from '../cv/masks'
import { canvasFromBlob } from '../imaging/canvas'
import { appendNotes } from './redrawPlan'
import { providerSupportsMaskEdit } from './redrawPart'

/**
 * The instruction sent with the mask.
 *
 * It has to be explicit about staying inside the mask: an edit that redraws
 * the whole face would break the identity the rest of the rig depends on.
 */
const OPEN_MOUTH_PROMPT = [
  'This is a layered 2D avatar edit. Same character, same framing, pose, camera angle, lighting, art style and facial identity.',
  'Only regenerate the mouth inside the masked area.',
  'Open the mouth slightly: the lips are relaxed and parted by a small gap, and the upper front teeth are visible inside the opening.',
  'Keep the shape, colour and line style of the lips, and keep the chin, jaw, nose and every other feature exactly as they are.',
  'Keep every pixel outside the masked area unchanged.',
  'Do not change the background, body proportions, or any other part of the character.',
].join(' ')

export interface UpgradeMouthCavityOptions {
  record: CharacterRecord
  provider: ProviderConfig
  apiKey: string
  model?: string
  signal?: AbortSignal
  onProgress?: (event: CharacterProgressEvent) => void
}

export interface UpgradeMouthCavityResult {
  record: CharacterRecord
  /** True when the cavity was actually replaced with real pixels. */
  upgraded: boolean
  note: string
}

export async function upgradeMouthCavity(
  options: UpgradeMouthCavityOptions,
): Promise<UpgradeMouthCavityResult> {
  const { record, provider, signal } = options
  const field = record.rig.mouth
  const cavityDef = record.manifest.layers.mouthCavity
  if (!field || !cavityDef) {
    return {
      record,
      upgraded: false,
      note: '当前角色没有连续口型绑定，已跳过张嘴素材。',
    }
  }
  // Two ways to get an open mouth out of the model. A provider that accepts a
  // mask edits the mouth in place. One that does not gets the mouth cropped
  // out and enlarged, so the model never sees the rest of the face and cannot
  // rewrite it; the result is pasted back at the original coordinates.
  const maskMode = providerSupportsMaskEdit(provider)
  const referenceMode = !maskMode && provider.supportsEdit === true && Boolean(provider.models.image)
  if (!maskMode && !referenceMode) {
    return {
      record,
      upgraded: false,
      note: '生图服务商不支持图像编辑，口腔保持合成效果。',
    }
  }

  options.onProgress?.({ step: 'mouth', label: '合成当前角色', progress: 0.15 })
  const composite = await composeRecordCanvas(record)
  const mask = await composePartMask(record, 'mouth')
  if (!mask) {
    return { record, upgraded: false, note: '找不到嘴部图层，已跳过张嘴素材。' }
  }

  options.onProgress?.({ step: 'mouth', label: '生成张嘴素材', progress: 0.35 })
  const feather = Math.max(2, Math.round(Math.min(composite.width, composite.height) * 0.004))
  let editedCanvas: HTMLCanvasElement

  if (maskMode) {
    const target = editSizeForProvider(provider, composite.width, composite.height)
    const workCanvas = scaleCanvas(
      flattenOnColor(composite, '#eeeeee'),
      target.width,
      target.height,
    )
    const maskBlob = await maskToProviderPng(
      mask,
      composite.width,
      composite.height,
      feather,
      true,
    )
    const maskWork = await scaleBlobToCanvas(maskBlob, target.width, target.height)
    const edited = await editImage({
      provider,
      apiKey: options.apiKey,
      modelOverride: options.model,
      prompt: OPEN_MOUTH_PROMPT,
      size: target.size,
      image: await canvasToPngBlob(workCanvas),
      mask: await canvasToPngBlob(maskWork),
      signal,
    })
    editedCanvas = await scaleBlobToCanvas(edited.blob, composite.width, composite.height)
  } else {
    // Reference-edit providers get the whole picture without a mask: asking
    // for a cropped close-up is not reliable, because the model tends to
    // answer with a full character anyway. Sending the full frame and keeping
    // only the mouth region of the answer is what actually lines up.
    const target = editSizeForProvider(provider, composite.width, composite.height)
    const workCanvas = scaleCanvas(
      flattenOnColor(composite, '#eeeeee'),
      target.width,
      target.height,
    )
    const edited = await editImage({
      provider,
      apiKey: options.apiKey,
      modelOverride: options.model,
      prompt: OPEN_MOUTH_PROMPT,
      size: target.size,
      image: await canvasToPngBlob(workCanvas),
      signal,
    })
    const editedFull = await scaleBlobToCanvas(edited.blob, composite.width, composite.height)
    editedCanvas = await pasteCropBack(
      composite,
      editedFull,
      { x: 0, y: 0, w: composite.width, h: composite.height },
      mask,
      feather,
    )
  }

  options.onProgress?.({ step: 'mouth', label: '用真实像素重建口腔', progress: 0.8 })
  const box = {
    x: cavityDef.offset.x,
    y: cavityDef.offset.y,
    w: cavityDef.size.w,
    h: cavityDef.size.h,
  }
  const cavityCanvas = createMouthCavityCanvas({
    source: composite,
    mask,
    box,
    control: field.control,
    reference: editedCanvas,
  })
  const blob = await canvasToBlob(cavityCanvas)
  const now = Date.now()
  const next = appendNotes(
    {
      ...record,
      layers: { ...record.layers, mouthCavity: blob },
      updatedAt: now,
      manifest: { ...record.manifest, updatedAt: now },
    },
    ['口腔与牙齿已使用真实张嘴素材。'],
  )
  options.onProgress?.({ step: 'mouth', label: '张嘴素材完成', progress: 1 })
  return { record: next, upgraded: true, note: '口腔与牙齿已使用真实张嘴素材。' }
}



/**
 * Composites the character without its mouth layers.
 *
 * Both mouth layers are rebuilt from this picture, so they must not be part of
 * it: the mouth layer carries the aperture, and cutting a new mouth out of a
 * picture that already has a hole in it reproduces the hole.
 */
async function composeWithoutMouth(record: CharacterRecord): Promise<HTMLCanvasElement> {
  const { width, height } = record.manifest.canvas
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  const order = record.manifest.layerOrder?.length
    ? record.manifest.layerOrder
    : Object.values(record.manifest.layers)
        .filter(Boolean)
        .sort((a, b) => a!.z - b!.z)
        .map((def) => def!.id)
  for (const id of order) {
    if (id === 'mouth' || id === 'mouthCavity') continue
    const blob = record.layers[id]
    const def = record.manifest.layers[id]
    if (!blob || !def) continue
    const layer = await canvasFromBlob(blob)
    ctx.drawImage(layer, def.offset.x, def.offset.y, def.size.w, def.size.h)
  }
  return canvas
}

export interface RebuildMouthCavityOptions {
  record: CharacterRecord
}

export interface RebuildMouthCavityResult {
  record: CharacterRecord
  rebuilt: boolean
  note: string
}

/**
 * Rebuilds the mouth cavity locally, with no image call.
 *
 * The cavity is a fixed picture revealed by the parting lips, so it can be
 * regenerated from the character's own composite: the painted oval and the
 * mouth mask are enough. This is what repairs characters whose cavity was
 * baked by an older, worse pipeline — and it costs nothing.
 */
export async function rebuildMouthCavity(
  options: RebuildMouthCavityOptions,
): Promise<RebuildMouthCavityResult> {
  const { record } = options
  const field = record.rig.mouth
  const cavityDef = record.manifest.layers.mouthCavity
  if (!field || !cavityDef) {
    return { record, rebuilt: false, note: '这个角色没有连续口型绑定。' }
  }
  // The composite must not contain the mouth layers. The mouth layer already
  // has the aperture punched out of it, so cutting a new mouth out of that
  // composite would inherit the old hole and leave a dark seam on closed lips.
  const composite = await composeWithoutMouth(record)
  const mask = await composePartMask(record, 'mouth')
  if (!mask) return { record, rebuilt: false, note: '找不到嘴部图层。' }

  const cavityBox = {
    x: cavityDef.offset.x,
    y: cavityDef.offset.y,
    w: cavityDef.size.w,
    h: cavityDef.size.h,
  }
  const cavityCanvas = createMouthCavityCanvas({
    source: composite,
    mask,
    box: cavityBox,
    control: field.control,
  })
  const cavityBlob = await canvasToBlob(cavityCanvas)

  const layers: Record<string, Blob> = { ...record.layers, mouthCavity: cavityBlob }

  // The lips carry the aperture the cavity shows through. Characters baked by
  // an older pipeline have it cut from the inner lip ring, which is a jagged
  // two-pixel sliver on a closed mouth. Rebuild the mouth layer with the
  // smooth lens so both layers agree.
  const mouthDef = record.manifest.layers.mouth
  if (mouthDef) {
    const canvasW = record.manifest.canvas.width
    const canvasH = record.manifest.canvas.height
    const aperture = maskFromEllipse(
      canvasW,
      canvasH,
      {
        x: (field.control.cornerL.x + field.control.cornerR.x) / 2,
        y: (field.control.innerUpper.y + field.control.innerLower.y) / 2,
      },
      Math.max(6, (field.control.cornerR.x - field.control.cornerL.x) * MOUTH_APERTURE_WIDTH),
      Math.max(2, (field.control.lower.y - field.control.upper.y) * MOUTH_APERTURE_HEIGHT),
    )
    const mouthBox = {
      x: mouthDef.offset.x,
      y: mouthDef.offset.y,
      w: mouthDef.size.w,
      h: mouthDef.size.h,
    }
    // The baked mouth layer was cut with a dilated lip mask, so it carries a
    // ring of skin around the lips. Deforming that ring drags skin past the
    // corner as a pale blob, or leaves dark specks when it is faded out. Cut
    // the rebuild tight to the lips instead.
    const tight = erodeMask(mask as Mask, 2)
    const mouthCanvas = extractLayerCanvas(composite, tight, mouthBox, 1.2)
    punchMouthAperture(mouthCanvas, aperture, mouthBox)
    layers.mouth = await canvasToBlob(mouthCanvas)
  }

  const now = Date.now()
  const next: CharacterRecord = {
    ...record,
    layers,
    updatedAt: now,
    manifest: { ...record.manifest, updatedAt: now },
  }
  return { record: next, rebuilt: true, note: '嘴唇开口与口腔已重建。' }
}
