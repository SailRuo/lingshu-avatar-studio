import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

export interface SegmentationResult {
  width: number
  height: number
  categories: Uint8Array
  labels: string[]
}

let multiclassPromise: Promise<ImageSegmenter | null> | null = null
let binaryPromise: Promise<ImageSegmenter | null> | null = null

async function createSegmenter(modelPath: string, delegate: 'GPU' | 'CPU'): Promise<ImageSegmenter> {
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: 'IMAGE',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  })
}

async function loadSegmenter(
  modelPath: string,
): Promise<ImageSegmenter | null> {
  try {
    return await createSegmenter(modelPath, 'GPU')
  } catch (gpuError) {
    console.warn('[avatar] segmenter GPU failed, retrying CPU', gpuError)
    try {
      return await createSegmenter(modelPath, 'CPU')
    } catch (cpuError) {
      console.warn('[avatar] segmenter unavailable', cpuError)
      return null
    }
  }
}

export async function getMulticlassSegmenter(): Promise<ImageSegmenter | null> {
  if (!multiclassPromise) {
    multiclassPromise = loadSegmenter('/models/selfie_multiclass_256x256.tflite')
  }
  return multiclassPromise
}

export async function getBinarySegmenter(): Promise<ImageSegmenter | null> {
  if (!binaryPromise) {
    binaryPromise = loadSegmenter('/models/selfie_segmenter.tflite')
  }
  return binaryPromise
}

function readMask(segmenter: ImageSegmenter, source: HTMLCanvasElement): SegmentationResult | null {
  let result
  try {
    result = segmenter.segment(source)
  } catch (err) {
    console.warn('[avatar] segmentation failed', err)
    return null
  }
  const mask = result.categoryMask
  if (!mask) {
    result.close()
    return null
  }
  const categories = mask.getAsUint8Array().slice()
  const out: SegmentationResult = {
    width: mask.width,
    height: mask.height,
    categories,
    labels: segmenter.getLabels(),
  }
  result.close()
  return out
}

export async function segmentImage(source: HTMLCanvasElement): Promise<SegmentationResult | null> {
  const multiclass = await getMulticlassSegmenter()
  if (multiclass) {
    const result = readMask(multiclass, source)
    if (result) return result
  }
  const binary = await getBinarySegmenter()
  if (binary) return readMask(binary, source)
  return null
}
