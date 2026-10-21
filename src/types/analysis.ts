export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface VisionPart {
  id: string
  bbox?: BBox
  confidence: number
  notes?: string
}

export interface VisionAnalysis {
  version: 1
  character: {
    apparentAge: 'teen' | 'young-adult' | 'mature'
    genderPresentation: 'feminine' | 'masculine' | 'androgynous'
    style: 'anime-cel' | 'soft-anime' | 'semi-realistic' | 'chibi'
    palette: string[]
  }
  framing: {
    bust: 'head' | 'bust' | 'half'
    facing: 'front' | 'three-quarter'
    yawDeg: number
    centered: boolean
    headFullyVisible: boolean
    symmetry: number
  }
  parts: VisionPart[]
  layerPlan: Array<{
    id: string
    nameZh: string
    z: number
    parent: 'root' | 'body' | 'head'
    motion: string
    strategy: 'parse' | 'derived' | 'generated' | 'patch'
    needsInpaint: boolean
    notes?: string
  }>
  expressionPlan: Array<{
    id: 'blink' | 'mouthOpen' | 'smile' | 'angry' | 'sad'
    mode: 'image-edit' | 'mesh-warp' | 'skip'
    editInstruction: string
    priority: number
  }>
  rigHints: {
    headPivotHint?: { x: number; y: number }
    shoulderLineY?: number
    hairlineY?: number
    chinY?: number
    eyeLineY?: number
  }
  qa: {
    issues: Array<{ code: string; severity: 'info' | 'warn' | 'block'; message: string }>
    overallScore: number
    proceed: boolean
  }
}
