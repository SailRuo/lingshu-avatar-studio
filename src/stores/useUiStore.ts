import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
}

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<Toast[]>([])
  let nextId = 1

  function notify(message: string, kind: Toast['kind'] = 'info', duration = 4200) {
    const id = nextId++
    toasts.value = [...toasts.value, { id, message, kind }]
    window.setTimeout(() => dismiss(id), duration)
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  return { toasts, notify, dismiss }
})
