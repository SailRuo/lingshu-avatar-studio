<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-vue-next'
import { useUiStore } from '../../stores/useUiStore'

const ui = useUiStore()

const icons = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
}
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="toast in ui.toasts" :key="toast.id" class="toast" :class="`is-${toast.kind}`">
        <component :is="icons[toast.kind]" :size="16" class="toast-icon" />
        <span class="toast-text">{{ toast.message }}</span>
        <button type="button" class="toast-close" aria-label="关闭提示" @click="ui.dismiss(toast.id)">
          <X :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  z-index: 120;
  right: 22px;
  bottom: 22px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: min(380px, calc(100vw - 36px));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px 12px 12px 14px;
  border-radius: 13px;
  border: 1px solid var(--av-border-strong);
  background: #151d2b;
  color: var(--av-text-soft);
  box-shadow: var(--av-shadow);
  pointer-events: auto;
}

.toast.is-success {
  border-color: rgba(94, 234, 212, 0.24);
}

.toast.is-error {
  border-color: rgba(251, 113, 133, 0.3);
}

.toast-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--av-accent);
}

.toast.is-success .toast-icon {
  color: var(--av-success);
}

.toast.is-error .toast-icon {
  color: var(--av-danger);
}

.toast-text {
  flex: 1;
  font-size: 12.5px;
  line-height: 1.5;
}

.toast-close {
  border: 0;
  background: transparent;
  color: var(--av-faint);
  padding: 2px;
}

.toast-close:hover {
  color: var(--av-text);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
