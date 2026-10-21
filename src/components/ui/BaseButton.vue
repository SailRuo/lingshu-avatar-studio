<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
    block?: boolean
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    loading: false,
    disabled: false,
    type: 'button',
    block: false,
  },
)

defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button
    :type="type"
    class="av-button"
    :class="[`is-${variant}`, `size-${size}`, { 'is-block': block }]"
    :disabled="disabled || loading"
    @click="$emit('click', $event)"
  >
    <LoaderCircle v-if="loading" class="spin" :size="15" />
    <slot v-else name="icon" />
    <span><slot /></span>
  </button>
</template>

<style scoped>
.av-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-weight: 600;
  letter-spacing: 0.01em;
  transition: transform 120ms ease, background 150ms ease, border-color 150ms ease, color 150ms ease;
  white-space: nowrap;
}

.av-button:not(:disabled):active {
  transform: translateY(1px);
}

.av-button:not(:disabled):hover {
  filter: brightness(1.06);
}

.av-button:focus-visible {
  outline: 2px solid rgba(224, 164, 92, 0.7);
  outline-offset: 2px;
}

.size-sm {
  min-height: 30px;
  padding: 0 11px;
  font-size: 12px;
}

.size-md {
  min-height: 38px;
  padding: 0 16px;
  font-size: 13px;
}

.size-lg {
  min-height: 46px;
  padding: 0 22px;
  font-size: 14px;
}

.is-primary {
  color: #22180c;
  background: linear-gradient(145deg, var(--av-accent-strong), #c98945);
  border-color: rgba(255, 221, 172, 0.35);
  box-shadow: 0 10px 28px rgba(224, 164, 92, 0.2);
}

.is-secondary {
  color: var(--av-text-soft);
  background: rgba(255, 255, 255, 0.055);
  border-color: var(--av-border);
}

.is-secondary:not(:disabled):hover {
  color: var(--av-text);
  background: rgba(255, 255, 255, 0.09);
  border-color: var(--av-border-strong);
}

.is-ghost {
  color: var(--av-muted);
  background: transparent;
  border-color: transparent;
}

.is-ghost:not(:disabled):hover {
  color: var(--av-text);
  background: rgba(255, 255, 255, 0.05);
}

.is-danger {
  color: var(--av-danger);
  background: var(--av-danger-soft);
  border-color: rgba(251, 113, 133, 0.22);
}

.av-button:disabled {
  opacity: 0.45;
}

.is-block {
  width: 100%;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
