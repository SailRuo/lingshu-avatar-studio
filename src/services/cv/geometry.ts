import type { Point, Rect } from '../../types/character'
import {
  FACE_OVAL_INDICES,
  LEFT_BROW_INDICES,
  LEFT_EYE_INDICES,
  LEFT_EYE_RING_INDICES,
  LIPS_INNER_INDICES,
  LIPS_OUTER_INDICES,
  RIGHT_BROW_INDICES,
  RIGHT_EYE_INDICES,
  RIGHT_EYE_RING_INDICES,
  type FaceLandmarkResult,
} from './landmarker'

export interface FaceGeometry {
  width: number
  height: number
  faceOval: Point[]
  faceBBox: Rect
  eyeL: Point[]
  eyeR: Point[]
  eyeLContour: Point[]
  eyeRContour: Point[]
  eyeLCenter: Point
  eyeRCenter: Point
  mouth: Point[]
  mouthContour: Point[]
  /** The inner lip ring: the edge of the actual mouth opening. */
  lipInner: Point[]
  mouthCenter: Point
  /** Mid point of the outer upper lip. */
  mouthUpperMid: Point
  /** Mid point of the outer lower lip. */
  mouthLowerMid: Point
  /** Left mouth corner (smaller x). */
  mouthCornerL: Point
  /** Right mouth corner (larger x). */
  mouthCornerR: Point
  /** Mid point of the inner upper lip. */
  mouthInnerUpperMid: Point
  /** Mid point of the inner lower lip. */
  mouthInnerLowerMid: Point
  browL: Point[]
  browR: Point[]
  chin: Point
  forehead: Point
  faceCenter: Point
  headPivot: Point
  bodyPivot: Point
  eyeLineY: number
  chinY: number
  faceWidth: number
  faceHeight: number
}

export function averagePoints(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 }
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / points.length, y: y / points.length }
}

export function bboxFromPoints(points: Point[], padding = 0): Rect {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2,
  }
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

export function expandRect(rect: Rect, ratio: number, minPad = 0): Rect {
  const padX = Math.max(minPad, rect.w * ratio)
  const padY = Math.max(minPad, rect.h * ratio)
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    w: rect.w + padX * 2,
    h: rect.h + padY * 2,
  }
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = clamp(rect.x, 0, width - 1)
  const y = clamp(rect.y, 0, height - 1)
  const right = clamp(rect.x + rect.w, x + 1, width)
  const bottom = clamp(rect.y + rect.h, y + 1, height)
  return { x, y, w: right - x, h: bottom - y }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pick(result: FaceLandmarkResult, indices: number[]): Point[] {
  return indices.map((index) => result.landmarks[index]).filter(Boolean)
}

/**
 * The corners and the two arcs of a lip ring.
 *
 * The ring is cut at its two horizontal extremes — the corners of the mouth —
 * which leaves the two arcs of the lips. Which of them is the upper one is
 * decided by their height, not by the order of the landmarks: the landmark
 * numbering of the lip rings is not something to rely on.
 */
function lipShape(points: Point[]):
  | { upper: Point; lower: Point; cornerL: Point; cornerR: Point }
  | null {
  if (points.length < 6) return null
  let leftIndex = 0
  let rightIndex = 0
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x < points[leftIndex].x) leftIndex = i
    if (points[i].x > points[rightIndex].x) rightIndex = i
  }
  const centerX = (points[leftIndex].x + points[rightIndex].x) / 2
  const arcA: Point[] = []
  const arcB: Point[] = []
  for (let i = leftIndex; ; i = (i + 1) % points.length) {
    arcA.push(points[i])
    if (i === rightIndex) break
  }
  for (let i = rightIndex; ; i = (i + 1) % points.length) {
    arcB.push(points[i])
    if (i === leftIndex) break
  }
  const midOf = (arc: Point[]): Point =>
    arc.reduce((best, point) =>
      Math.abs(point.x - centerX) < Math.abs(best.x - centerX) ? point : best,
    )
  const a = midOf(arcA)
  const b = midOf(arcB)
  return {
    upper: a.y <= b.y ? a : b,
    lower: a.y <= b.y ? b : a,
    cornerL: points[leftIndex],
    cornerR: points[rightIndex],
  }
}

export function computeFaceGeometry(result: FaceLandmarkResult): FaceGeometry {
  const faceOval = pick(result, FACE_OVAL_INDICES)
  const eyeL = pick(result, LEFT_EYE_INDICES)
  const eyeR = pick(result, RIGHT_EYE_INDICES)
  const eyeLContour = pick(result, LEFT_EYE_RING_INDICES)
  const eyeRContour = pick(result, RIGHT_EYE_RING_INDICES)
  const mouth = pick(result, LIPS_OUTER_INDICES)
  const mouthContour = [...mouth]
  const lipInner = pick(result, LIPS_INNER_INDICES)
  const browL = pick(result, LEFT_BROW_INDICES)
  const browR = pick(result, RIGHT_BROW_INDICES)
  const rawChin = result.landmarks[152] ?? averagePoints(faceOval)
  const forehead = result.landmarks[10] ?? rawChin
  const faceCenter = averagePoints([
    result.landmarks[1] ?? rawChin,
    result.landmarks[168] ?? rawChin,
    result.landmarks[6] ?? rawChin,
  ])
  const eyeLCenter = averagePoints(eyeL)
  const eyeRCenter = averagePoints(eyeR)
  const mouthCenter = averagePoints(mouth)
  const eyeLineY = (eyeLCenter.y + eyeRCenter.y) / 2
  const faceBBoxRaw = unionRect(
    bboxFromPoints(faceOval, 4),
    unionRect(bboxFromPoints([...eyeL, ...eyeR, ...browL, ...browR], 4), bboxFromPoints(mouth, 4)),
  )
  const faceBBox = clampRect(expandRect(faceBBoxRaw, 0.08, 6), result.width, result.height)
  const faceWidth = Math.max(24, faceBBox.w)
  const faceHeight = Math.max(24, faceBBox.h)
  // A chin landmark that lands above the eye line would put the head/body
  // split in the middle of the face. Keep it inside the lower half of the
  // face box so a bad detection cannot move the cut above the mouth.
  const chin = {
    x: rawChin.x,
    y: clamp(rawChin.y, faceBBox.y + faceHeight * 0.35, result.height - 1),
  }
  const headPivot = {
    x: faceCenter.x,
    y: chin.y + faceHeight * 0.14,
  }
  // Lip control points. The rings are cut at their two extremes, which are
  // the corners of the mouth, and the two arcs that are left are the upper
  // and the lower lip.
  const outerArcs = lipShape(mouth)
  const innerArcs = lipShape(lipInner)
  const mouthUpperMid = outerArcs?.upper ?? mouthCenter
  const mouthLowerMid = outerArcs?.lower ?? mouthCenter
  const mouthCornerL = outerArcs?.cornerL ?? mouthCenter
  const mouthCornerR = outerArcs?.cornerR ?? mouthCenter
  const mouthInnerUpperMid = innerArcs?.upper ?? mouthUpperMid
  const mouthInnerLowerMid = innerArcs?.lower ?? mouthLowerMid
  return {
    width: result.width,
    height: result.height,
    faceOval,
    faceBBox,
    eyeL,
    eyeR,
    eyeLContour,
    eyeRContour,
    eyeLCenter,
    eyeRCenter,
    mouth,
    mouthContour,
    lipInner,
    mouthCenter,
    mouthUpperMid,
    mouthLowerMid,
    mouthCornerL,
    mouthCornerR,
    mouthInnerUpperMid,
    mouthInnerLowerMid,
    browL,
    browR,
    chin,
    forehead,
    faceCenter,
    headPivot,
    bodyPivot: { x: result.width / 2, y: result.height * 0.94 },
    eyeLineY,
    chinY: chin.y,
    faceWidth,
    faceHeight,
  }
}

export interface FaceGeometryProblem {
  code: string
  message: string
}

function polygonAreaOf(points: Point[]): number {
  if (points.length < 3) return 0
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    sum += points[j].x * points[i].y - points[i].x * points[j].y
  }
  return Math.abs(sum) / 2
}

/**
 * Checks that a detected face is actually a face.
 *
 * The landmarker happily locks onto something that only looks like a face:
 * a brush stroke, a fold of clothing, a hand. Everything derived from such a
 * detection — the head/body split, the eye and mouth overlays, the runtime
 * head mask — is then placed wrong, and the character comes out broken
 * instead of falling back to a flat portrait.
 *
 * Returns the problems it found; an empty list means the face is plausible.
 */
export function checkFaceGeometry(geometry: FaceGeometry): FaceGeometryProblem[] {
  const problems: FaceGeometryProblem[] = []
  const { faceOval, faceBBox, faceWidth, faceHeight } = geometry

  if (faceOval.length < 8) {
    problems.push({ code: 'face-oval', message: '人脸轮廓关键点不足。' })
  } else {
    const ovalArea = polygonAreaOf(faceOval)
    const boxArea = faceBBox.w * faceBBox.h
    if (boxArea > 0 && ovalArea < boxArea * 0.35) {
      problems.push({ code: 'face-oval-area', message: '人脸轮廓塌陷，几乎没有面积。' })
    }
  }

  // The chin has to sit below the eye line, otherwise the head/body split
  // lands in the middle of the face.
  if (geometry.chinY <= geometry.eyeLineY + faceHeight * 0.25) {
    problems.push({ code: 'chin', message: '下巴关键点位置异常，落在眼线附近。' })
  }
  if (
    geometry.chinY < faceBBox.y ||
    geometry.chinY > faceBBox.y + faceBBox.h
  ) {
    problems.push({ code: 'chin-bounds', message: '下巴关键点落在人脸包围盒之外。' })
  }

  // The mouth has to sit between the eyes and the chin.
  if (
    geometry.mouthCenter.y <= geometry.eyeLineY ||
    geometry.mouthCenter.y >= geometry.chinY
  ) {
    problems.push({ code: 'mouth', message: '嘴部关键点不在眼线与下巴之间。' })
  }

  const aspect = faceHeight / Math.max(1, faceWidth)
  if (aspect < 0.9 || aspect > 2.4) {
    problems.push({ code: 'face-aspect', message: '人脸长宽比异常。' })
  }

  const eyeGap = Math.abs(geometry.eyeLCenter.x - geometry.eyeRCenter.x)
  const gapRatio = eyeGap / Math.max(1, faceWidth)
  if (gapRatio < 0.25 || gapRatio > 0.85) {
    problems.push({ code: 'eye-gap', message: '双眼间距异常。' })
  }

  const eyeMidX = (geometry.eyeLCenter.x + geometry.eyeRCenter.x) / 2
  if (Math.abs(eyeMidX - geometry.faceCenter.x) > faceWidth * 0.22) {
    problems.push({ code: 'eye-center', message: '双眼中线明显偏离人脸中心。' })
  }

  // A face that covers almost nothing, or the whole picture, is a detection
  // artefact rather than a portrait.
  const frameArea = Math.max(1, geometry.width * geometry.height)
  const coverage = (faceBBox.w * faceBBox.h) / frameArea
  if (coverage < 0.01 || coverage > 0.6) {
    problems.push({ code: 'face-coverage', message: '人脸在画面中的占比异常。' })
  }

  if (
    faceBBox.x < -1 ||
    faceBBox.y < -1 ||
    faceBBox.x + faceBBox.w > geometry.width + 1 ||
    faceBBox.y + faceBBox.h > geometry.height + 1
  ) {
    problems.push({ code: 'face-bounds', message: '人脸包围盒超出画面。' })
  }

  return problems
}
