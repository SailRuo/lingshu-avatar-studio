import { describe, expect, it } from 'vitest'
import { LayerVisibility, type VisibilityTarget } from '../../src/services/render/layerVisibility'

/** Stands in for a PixiJS Sprite or Mesh: both only expose `visible`. */
function renderable(visible = true): VisibilityTarget {
  return { visible }
}

describe('layer visibility registry', () => {
  it('hides every renderable of a layer, including meshes', () => {
    const visibility = new LayerVisibility()
    // The hair is a mesh, the head is a sprite. Both belong to the stage.
    const hairMesh = visibility.register('hairBack', renderable())
    const headSprite = visibility.register('head', renderable())

    const flags = new Map<string, boolean>([
      ['head', false],
      ['hairBack', false],
    ])
    visibility.apply(null, flags)

    expect(headSprite.visible).toBe(false)
    expect(hairMesh.visible).toBe(false)
  })

  it('hides a mesh layer when another layer is soloed', () => {
    const visibility = new LayerVisibility()
    const hairMesh = visibility.register('hairBack', renderable())
    const bodySprite = visibility.register('body', renderable())

    visibility.apply('body', new Map())

    expect(bodySprite.visible).toBe(true)
    expect(hairMesh.visible).toBe(false)
  })

  it('shows only the soloed layer even when the others are flagged visible', () => {
    const visibility = new LayerVisibility()
    const hairMesh = visibility.register('hairBack', renderable())
    const headSprite = visibility.register('head', renderable())

    visibility.apply('hairBack', new Map([['head', true]]))

    expect(hairMesh.visible).toBe(true)
    expect(headSprite.visible).toBe(false)
  })

  it('hides overlays together with the layer they belong to', () => {
    const visibility = new LayerVisibility()
    const eye = visibility.register('eyeL', renderable())
    const closedEye = visibility.registerOverlay('eyeL', renderable())

    visibility.apply('body', new Map())

    expect(eye.visible).toBe(false)
    expect(closedEye.visible).toBe(false)
  })

  it('reports a renderable that was created but never registered', () => {
    const visibility = new LayerVisibility()
    const registered = visibility.register('head', renderable())
    // A hair mesh that was created but never handed to the registry: this is
    // exactly what keeps the hair on screen when the head is hidden.
    const orphan = renderable()

    const unregistered = visibility.findUnregistered([registered, orphan])

    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]).toBe(orphan)
  })

  it('reports nothing when every renderable is registered', () => {
    const visibility = new LayerVisibility()
    const head = visibility.register('head', renderable())
    const hair = visibility.register('hairBack', renderable())
    const eye = visibility.registerOverlay('eyeL', renderable())

    expect(visibility.findUnregistered([head, hair, eye])).toHaveLength(0)
  })
})
