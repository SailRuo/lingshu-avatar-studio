<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    width?: string
    closable?: boolean
  }>(),
  { title: '', width: '560px', closable: true },
)

const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : ''
  },
)

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-overlay" @click.self="closable && emit('close')">
        <section class="modal-card" :style="{ width }" role="dialog" aria-modal="true" :aria-label="title">
          <header class="modal-head">
            <h2 class="modal-title">{{ title }}</h2>
            <button v-if="closable" type="button" class="modal-close" aria-label="关闭" @click="emit('close')">
              <X :size="16" />
            </button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(3, 6, 11, 0.7);
  backdrop-filter: blur(8px);
}

.modal-card {
  max-width: min(100%, 740px);
  max-height: min(88vh, 900px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--av-border-strong);
  border-radius: var(--av-radius-lg);
  background: #101722;
  box-shadow: var(--av-shadow);
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--av-border);
}

.modal-title {
  font-family: var(--av-font-serif);
  font-size: 18px;
}

.modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--av-muted);
}

.modal-close:hover {
  color: var(--av-text);
  background: rgba(255, 255, 255, 0.06);
}

.modal-body {
  padding: 22px;
  overflow: auto;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 22px;
  border-top: 1px solid var(--av-border);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 160ms ease;
}

.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 160ms ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: translateY(8px) scale(0.99);
}
</style>
