import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const modelsDir = path.join(root, 'public', 'models')
const wasmSource = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmTarget = path.join(root, 'public', 'mediapipe', 'wasm')

const models = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    note: 'MediaPipe Face Landmarker (Apache-2.0)',
  },
  {
    file: 'selfie_multiclass_256x256.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    note: 'MediaPipe Selfie Multiclass Image Segmenter (Apache-2.0)',
  },
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    note: 'MediaPipe Selfie Segmenter fallback (Apache-2.0)',
  },
]

async function sha256(file) {
  const data = await readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

async function main() {
  await mkdir(modelsDir, { recursive: true })
  await mkdir(wasmTarget, { recursive: true })

  if (existsSync(wasmSource)) {
    const { readdir } = await import('node:fs/promises')
    for (const entry of await readdir(wasmSource)) {
      if (!entry.endsWith('.wasm') && !entry.endsWith('.js')) continue
      await copyFile(path.join(wasmSource, entry), path.join(wasmTarget, entry))
    }
    console.log('copied MediaPipe wasm into public/mediapipe/wasm')
  } else {
    console.warn('MediaPipe wasm not found in node_modules yet; run npm install first')
  }

  const lines = ['# Bundled model assets', '']
  for (const model of models) {
    const target = path.join(modelsDir, model.file)
    let size = 0
    try {
      size = (await stat(target)).size
    } catch {
      size = 0
    }
    if (size < 1024) {
      console.log(`downloading ${model.file}`)
      try {
        const res = await fetch(model.url)
        if (!res.ok) throw new Error(`download failed ${model.url}: ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        await writeFile(target, buf)
        size = buf.length
      } catch (error) {
        console.warn(`could not download ${model.file}; the app will fall back to single-portrait mode.`)
        console.warn(error)
        continue
      }
    }
    const hash = await sha256(target)
    lines.push(`- \`${model.file}\` — ${size} bytes — sha256 \`${hash}\``)
    lines.push(`  - source: ${model.url}`)
    lines.push(`  - ${model.note}`)
    console.log(`${model.file}: ${size} bytes ${hash.slice(0, 16)}…`)
  }
  lines.push('', 'These files are downloaded at prepare time and served same-origin at runtime.')
  await writeFile(path.join(modelsDir, 'LICENSES.md'), lines.join('\n'))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
