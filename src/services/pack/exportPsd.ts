import { writePsdUint8Array } from 'ag-psd'
import type { CharacterRecord } from '../../types/character'
import { canvasFromBlob } from '../imaging/canvas'

export async function exportCharacterPsd(record: CharacterRecord): Promise<Blob> {
  const layers = []
  for (const def of Object.values(record.manifest.layers)) {
    if (!def) continue
    const blob = record.layers[def.id]
    if (!blob) continue
    const canvas = await canvasFromBlob(blob)
    layers.push({
      name: def.nameZh || def.id,
      canvas,
      left: Math.round(def.offset.x),
      top: Math.round(def.offset.y),
      right: Math.round(def.offset.x + def.size.w),
      bottom: Math.round(def.offset.y + def.size.h),
      opacity: def.opacity,
      hidden: false,
    })
  }
  if (!layers.length) throw new Error('没有可导出的图层。')
  const buffer = writePsdUint8Array({
    width: record.manifest.canvas.width,
    height: record.manifest.canvas.height,
    children: layers,
  })
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' })
}
