<script setup lang="ts">
import HelpDot from './HelpDot.vue'

defineProps<{
  label: string
  forId?: string
  help?: string
  error?: string
}>()
</script>

<template>
  <div class="field">
    <label class="av-label" :for="forId">
      {{ label }}
      <HelpDot v-if="help" :label="`${label}说明`">{{ help }}</HelpDot>
    </label>
    <slot />
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.field {
  min-width: 0;
}

.field-error {
  margin-top: 6px;
  color: var(--av-danger);
  font-size: 12px;
}
</style>
