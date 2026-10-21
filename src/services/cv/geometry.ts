import type { Point, Rect } from '../../types/character'
import {
  FACE_OVAL_INDICES,
  LEFT_BROW_INDICES,
  LEFT_EYE_INDICES,
  LIPS_OUTER_INDICES,
  RIGHT_BROW_INDICES,
  RIGHT_EYE_INDICES,
  type FaceLandmarkResult,
} from './landmarker'

export interface FaceGeometry {
  width: number
  height: number
  faceOval: Point[]
  faceBBox: Rect
  eyeL: Point[]
  eyeR: Point[]
  eyeLCenter: Point
  eyeRCenter: Point
  mouth: Point[]
  mouthCenter: Point
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

export function computeFaceGeometry(result: FaceLandmarkResult): FaceGeometry {
  const faceOval = pick(result, FACE_OVAL_INDICES)
  const eyeL = pick(result, LEFT_EYE_INDICES)
  const eyeR = pick(result, RIGHT_EYE_INDICES)
  const mouth = pick(result, LIPS_OUTER_INDICES)
  const browL = pick(result, LEFT_BROW_INDICES)
  const browR = pick(result, RIGHT_BROW_INDICES)
  const chin = result.landmarks[152] ?? averagePoints(faceOval)
  const forehead = result.landmarks[10] ?? chin
  const faceCenter = averagePoints([
    result.landmarks[1] ?? chin,
    result.landmarks[168] ?? chin,
    result.landmarks[6] ?? chin,
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
  const headPivot = {
    x: faceCenter.x,
    y: chin.y + faceHeight * 0.14,
  }
  return {
    width: result.width,
    height: result.height,
    faceOval,
    faceBBox,
    eyeL,
    eyeR,
    eyeLCenter,
    eyeRCenter,
    mouth,
    mouthCenter,
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
