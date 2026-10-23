export interface MattingModelSpec {
  id: string
  label: string
  inputWidth: number
  inputHeight: number
  mean: [number, number, number]
  std: [number, number, number]
  /** Reject files outside this range before they reach the IndexedDB store. */
  minBytes: number
  maxBytes: number
  license: string
  sourceUrl: string
}

/**
 * RMBG-1.4 is a 176 MB fp32 ONNX model. It is never bundled: the publisher
 * (BRIA) licenses the weights for non-commercial use only, so the user picks
 * the file and carries the licence.
 */
export const RMBG_1_4: MattingModelSpec = {
  id: 'rmbg-1.4',
  label: 'RMBG-1.4',
  inputWidth: 1024,
  inputHeight: 1024,
  mean: [0.5, 0.5, 0.5],
  std: [1, 1, 1],
  minBytes: 20 * 1024 * 1024,
  maxBytes: 500 * 1024 * 1024,
  license: 'CC BY-NC 4.0 / BRIA 非商用',
  sourceUrl: 'https://huggingface.co/briaai/RMBG-1.4/tree/main/onnx',
}

export function modelFileError(
  file: { name: string; size: number },
  spec: MattingModelSpec,
): string | null {
  if (!file.name.toLowerCase().endsWith('.onnx')) return '请选择 .onnx 模型文件。'
  if (file.size < spec.minBytes) return '文件太小，可能不是完整的 ONNX 模型。'
  if (file.size > spec.maxBytes) return '文件超过 500 MB，当前只支持 RMBG-1.4 这个量级的模型。'
  return null
}
