<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { KeyRound, Settings, ShieldCheck, Sparkles } from 'lucide-vue-next'
import { useProviderStore } from '../../stores/useProviderStore'

const route = useRoute()
const providerStore = useProviderStore()

const nav = [
  { label: '工作室', to: '/', icon: Sparkles },
  { label: '服务商', to: '/settings/providers', icon: KeyRound },
  { label: '设置', to: '/settings/general', icon: Settings },
]

const keyCount = computed(() => providerStore.readyCount)

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  return route.path.startsWith(to)
}
</script>

<template>
  <div class="av-shell">
    <!-- `deep` makes the whole bar draggable (macOS overlay title bar);
         links/buttons inside it stay clickable because Tauri's drag script
         treats clickable tags as `no-drag`. -->
    <header class="shell-header" data-tauri-drag-region="deep">
      <div class="shell-inner">
        <RouterLink to="/" class="brand" aria-label="Avatar Studio 首页">
          <span class="brand-mark" aria-hidden="true">
            <span class="brand-mark-eyes" />
          </span>
          <span class="brand-text">
            <span class="brand-name">Avatar Studio</span>
            <span class="brand-sub">2D 数字人工作室</span>
          </span>
        </RouterLink>

        <nav class="shell-nav" aria-label="主导航">
          <RouterLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="nav-link"
            :class="{ 'is-active': isActive(item.to) }"
          >
            <component :is="item.icon" :size="15" :stroke-width="1.8" />
            {{ item.label }}
          </RouterLink>
        </nav>

        <div class="shell-meta">
          <span class="av-pill local-pill">
            <ShieldCheck :size="13" />
            本地运行 · 无后端
          </span>
          <span class="key-count" :class="{ 'has-keys': keyCount > 0 }">
            <KeyRound :size="13" />
            {{ keyCount }} 个 Key
          </span>
        </div>
      </div>
    </header>

    <main class="av-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell-header {
  position: sticky;
  top: 0;
  z-index: 30;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(8, 12, 19, 0.72);
  backdrop-filter: blur(20px);
}

.shell-inner {
  width: min(var(--av-max), calc(100% - 48px));
  margin: 0 auto;
  height: 70px;
  display: flex;
  align-items: center;
  gap: 28px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.brand-mark {
  position: relative;
  width: 35px;
  height: 35px;
  border-radius: 12px;
  background:
    radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.34), transparent 32%),
    linear-gradient(145deg, #e5b574, #b97738 62%, #6d4422);
  box-shadow: 0 8px 22px rgba(224, 164, 92, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.brand-mark-eyes {
  position: absolute;
  left: 10px;
  top: 14px;
  width: 15px;
  height: 6px;
  border-radius: 999px;
  background:
    radial-gradient(circle at 22% 50%, #2a1a0d 0 2px, transparent 2.5px),
    radial-gradient(circle at 78% 50%, #2a1a0d 0 2px, transparent 2.5px);
  opacity: 0.85;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.brand-name {
  font-family: var(--av-font-serif);
  font-size: 16px;
  letter-spacing: 0.01em;
}

.brand-sub {
  color: var(--av-muted);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.shell-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 13px;
  border-radius: 999px;
  color: var(--av-muted);
  font-size: 13px;
  transition: color 150ms ease, background 150ms ease;
}

.nav-link:hover {
  color: var(--av-text);
  background: rgba(255, 255, 255, 0.045);
}

.nav-link.is-active {
  color: var(--av-accent-strong);
  background: var(--av-accent-soft);
}

.shell-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.local-pill {
  color: var(--av-success);
  background: var(--av-success-soft);
  border-color: rgba(94, 234, 212, 0.16);
}

.key-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-muted);
  font-size: 11px;
}

.key-count.has-keys {
  color: var(--av-accent);
}

@media (max-width: 820px) {
  .shell-inner {
    width: calc(100% - 28px);
    height: auto;
    padding: 13px 0;
    flex-wrap: wrap;
    gap: 12px 18px;
  }

  .shell-nav {
    order: 3;
    width: 100%;
    overflow-x: auto;
  }

  .nav-link {
    padding: 7px 10px;
  }

  .shell-meta {
    margin-left: auto;
  }

  .local-pill {
    display: none;
  }
}
</style>
