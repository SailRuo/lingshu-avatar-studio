<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { CircleHelp } from 'lucide-vue-next'

defineProps<{ label?: string }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDocClick(event: MouseEvent) {
  if (!open.value) return
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <span ref="root" class="help-root">
    <button
      type="button"
      class="av-help"
      :aria-label="label || '查看说明'"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <CircleHelp :size="12" />
    </button>
    <Transition name="pop">
      <span v-if="open" class="help-pop" role="tooltip">
        <slot />
      </span>
    </Transition>
  </span>
</template>

<style scoped>
.help-root {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

.help-pop {
  position: absolute;
  z-index: 60;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 260px;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--av-border-strong);
  background: #151d2b;
  color: var(--av-text-soft);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.55;
  box-shadow: var(--av-shadow-soft);
}

.pop-enter-active,
.pop-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -3px);
}
</style>
