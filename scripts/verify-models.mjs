import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  'public/models/face_landmarker.task',
  'public/models/selfie_multiclass_256x256.tflite',
  'public/mediapipe/wasm',
]

let failed = false
for (const rel of required) {
  const target = path.join(root, rel)
  if (!existsSync(target)) {
    console.error(`missing: ${rel}`)
    failed = true
    continue
  }
  const info = await stat(target)
  if (info.isFile() && info.size < 1024) {
    console.error(`too small: ${rel}`)
    failed = true
  } else {
    console.log(`ok: ${rel}`)
  }
}
process.exitCode = failed ? 1 : 0
