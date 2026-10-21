<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="empty-state">
    <div class="empty-art" aria-hidden="true">
      <span class="empty-card back" />
      <span class="empty-card mid" />
      <span class="empty-card front">
        <span class="empty-eye" />
        <span class="empty-eye" />
        <span class="empty-mouth" />
      </span>
    </div>
    <h3 class="empty-title">{{ title }}</h3>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 54px 22px;
}

.empty-art {
  position: relative;
  width: 118px;
  height: 100px;
  margin-bottom: 18px;
}

.empty-card {
  position: absolute;
  border-radius: 16px;
  border: 1px solid rgba(224, 164, 92, 0.24);
  background: linear-gradient(160deg, rgba(224, 164, 92, 0.13), rgba(125, 211, 252, 0.04));
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
}

.empty-card.back {
  inset: 6px 28px 18px 6px;
  transform: rotate(-7deg);
  opacity: 0.5;
}

.empty-card.mid {
  inset: 10px 8px 10px 26px;
  transform: rotate(6deg);
  opacity: 0.7;
}

.empty-card.front {
  inset: 18px 22px 2px 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: linear-gradient(160deg, #1b2535, #121a27);
}

.empty-eye {
  width: 9px;
  height: 4px;
  border-radius: 999px;
  background: var(--av-accent);
  box-shadow: 0 0 12px rgba(224, 164, 92, 0.5);
}

.empty-mouth {
  position: absolute;
  bottom: 20px;
  left: 50%;
  width: 18px;
  height: 5px;
  border-radius: 0 0 10px 10px;
  border-bottom: 2px solid rgba(240, 210, 170, 0.5);
  transform: translateX(-50%);
}

.empty-title {
  font-family: var(--av-font-serif);
  font-size: 20px;
  margin-bottom: 6px;
}

.empty-desc {
  color: var(--av-muted);
  font-size: 13px;
  max-width: 360px;
}

.empty-action {
  margin-top: 18px;
}
</style>
