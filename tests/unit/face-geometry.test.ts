import { describe, expect, it } from 'vitest'
import { checkFaceGeometry, type FaceGeometry } from '../../src/services/cv/geometry'

/**
 * A face that looks like a real portrait: 300x360 face box, eyes 130px apart,
 * mouth between the eye line and the chin.
 */
function plausibleFace(): FaceGeometry {
  const faceOval = [
    { x: 350, y: 100 },
    { x: 500, y: 100 },
    { x: 560, y: 260 },
    { x: 500, y: 440 },
    { x: 350, y: 440 },
    { x: 290, y: 260 },
    { x: 340, y: 150 },
    { x: 510, y: 150 },
  ]
  return {
    width: 800,
    height: 1200,
    faceOval,
    faceBBox: { x: 280, y: 90, w: 290, h: 360 },
    eyeL: [],
    eyeR: [],
    eyeLContour: [],
    eyeRContour: [],
    eyeLCenter: { x: 370, y: 250 },
    eyeRCenter: { x: 500, y: 250 },
    mouth: [],
    mouthContour: [],
    lipInner: [],
    mouthCenter: { x: 435, y: 350 },
    mouthUpperMid: { x: 435, y: 340 },
    mouthLowerMid: { x: 435, y: 360 },
    mouthCornerL: { x: 395, y: 350 },
    mouthCornerR: { x: 475, y: 350 },
    mouthInnerUpperMid: { x: 435, y: 348 },
    mouthInnerLowerMid: { x: 435, y: 352 },
    browL: [],
    browR: [],
    chin: { x: 435, y: 440 },
    forehead: { x: 435, y: 100 },
    faceCenter: { x: 435, y: 270 },
    headPivot: { x: 435, y: 490 },
    bodyPivot: { x: 400, y: 1128 },
    eyeLineY: 250,
    chinY: 440,
    faceWidth: 290,
    faceHeight: 360,
  }
}

describe('face geometry plausibility', () => {
  it('accepts a normal portrait', () => {
    expect(checkFaceGeometry(plausibleFace())).toEqual([])
  })

  it('rejects a chin that lands above the eye line', () => {
    const geometry = plausibleFace()
    geometry.chinY = geometry.eyeLineY + 10
    geometry.chin = { x: geometry.chin.x, y: geometry.chinY }
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('chin')
  })

  it('rejects a mouth that is not between the eyes and the chin', () => {
    const geometry = plausibleFace()
    geometry.mouthCenter = { x: 435, y: 200 }
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('mouth')
  })

  it('rejects a face with an impossible aspect ratio', () => {
    const geometry = plausibleFace()
    geometry.faceHeight = 40
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('face-aspect')
  })

  it('rejects eyes that are far too close together', () => {
    const geometry = plausibleFace()
    geometry.eyeLCenter = { x: 430, y: 250 }
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('eye-gap')
  })

  it('rejects a face oval that collapsed to nothing', () => {
    const geometry = plausibleFace()
    geometry.faceOval = [
      { x: 430, y: 260 },
      { x: 440, y: 260 },
      { x: 435, y: 262 },
    ]
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('face-oval')
  })

  it('rejects a face that covers the whole frame', () => {
    const geometry = plausibleFace()
    geometry.faceBBox = { x: 0, y: 0, w: 800, h: 1200 }
    geometry.faceWidth = 800
    geometry.faceHeight = 1200
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('face-coverage')
  })

  it('rejects a face that is a speck in the frame', () => {
    const geometry = plausibleFace()
    geometry.faceBBox = { x: 400, y: 600, w: 20, h: 20 }
    geometry.faceWidth = 20
    geometry.faceHeight = 20
    const codes = checkFaceGeometry(geometry).map((problem) => problem.code)
    expect(codes).toContain('face-coverage')
  })
})
