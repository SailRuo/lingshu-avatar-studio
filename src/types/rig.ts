import type { Point, Rect } from './character'

export type DeformerDef =
  | { type: 'sway'; axis: 'x' | 'y'; amplitude: number; frequency: number; phaseJitter?: number }
  | { type: 'breath'; axis: 'x' | 'y'; amplitude: number; periodMs: number }
  | { type: 'headParallax'; param: string; scale: number }
  | { type: 'paramTranslate'; param: string; axis: 'x' | 'y'; scale: number }
  | { type: 'paramRotate'; param: string; scale: number }
  | { type: 'bend'; param: string; scale: number }
  | { type: 'jaw'; param: string; scale: number }

export interface RigNode {
  id: string
  parent: string | null
  pivot: Point
  depth: number
}

export interface MeshDef {
  cols: number
  rows: number
  falloff: 'top' | 'bottom' | 'none'
  deformers: DeformerDef[]
}

export interface ParamDef {
  id: string
  labelZh: string
  min: number
  max: number
  default: number
  smoothingMs: number
}

export interface BindingDef {
  param: string
  target: { kind: 'node' | 'layer' | 'stateMachine'; id: string; property: string }
  points: Array<[number, number]>
  curve?: 'linear' | 'step'
}

export interface StateDef {
  id: string
  param: string
  textures: Record<string, string>
  crossfadeMs: number
}

export interface MotionDef {
  durationMs: number
  loop: boolean
  tracks: Array<{ param: string; keys: Array<[number, number]> }>
}

/**
 * The deformation field of the mouth.
 *
 * It is computed once when the character is imported and travels with the
 * character pack, so the runtime never has to look at the face landmarks
 * again: it only runs the weighted sum over these weights.
 */
export interface MouthFieldDef {
  cols: number
  rows: number
  /** The area the grid covers, in character coordinates. */
  rect: Rect
  /** Per-vertex weights, one entry per grid vertex. */
  upper: number[]
  lower: number[]
  corner: number[]
  side: number[]
  control: {
    upper: Point
    lower: Point
    cornerL: Point
    cornerR: Point
    innerUpper: Point
    innerLower: Point
  }
}

export interface RigDocument {
  formatVersion: 1
  canvas: { width: number; height: number }
  nodes: RigNode[]
  meshes: Record<string, MeshDef>
  parameters: ParamDef[]
  bindings: BindingDef[]
  states: StateDef[]
  motions: Record<string, MotionDef>
  limits: { angleX: number; angleY: number; angleZ: number }
  /** Present when the character was built with the continuous mouth rig. */
  mouth?: MouthFieldDef
}
