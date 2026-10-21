<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { CharacterManifest } from '../../types/character'
import type { RigDocument } from '../../types/rig'
import type { MouthShape } from '../../services/audio/viseme'
import { createStageRuntime, type StageHandle } from '../../services/render/StageRuntime'

const props = defineProps<{
  manifest: CharacterManifest
  rig: RigDocument
  layers: Record<string, Blob>
}>()

const emit = defineEmits<{
  ready: [stage: StageHandle]
  error: [error: unknown]
}>()

const host = ref<HTMLElement | null>(null)
const stage = shallowRef<StageHandle | null>(null)
const failed = ref(false)
const fallbackUrl = ref<string | null>(null)

onMounted(async () => {
  if (!host.value) return
  try {
    stage.value = await createStageRuntime({
      host: host.value,
      manifest: props.manifest,
      rig: props.rig,
      layers: props.layers,
    })
    emit('ready', stage.value)
  } catch (err) {
    console.warn('[avatar] stage init failed', err)
    failed.value = true
    emit('error', err)
    const blob =
      props.layers.head ??
      props.layers.body ??
      Object.values(props.layers)[0]
    if (blob) fallbackUrl.value = URL.createObjectURL(blob)
  }
})

onBeforeUnmount(() => {
  stage.value?.destroy()
  stage.value = null
  if (fallbackUrl.value) URL.revokeObjectURL(fallbackUrl.value)
})

defineExpose({
  setMouthOpen(value: number) {
    stage.value?.setMouthOpen(value)
  },
  setMouthShape(shape: MouthShape) {
    stage.value?.setMouthShape(shape)
  },
  setLayerVisible(layerId: string, visible: boolean) {
    stage.value?.setLayerVisible(layerId, visible)
  },
  setSoloLayer(layerId: string | null) {
    stage.value?.setSoloLayer(layerId)
  },
  blink() {
    stage.value?.blink()
  },
  setParams(partial: Record<string, number>) {
    stage.value?.setParams(partial)
  },
  setExpression(id: string) {
    stage.value?.setExpression(id)
  },
  playMotion(id: string) {
    stage.value?.playMotion(id)
  },
})
</script>

<template>
  <div ref="host" class="avatar-stage" :class="{ 'is-failed': failed }">
    <img v-if="failed && fallbackUrl" :src="fallbackUrl" class="stage-fallback" alt="" />
    <div v-if="failed" class="stage-fallback-note">当前环境无法初始化舞台，已切换为静态预览。</div>
  </div>
</template>

<style scoped>
.avatar-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 76%, rgba(224, 164, 92, 0.12), transparent 42%),
    radial-gradient(ellipse at 50% 22%, rgba(125, 211, 252, 0.06), transparent 48%),
    linear-gradient(180deg, rgba(10, 15, 24, 0.25), rgba(7, 10, 16, 0.72));
}

.avatar-stage::before {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 8%;
  width: 58%;
  height: 45px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(224, 164, 92, 0.16), transparent 70%);
  filter: blur(10px);
  pointer-events: none;
}

.avatar-stage :deep(canvas) {
  position: relative;
  z-index: 1;
}

.stage-fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  z-index: 1;
}

.stage-fallback-note {
  position: absolute;
  left: 50%;
  bottom: 12px;
  z-index: 2;
  transform: translateX(-50%);
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--av-border);
  background: rgba(8, 12, 19, 0.78);
  color: var(--av-muted);
  font-size: 11px;
  white-space: nowrap;
}
</style>
