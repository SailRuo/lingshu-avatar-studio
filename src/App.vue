<script setup lang="ts">
import { RouterView } from 'vue-router'
import AppShell from './components/layout/AppShell.vue'
import ToastHost from './components/ui/ToastHost.vue'
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
  <ToastHost />
</template>
