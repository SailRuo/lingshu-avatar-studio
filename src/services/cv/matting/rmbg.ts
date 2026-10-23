import * as ort from 'onnxruntime-web/wasm'
// Let Vite emit and hash the runtime assets. Pointing onnxruntime at these URLs
// avoids shipping a second, identical copy of the 14 MB wasm from public/.
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import type { Mask } from '../masks'
import { getModelInfo, loadModelBlob, type StoredModelInfo } from '../../storage/modelRepo'
import {
  alphaToMask,
  imageDataToNchw,
  minMaxNormalize,
  resizeAlphaBilinear,
  type RgbaImage,
} from './preprocess'
import { RMBG_1_4, type MattingModelSpec } from './spec'

const ORT_WASM_PATHS = {
  mjs: ortMjsUrl,
  wasm: ortWasmUrl,
}

let envReady = false

function ensureOrtEnv(): void {
  if (envReady) return
  ort.env.wasm.wasmPaths = ORT_WASM_PATHS
  // WKWebView does not expose SharedArrayBuffer without cross-origin
  // isolation, so a single thread is the portable choice.
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  envReady = true
}

function sessionKey(info: StoredModelInfo): string {
  return `${info.id}:${info.size}:${info.importedAt}`
}

interface CachedSession {
  key: string
  promise: Promise<ort.InferenceSession>
}

let cachedSession: CachedSession | null = null

async function getSession(
  spec: MattingModelSpec,
  info: StoredModelInfo,
): Promise<ort.InferenceSession | null> {
  const key = sessionKey(info)
  if (cachedSession?.key === key) return cachedSession.promise
  const blob = await loadModelBlob(spec.id)
  if (!blob) return null
  ensureOrtEnv()
  const promise = (async () => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  })()
  cachedSession = { key, promise }
  // A failed creation must not poison the cache: the user may re-import a
  // different file after seeing the error.
  promise.catch(() => {
    if (cachedSession?.promise === promise) cachedSession = null
  })
  return promise
}

function drawToModelInput(source: HTMLCanvasElement, spec: MattingModelSpec): RgbaImage {
  const canvas = document.createElement('canvas')
  canvas.width = spec.inputWidth
  canvas.height = spec.inputHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.drawImage(source, 0, 0, spec.inputWidth, spec.inputHeight)
  return ctx.getImageData(0, 0, spec.inputWidth, spec.inputHeight)
}

/**
 * Runs the user-imported RMBG-1.4 model and returns a soft foreground mask at
 * the source resolution. Returns `null` when no model has been imported, so
 * the caller can keep using the built-in segmentation path.
 */
export async function buildMattingForeground(
  source: HTMLCanvasElement,
  spec: MattingModelSpec = RMBG_1_4,
): Promise<Mask | null> {
  const info = await getModelInfo(spec.id)
  if (!info) return null
  const session = await getSession(spec, info)
  if (!session) return null

  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  if (!inputName || !outputName) throw new Error('模型缺少输入或输出节点。')

  const image = drawToModelInput(source, spec)
  const tensor = new ort.Tensor('float32', imageDataToNchw(image, spec.mean, spec.std), [
    1,
    3,
    spec.inputHeight,
    spec.inputWidth,
  ])
  const results = await session.run({ [inputName]: tensor })
  const output = results[outputName]
  if (!output) throw new Error('模型没有返回输出。')
  if (!(output.data instanceof Float32Array)) throw new Error('模型输出不是 float32。')

  const dims = output.dims
  const srcHeight = dims[dims.length - 2] ?? spec.inputHeight
  const srcWidth = dims[dims.length - 1] ?? spec.inputWidth
  const resized = resizeAlphaBilinear(
    output.data,
    srcWidth,
    srcHeight,
    source.width,
    source.height,
  )
  return alphaToMask(minMaxNormalize(resized), source.width, source.height)
}
