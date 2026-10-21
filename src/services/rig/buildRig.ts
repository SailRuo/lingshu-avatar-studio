import type {
  CharacterManifest,
  CharacterTier,
  LayerDef,
  LayerId,
  TextureDef,
} from '../../types/character'
import type { FaceGeometry } from '../cv/geometry'
import type { BuiltLayer } from '../imaging/layers'
import type {
  BindingDef,
  MeshDef,
  ParamDef,
  RigDocument,
  StateDef,
} from '../../types/rig'

export interface BuildRigResult {
  manifestLayers: Partial<Record<LayerId, LayerDef>>
  textureDefs: Record<string, TextureDef>
  layerOrder: LayerId[]
  rig: RigDocument
  capabilities: CharacterManifest['capabilities']
}

const PARAMETERS: ParamDef[] = [
  { id: 'ParamAngleX', labelZh: '头部左右', min: -1, max: 1, default: 0, smoothingMs: 140 },
  { id: 'ParamAngleY', labelZh: '头部上下', min: -1, max: 1, default: 0, smoothingMs: 140 },
  { id: 'ParamAngleZ', labelZh: '头部倾斜', min: -1, max: 1, default: 0, smoothingMs: 160 },
  { id: 'ParamBodyAngleX', labelZh: '身体摆动', min: -1, max: 1, default: 0, smoothingMs: 220 },
  { id: 'ParamBreath', labelZh: '呼吸', min: 0, max: 1, default: 0, smoothingMs: 0 },
  { id: 'ParamEyeLOpen', labelZh: '左眼开合', min: 0, max: 1, default: 1, smoothingMs: 40 },
  { id: 'ParamEyeROpen', labelZh: '右眼开合', min: 0, max: 1, default: 1, smoothingMs: 40 },
  { id: 'ParamMouthOpenY', labelZh: '嘴张开', min: 0, max: 1, default: 0, smoothingMs: 45 },
  { id: 'ParamMouthForm', labelZh: '嘴形', min: -1, max: 1, default: 0, smoothingMs: 90 },
]

function meshesFor(layers: BuiltLayer[]): Record<string, MeshDef> {
  const meshes: Record<string, MeshDef> = {}
  for (const layer of layers) {
    if (layer.id === 'hairFront') {
      meshes[layer.id] = {
        cols: 16,
        rows: 24,
        falloff: 'top',
        deformers: [
          { type: 'sway', axis: 'x', amplitude: 5, frequency: 0.32, phaseJitter: 0.4 },
          { type: 'headParallax', param: 'ParamAngleX', scale: 1 },
        ],
      }
    } else if (layer.id === 'hairBack') {
      meshes[layer.id] = {
        cols: 12,
        rows: 20,
        falloff: 'top',
        deformers: [
          { type: 'sway', axis: 'x', amplitude: 3.5, frequency: 0.24, phaseJitter: 0.5 },
        ],
      }
    } else if (layer.id === 'body') {
      meshes[layer.id] = {
        cols: 12,
        rows: 16,
        falloff: 'bottom',
        deformers: [{ type: 'breath', axis: 'y', amplitude: 1.6, periodMs: 4200 }],
      }
    } else if (layer.id === 'head') {
      meshes[layer.id] = {
        cols: 10,
        rows: 12,
        falloff: 'none',
        deformers: [{ type: 'headParallax', param: 'ParamAngleX', scale: 1 }],
      }
    } else {
      meshes[layer.id] = { cols: 4, rows: 4, falloff: 'none', deformers: [] }
    }
  }
  return meshes
}

function bindingsFor(hasBody: boolean): BindingDef[] {
  return [
    {
      param: 'ParamAngleX',
      target: { kind: 'node', id: 'head', property: 'x' },
      points: [
        [-1, -10],
        [0, 0],
        [1, 10],
      ],
    },
    {
      param: 'ParamAngleY',
      target: { kind: 'node', id: 'head', property: 'y' },
      points: [
        [-1, -6],
        [0, 0],
        [1, 6],
      ],
    },
    {
      param: 'ParamAngleZ',
      target: { kind: 'node', id: 'head', property: 'rotation' },
      points: [
        [-1, -0.06],
        [0, 0],
        [1, 0.06],
      ],
    },
    ...(hasBody
      ? [
          {
            param: 'ParamBodyAngleX',
            target: { kind: 'node' as const, id: 'body', property: 'rotation' },
            points: [
              [-1, -0.025],
              [0, 0],
              [1, 0.025],
            ] as Array<[number, number]>,
          },
        ]
      : []),
  ]
}

export function buildRig(
  layers: BuiltLayer[],
  geometry: FaceGeometry,
  tier: CharacterTier,
  width: number,
  height: number,
): BuildRigResult {
  const manifestLayers: Partial<Record<LayerId, LayerDef>> = {}
  const textureDefs: Record<string, TextureDef> = {}

  for (const layer of layers) {
    manifestLayers[layer.id] = {
      id: layer.id,
      nameZh: layer.nameZh,
      z: layer.z,
      parent: layer.parent,
      pivot: layer.pivot,
      offset: { x: layer.bbox.x, y: layer.bbox.y },
      size: { w: layer.bbox.w, h: layer.bbox.h },
      depth: layer.depth,
      opacity: 1,
      defaultTexture: layer.textureId,
      textures: { default: layer.textureId },
    }
    textureDefs[layer.textureId] = {
      file: `layers/${layer.id}.png`,
      bbox: { ...layer.bbox },
    }
  }

  const ordered = [...layers].sort((a, b) => a.z - b.z)
  const hasBody = layers.some((layer) => layer.id === 'body')
  const hasEyes = layers.some((layer) => layer.id === 'eyeL') && layers.some((layer) => layer.id === 'eyeR')
  const hasMouth = layers.some((layer) => layer.id === 'mouth')
  const hasHair = layers.some((layer) => layer.id === 'hairFront' || layer.id === 'hairBack')

  const states: StateDef[] = []
  const rig: RigDocument = {
    formatVersion: 1,
    canvas: { width, height },
    nodes: [
      { id: 'root', parent: null, pivot: { x: width / 2, y: height * 0.94 }, depth: 0 },
      ...(hasBody
        ? [{ id: 'body', parent: 'root', pivot: geometry.bodyPivot, depth: 0.2 }]
        : []),
      {
        id: 'head',
        parent: hasBody ? 'body' : 'root',
        pivot: geometry.headPivot,
        depth: 0.6,
      },
    ],
    meshes: meshesFor(layers),
    parameters: PARAMETERS,
    bindings: bindingsFor(hasBody),
    states,
    motions: {
      idle: {
        durationMs: 6400,
        loop: true,
        tracks: [
          {
            param: 'ParamAngleX',
            keys: [
              [0, 0.08],
              [1600, 0.24],
              [3200, 0.02],
              [4800, -0.2],
              [6400, 0.08],
            ],
          },
          {
            param: 'ParamBodyAngleX',
            keys: [
              [0, 0],
              [1600, 0.14],
              [3200, 0],
              [4800, -0.12],
              [6400, 0],
            ],
          },
        ],
      },
    },
    limits: { angleX: 0.45, angleY: 0.35, angleZ: 0.25 },
  }

  return {
    manifestLayers,
    textureDefs,
    layerOrder: ordered.map((layer) => layer.id),
    rig,
    capabilities: {
      layered: tier !== 'portrait',
      blink: hasEyes ? 'warp' : 'none',
      mouth: hasMouth ? 'warp' : 'none',
      hair: hasHair,
    },
  }
}
