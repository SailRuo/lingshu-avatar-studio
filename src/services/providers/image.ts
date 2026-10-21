import type { ProviderConfig } from '../../types/provider'
import { providerNeedsUserProxy } from '../platform/runtime'
import { blobToDataUrl, base64ToBlob, getBlobSize } from '../imaging/blob'
import {
  applyProxy,
  errorFromFetch,
  errorFromResponse,
  joinUrl,
  readErrorPayload,
  ProviderError,
} from './http'

export interface GenerateImageOptions {
  provider: ProviderConfig
  apiKey: string
  prompt: string
  size: string
  seed?: number
  transparent?: boolean
  signal?: AbortSignal
  modelOverride?: string
}

export interface EditImageOptions extends GenerateImageOptions {
  image: Blob
  mask?: Blob
}

export interface GeneratedImage {
  blob: Blob
  width: number
  height: number
  revisedPrompt?: string
}

interface ImageApiResponse {
  data?: Array<{
    b64_json?: string
    url?: string
    image_url?: string | { url?: string }
    revised_prompt?: string
  }>
  images?: Array<{
    b64_json?: string
    url?: string
    image_url?: string | { url?: string }
  }>
  error?: unknown
}

export function aspectToSize(
  aspect: '2:3' | '1:1' | '3:4',
  provider?: ProviderConfig,
): string {
  if (provider?.kind === 'sensenova') {
    if (aspect === '1:1') return '2048x2048'
    if (aspect === '3:4') return '1760x2368'
    return '1664x2496'
  }
  if (provider?.kind === 'ark') {
    if (aspect === '1:1') return '2048x2048'
    if (aspect === '3:4') return '1728x2304'
    return '1536x2304'
  }
  if (provider?.kind === 'siliconflow') {
    if (aspect === '1:1') return '1024x1024'
    return '960x1280'
  }
  if (aspect === '1:1') return '1024x1024'
  if (aspect === '3:4') return '768x1024'
  return '1024x1536'
}

function imageEndpoint(provider: ProviderConfig, edit: boolean): string {
  const path = edit ? '/images/edits' : '/images/generations'
  return applyProxy(joinUrl(provider.baseUrl, path), provider.proxyUrl)
}

function pickImageModel(provider: ProviderConfig): string {
  return provider.models.image ?? ''
}

function buildBody(options: GenerateImageOptions, edit: boolean): Record<string, unknown> {
  const model = options.modelOverride || pickImageModel(options.provider)
  const common = {
    model,
    prompt: options.prompt,
    size: options.size,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  }
  if (options.provider.kind === 'sensenova') {
    // Mirrors the app's SenseNova branch: generations/edits + prompt_extend + b64_json.
    return {
      ...common,
      response_format: 'b64_json',
      watermark: false,
      prompt_extend: true,
    }
  }
  if (options.provider.kind === 'ark') {
    return {
      ...common,
      response_format: 'b64_json',
      watermark: false,
    }
  }
  if (options.provider.kind === 'siliconflow') {
    return {
      ...common,
      image_size: options.size,
      batch_size: 1,
      num_inference_steps: 24,
      guidance_scale: 7.5,
    }
  }
  const body: Record<string, unknown> = {
    ...common,
    n: 1,
  }
  if (model.startsWith('gpt-image')) {
    if (options.transparent) body.background = 'transparent'
    body.output_format = 'png'
  } else {
    body.response_format = 'b64_json'
  }
  return body
}

function pickPayload(json: ImageApiResponse): {
  b64?: string
  url?: string
  revisedPrompt?: string
} {
  const first = json.data?.[0] ?? json.images?.[0]
  if (!first) return {}
  const imageUrl =
    typeof first.image_url === 'string' ? first.image_url : first.image_url?.url
  return {
    b64: first.b64_json,
    url: first.url ?? imageUrl,
    revisedPrompt: (first as { revised_prompt?: string }).revised_prompt,
  }
}

async function blobFromUrl(url: string, providerId: string): Promise<Blob> {
  if (url.startsWith('data:')) {
    const res = await fetch(url)
    return res.blob()
  }
  let res: Response
  try {
    res = await fetch(url, { mode: 'cors' })
  } catch (err) {
    throw errorFromFetch(err, providerId)
  }
  if (!res.ok) {
    throw new ProviderError('network', `图片下载失败（HTTP ${res.status}）。`, {
      status: res.status,
      providerId,
    })
  }
  return res.blob()
}

async function decodeResult(json: ImageApiResponse, providerId: string): Promise<GeneratedImage> {
  const payload = pickPayload(json)
  let blob: Blob
  if (payload.b64) {
    blob = base64ToBlob(payload.b64)
  } else if (payload.url) {
    blob = await blobFromUrl(payload.url, providerId)
  } else {
    throw new ProviderError(
      'bad_request',
      '服务商没有返回图片数据。请确认模型支持生图，或换一个返回 b64_json 的模型。',
      { providerId },
    )
  }
  const size = await getBlobSize(blob)
  return { blob, width: size.width, height: size.height, revisedPrompt: payload.revisedPrompt }
}

async function generateJson(
  options: GenerateImageOptions,
  body: Record<string, unknown>,
  edit = false,
): Promise<ImageApiResponse> {
  const url = imageEndpoint(options.provider, edit)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  return (await res.json()) as ImageApiResponse
}

export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage> {
  if (!options.provider.baseUrl) throw new ProviderError('bad_request', '服务商 Base URL 为空。')
  if (providerNeedsUserProxy(options.provider)) {
    throw new ProviderError(
      'cors',
      '该服务商的浏览器预检被上游拒绝；桌面客户端不受此限制。网页版需要自备代理，本站不提供代理。',
      { providerId: options.provider.id },
    )
  }
  if (!pickImageModel(options.provider)) {
    throw new ProviderError('bad_request', '服务商没有配置图像模型。')
  }
  const body = buildBody(options, false)
  let json: ImageApiResponse
  try {
    json = await generateJson(options, body)
  } catch (err) {
    if (
      err instanceof ProviderError &&
      err.status === 400 &&
      'response_format' in body &&
      !(body.model as string).startsWith('gpt-image')
    ) {
      const retryBody = { ...body }
      delete retryBody.response_format
      json = await generateJson(options, retryBody)
    } else {
      throw err
    }
  }
  return decodeResult(json, options.provider.id)
}

async function editViaOpenAI(options: EditImageOptions): Promise<ImageApiResponse> {
  const model = options.modelOverride || pickImageModel(options.provider)
  const form = new FormData()
  form.set('model', model)
  form.set('prompt', options.prompt)
  form.set('size', options.size)
  form.set('n', '1')
  form.set('image', options.image, 'image.png')
  if (options.mask) form.set('mask', options.mask, 'mask.png')

  const url = imageEndpoint(options.provider, true)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  return (await res.json()) as ImageApiResponse
}

async function editViaReference(options: EditImageOptions): Promise<ImageApiResponse> {
  const dataUrl = await blobToDataUrl(options.image)
  const model = options.modelOverride || pickImageModel(options.provider)
  if (options.provider.kind === 'sensenova') {
    return generateJson(
      options,
      {
        model,
        prompt: options.prompt,
        size: options.size,
        response_format: 'b64_json',
        watermark: false,
        prompt_extend: true,
        images: [{ image_url: dataUrl }],
      },
      true,
    )
  }
  const base = {
    model,
    prompt: options.prompt,
    size: options.size,
    n: 1,
  }
  const bodies: Array<Record<string, unknown>> =
    options.provider.kind === 'ark'
      ? [
          { ...base, response_format: 'b64_json', watermark: false, image: [dataUrl] },
          { ...base, response_format: 'b64_json', watermark: false, image: dataUrl },
        ]
      : [
          { ...base, image_size: options.size, image: dataUrl },
          { ...base, image_size: options.size, images: [dataUrl] },
        ]

  let lastError: unknown
  for (const body of bodies) {
    try {
      return await generateJson(options, body)
    } catch (err) {
      lastError = err
      if (!(err instanceof ProviderError) || err.status !== 400) throw err
    }
  }
  throw lastError
}

export async function editImage(options: EditImageOptions): Promise<GeneratedImage> {
  if (providerNeedsUserProxy(options.provider)) {
    throw new ProviderError(
      'cors',
      '该服务商的浏览器预检被上游拒绝；桌面客户端不受此限制。网页版需要自备代理，本站不提供代理。',
      { providerId: options.provider.id },
    )
  }
  if (!options.provider.supportsEdit || !pickImageModel(options.provider)) {
    throw new ProviderError('unsupported', '当前图像模型不支持参考图编辑，将改用网格形变。', {
      providerId: options.provider.id,
    })
  }
  const json =
    options.provider.kind === 'openai-compatible'
      ? await editViaOpenAI(options)
      : await editViaReference(options)
  return decodeResult(json, options.provider.id)
}
