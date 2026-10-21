<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Plus,
  ShieldCheck,
  XCircle,
} from 'lucide-vue-next'
import type { ProviderRole } from '../types/provider'
import { useProviderStore } from '../stores/useProviderStore'
import { providerNeedsUserProxy } from '../services/platform/runtime'
import RoleConfigCard from '../components/settings/RoleConfigCard.vue'
import BaseButton from '../components/ui/BaseButton.vue'

const router = useRouter()
const providers = useProviderStore()
const roles: ProviderRole[] = ['image', 'chat', 'tts']

function addCustom() {
  router.push('/settings/providers/new')
}

onMounted(async () => {
  await providers.refreshKeyPresence()
})
</script>

<template>
  <div class="settings-page">
    <header class="settings-head">
      <div>
        <p class="av-kicker">Providers</p>
        <h1 class="settings-title av-title">服务商与密钥</h1>
        <p class="settings-sub">模型请求由本机直接发出。密钥只保存在本机，不经过任何服务器。</p>
      </div>
      <BaseButton size="sm" @click="addCustom">
        <template #icon><Plus :size="14" /></template>
        添加服务商
      </BaseButton>
    </header>

    <section class="privacy-banner">
      <ShieldCheck :size="17" />
      <div>
        <p>桌面端把密钥存进系统安全存储；浏览器版存在本地 IndexedDB。两者都不会写入角色包、不会上传。</p>
        <p>任何能访问此设备配置的人都可能读取密钥，请使用限额 Key，不要在公用电脑保存。</p>
      </div>
    </section>

    <section class="role-section">
      <div class="section-head">
        <div>
          <p class="av-kicker">Usage</p>
          <h2 class="section-title">用途配置</h2>
        </div>
        <span class="av-muted section-note">服务商只保存地址和 Key；每个用途分别选服务商、模型和音色</span>
      </div>
      <div class="role-grid">
        <RoleConfigCard v-for="role in roles" :key="role" :role="role" />
      </div>
    </section>

    <section class="provider-section">
      <div class="section-head">
        <div>
          <p class="av-kicker">Catalog</p>
          <h2 class="section-title">服务商</h2>
        </div>
        <span class="av-muted section-note">{{ providers.providers.length }} 个</span>
      </div>
      <div class="provider-list">
        <RouterLink
          v-for="provider in providers.providers"
          :key="provider.id"
          :to="`/settings/providers/${provider.id}`"
          class="provider-row"
        >
          <span class="provider-mark" :class="{ 'has-key': providers.hasKey(provider.id) }">
            <KeyRound :size="16" />
          </span>
          <span class="provider-main">
            <span class="provider-name">
              {{ provider.label }}
              <span v-if="providerNeedsUserProxy(provider)" class="provider-kind proxy-kind">网页版需代理</span>
            </span>
            <span class="provider-url">{{ provider.baseUrl || '还没有填写 Base URL' }}</span>
          </span>
          <span class="provider-status">
            <template v-if="providers.hasKey(provider.id)">
              <CheckCircle2 :size="14" class="ok-icon" /> Key 已保存
            </template>
            <template v-else>
              <XCircle :size="14" class="missing-icon" /> 未保存 Key
            </template>
          </span>
          <ChevronRight :size="15" class="row-arrow" />
        </RouterLink>
      </div>
      <p class="catalog-note">
        桌面端不受浏览器 CORS 限制；网页版才需要按服务商实测 CORS 能力。网页版遇到跨域限制时，可在服务商详情的高级设置里填写你自己的代理地址。
      </p>
    </section>

    <RouterLink to="/settings/general" class="general-link">
      存储、隐私与数据清理 <ArrowRight :size="13" />
    </RouterLink>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.settings-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.settings-title {
  font-size: clamp(30px, 4vw, 44px);
  margin: 6px 0 7px;
}

.settings-sub {
  color: var(--av-muted);
  font-size: 13px;
}

.privacy-banner {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 13px 15px;
  border-radius: 13px;
  border: 1px solid rgba(94, 234, 212, 0.15);
  background: rgba(94, 234, 212, 0.045);
  color: var(--av-muted);
  font-size: 11.5px;
  line-height: 1.7;
}

.privacy-banner svg {
  color: var(--av-success);
  flex-shrink: 0;
  margin-top: 1px;
}

.privacy-banner p + p {
  margin-top: 2px;
}

.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.section-title {
  font-family: var(--av-font-serif);
  font-size: 23px;
  margin-top: 3px;
}

.section-note {
  font-size: 11px;
  text-align: right;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.provider-list {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--av-radius);
  border: 1px solid var(--av-border);
  background: var(--av-panel);
}

.provider-row {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 13px 15px;
  border-bottom: 1px solid var(--av-border);
  transition: background 140ms ease;
}

.provider-row:last-child {
  border-bottom: 0;
}

.provider-row:hover {
  background: rgba(255, 255, 255, 0.035);
}

.provider-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--av-faint);
  flex-shrink: 0;
}

.provider-mark.has-key {
  color: var(--av-success);
  border-color: rgba(94, 234, 212, 0.2);
  background: var(--av-success-soft);
}

.provider-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.provider-name {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
}

.provider-kind {
  color: var(--av-faint);
  font-size: 9px;
  font-weight: 400;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--av-border);
}

.provider-kind.proxy-kind {
  color: var(--av-warning);
  border-color: rgba(251, 191, 36, 0.2);
  background: rgba(251, 191, 36, 0.06);
}

.provider-url {
  color: var(--av-faint);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 600px;
}

.provider-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--av-muted);
}

.ok-icon {
  color: var(--av-success);
}

.missing-icon {
  color: var(--av-faint);
}

.row-arrow {
  color: var(--av-faint);
  flex-shrink: 0;
}

.catalog-note {
  color: var(--av-faint);
  font-size: 11px;
  line-height: 1.7;
  margin-top: 10px;
}

.general-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-muted);
  font-size: 12px;
  width: fit-content;
}

.general-link:hover {
  color: var(--av-accent);
}

@media (max-width: 1100px) {
  .role-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .settings-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .section-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .section-note {
    text-align: left;
  }

  .provider-row {
    flex-wrap: wrap;
  }

  .provider-status {
    margin-left: 47px;
  }
}
</style>
