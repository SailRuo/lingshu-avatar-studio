/**
 * Tracks which renderables belong to which character layer.
 *
 * The stage has to be able to hide or solo any single layer. Every renderable
 * therefore has to be registered with the layer it belongs to — including the
 * hair, which is a mesh rather than a sprite. A renderable that is created but
 * never registered keeps rendering no matter what the switches say.
 */

export interface VisibilityTarget {
  visible: boolean
}

export interface LayerPart {
  nodes: VisibilityTarget[]
  overlays: VisibilityTarget[]
}

export class LayerVisibility {
  private readonly parts = new Map<string, LayerPart>()

  partOf(id: string): LayerPart {
    let entry = this.parts.get(id)
    if (!entry) {
      entry = { nodes: [], overlays: [] }
      this.parts.set(id, entry)
    }
    return entry
  }

  /** Registers a renderable under a layer and returns it, so calls can chain. */
  register<T extends VisibilityTarget>(id: string, target: T): T {
    this.partOf(id).nodes.push(target)
    return target
  }

  /** Registers an overlay (a closed-eye patch, a mouth variant, …). */
  registerOverlay<T extends VisibilityTarget>(id: string, overlay: T): T {
    this.partOf(id).overlays.push(overlay)
    return overlay
  }

  /**
   * Applies the current switches.
   *
   * `soloLayer` wins over the per-layer flags: when a layer is soloed every
   * other layer is hidden, whatever its own flag says.
   */
  apply(soloLayer: string | null, layerVisible: Map<string, boolean>): void {
    for (const [id, entry] of this.parts) {
      const on = soloLayer ? id === soloLayer : layerVisible.get(id) !== false
      for (const node of entry.nodes) node.visible = on
      for (const overlay of entry.overlays) overlay.visible = on
    }
  }

  /** How many renderables are registered under a layer. */
  countOf(id: string): number {
    const entry = this.parts.get(id)
    if (!entry) return 0
    return entry.nodes.length + entry.overlays.length
  }

  /** Layer ids that own at least one renderable. */
  ids(): string[] {
    return [...this.parts.keys()]
  }

  /**
   * Finds renderables that were created but never registered with a layer.
   * These are invisible to the visibility switches and always render.
   */
  findUnregistered(created: VisibilityTarget[]): VisibilityTarget[] {
    const registered = new Set<VisibilityTarget>()
    for (const entry of this.parts.values()) {
      for (const node of entry.nodes) registered.add(node)
      for (const overlay of entry.overlays) registered.add(overlay)
    }
    return created.filter((target) => !registered.has(target))
  }
}
