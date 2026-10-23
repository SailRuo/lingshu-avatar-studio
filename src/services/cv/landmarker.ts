import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import type { Point } from '../../types/character'

export interface FaceLandmarkResult {
  landmarks: Point[]
  normalized: NormalizedLandmark[]
  width: number
  height: number
}

export const FACE_OVAL_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54,
  103, 67, 109,
]

export const LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144]
export const RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]
// Full lid rings, in the order MediaPipe draws the eye outline. The six-point
// sets above only describe the eye's extent, which is not enough to cut along
// the real lash line.
export const LEFT_EYE_RING_INDICES = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
]
export const RIGHT_EYE_RING_INDICES = [
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
]
export const LIPS_OUTER_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39,
  40, 185,
]
/**
 * The inner lip ring: the edge of the actual mouth opening.
 *
 * The outer ring only describes the outside of the lips, which is enough to cut
 * the mouth layer but not to open it — a mouth that opens has to reveal the
 * cavity behind the lips, and the inner ring is the boundary of that cavity.
 */
export const LIPS_INNER_INDICES = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81,
  80, 191,
]
export const LEFT_BROW_INDICES = [70, 63, 105, 66, 107]
export const RIGHT_BROW_INDICES = [336, 296, 334, 293, 300]

let landmarkerPromise: Promise<FaceLandmarker | null> | null = null

async function createLandmarker(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: '/models/face_landmarker.task',
      delegate,
    },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.35,
    minFacePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })
}

export async function getFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      try {
        return await createLandmarker('GPU')
      } catch (gpuError) {
        console.warn('[avatar] face landmarker GPU failed, retrying CPU', gpuError)
        try {
          return await createLandmarker('CPU')
        } catch (cpuError) {
          console.warn('[avatar] face landmarker unavailable', cpuError)
          return null
        }
      }
    })()
  }
  return landmarkerPromise
}

export async function detectFaceLandmarks(
  source: HTMLCanvasElement,
): Promise<FaceLandmarkResult | null> {
  const landmarker = await getFaceLandmarker()
  if (!landmarker) return null
  try {
    const result = landmarker.detect(source)
    const normalized = result.faceLandmarks?.[0]
    if (!normalized?.length) return null
    return {
      normalized,
      landmarks: normalized.map((point) => ({
        x: point.x * source.width,
        y: point.y * source.height,
      })),
      width: source.width,
      height: source.height,
    }
  } catch (err) {
    console.warn('[avatar] face landmark detection failed', err)
    return null
  }
}
