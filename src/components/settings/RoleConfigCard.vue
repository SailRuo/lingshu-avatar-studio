<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Image, RefreshCw, ScanFace, Volume2 } from 'lucide-vue-next'
import type { ProviderRole } from '../../types/provider'
import { providerNeedsUserProxy } from '../../services/platform/runtime'
import { useProviderStore } from '../../stores/useProviderStore'
import HelpDot from '../ui/HelpDot.vue'

const props = withDefaults(
  defineProps<{
    role: ProviderRole
    compact?: boolean
  }>(),
  { compact: false },
)

const providers = useProviderStore()

const meta = {
  image: {
    label: '生图',
    desc: '角色立绘与参考图编辑',
    help: '生图模型同时用于生成和改图；模型不支持改图时会自动降级为网格形变。',
    icon: Image,
  },
  chat: {
    label: '智能体',
    desc: '看图规划与舞台聊天',
    help: '必须支持图片输入；同一个模型负责看图和聊天。',
    icon: ScanFace,
  },
  tts: {
    label: '语音',
    desc: '朗读与口型',
    help: '模型和音色都由服务商提供；音色 ID 可留空使用服务商默认音色。',
    icon: Volume2,
  },
} as const

const info = meta[props.role]
const manualEntry = ref(false)

const availableProviders = computed(() =>
  providers.providers.filter((item) => providers.hasKey(item.id) && !!item.baseUrl.trim()),
)

const providerId = computed({
  get: () => {
    const bound = providers.bindings[props.role] ?? ''
    return availableProviders.value.some((item) => item.id === bound) ? bound : ''
  },
  set: (value: string) => providers.setBinding(props.role, value || undefined),
})

const provider = computed(() => providers.providerById(providerId.value))
const model = computed({
  get: () => (provider.value ? providers.roleModel(props.role) : ''),
  set: (value: string) => providers.setRoleModel(props.role, value),
})
const voice = computed({
  get: () => (provider.value ? providers.roleVoiceValue() : ''),
  set: (value: string) => providers.setRoleVoice(value, provider.value?.id),
})
/** Fish names its voices after the model, every other provider after a voice. */
const voiceLabel = computed(() =>
  provider.value?.kind === 'fishaudio' ? '音色模型 ID' : '音色 ID',
)
const voicePlaceholder = computed(() =>
  provider.value?.kind === 'fishaudio'
    ? 'Fish 广场的模型 ID，留空用默认音色'
    : '可留空使用服务商默认音色',
)
const models = computed(() => providers.modelLists[providerId.value] ?? [])
const modelsLoading = computed(() => !!providers.modelLoading[providerId.value])
const modelError = computed(() => providers.modelErrors[providerId.value] ?? '')
const hasKey = computed(() => !!provider.value && providers.hasKey(provider.value.id))
const ready = computed(() => providers.isRoleReady(props.role))
const modelChoices = computed(() => {
  const ids = models.value
  return model.value && !ids.includes(model.value) ? [model.value, ...ids] : ids
})
const showModelList = computed(() => !!provider.value && !!models.value.length && !manualEntry.value)

const statusText = computed(() => {
  if (!availableProviders.value.length) return '未配置服务商'
  if (!provider.value) return '未选择服务商'
  if (!model.value) return '缺模型'
  if (providerNeedsUserProxy(provider.value)) return '网页版需代理'
  return '已就绪'
})

function pickModel(ids: string[]): string {
  const patterns =
    props.role === 'image'
      ? ['image', 'seedream', 'kolors', 'u1.5', 'flux', 'dall-e']
      : props.role === 'chat'
        ? ['vl', 'vision', '4o', 'gemini', 'qwen', 'doubao', '4v', 'sense']
        : ['tts', 'speech', 'cosyvoice', 'audio']
  return ids.find((id) => patterns.some((pattern) => id.toLowerCase().includes(pattern))) ?? ''
}

async function refreshModels(force = false) {
  if (!providerId.value || !hasKey.value) return
  const ids = await providers.loadModels(providerId.value, force)
  if (!ids.length) return
  if (!providers.roleModels[props.role] && !providers.roleModel(props.role)) {
    const picked = pickModel(ids)
    if (picked) providers.setRoleModel(props.role, picked)
  }
}

function onProviderChange(event: Event) {
  manualEntry.value = false
  providerId.value = (event.target as HTMLSelectElement).value
  void refreshModels(false)
}

function onModelChange(event: Event) {
  model.value = (event.target as HTMLSelectElement).value
}

onMounted(() => {
  if (providerId.value && hasKey.value) void refreshModels(false)
})

watch(
  () => [providerId.value, providers.keyPresence[providerId.value]],
  () => {
    if (providerId.value && hasKey.value) void refreshModels(false)
  },
)
</script>

<template>
  <div class="role-config" :class="{ compact }">
    <div class="role-head">
      <span class="role-icon"><component :is="info.icon" :size="16" /></span>
      <div class="role-title-wrap">
        <p class="role-title">
          {{ info.label }}
          <HelpDot :label="`${info.label}说明`">{{ info.help }}</HelpDot>
        </p>
        <p class="role-desc">{{ info.desc }}</p>
      </div>
      <span class="av-pill role-status" :class="{ 'is-ok': ready }">{{ statusText }}</span>
    </div>

    <div class="role-fields">
      <label class="role-field">
        <span>服务商</span>
        <select
          class="av-select"
          :value="providerId"
          :disabled="!availableProviders.length"
          @change="onProviderChange"
        >
          <option value="">{{ availableProviders.length ? '未选择' : '暂无可用服务商' }}</option>
          <option v-for="item in availableProviders" :key="item.id" :value="item.id">
            {{ item.label }}{{ providerNeedsUserProxy(item) ? '（网页版需代理）' : '' }}
          </option>
        </select>
      </label>

      <div class="role-field">
        <span class="field-label-row">
          模型
          <span class="model-tools">
            <span v-if="models.length" class="model-count">{{ models.length }} 个</span>
            <button
              v-if="models.length"
              type="button"
              class="model-mode"
              @click="manualEntry = !manualEntry"
            >
              {{ manualEntry ? '列表' : '手动' }}
            </button>
            <button
              type="button"
              class="refresh-models"
              :disabled="!providerId || !hasKey || modelsLoading"
              @click="refreshModels(true)"
            >
              <RefreshCw :size="11" :class="{ spin: modelsLoading }" />
              {{ modelsLoading ? '获取中' : models.length ? '刷新' : '获取' }}
            </button>
          </span>
        </span>
        <select
          v-if="showModelList"
          class="av-select av-mono"
          :value="model"
          :disabled="!provider"
          @change="onModelChange"
        >
          <option value="" disabled>选择模型</option>
          <option v-for="id in modelChoices" :key="id" :value="id">{{ id }}</option>
        </select>
        <input
          v-else
          v-model="model"
          class="av-input av-mono"
          placeholder="模型 ID"
          autocomplete="off"
          spellcheck="false"
          :disabled="!provider"
        />
      </div>

      <label v-if="role === 'tts'" class="role-field">
        <span>{{ voiceLabel }}</span>
        <input
          v-model="voice"
          class="av-input av-mono"
          :placeholder="voicePlaceholder"
          autocomplete="off"
          spellcheck="false"
          :disabled="!provider"
        />
      </label>
    </div>

    <p v-if="!availableProviders.length" class="role-hint">
      还没有可用服务商。先添加服务商并测试通过，这里才会出现。
      <RouterLink to="/settings/providers">去配置</RouterLink>
    </p>
    <p v-else-if="modelError" class="role-note">{{ modelError }}</p>
  </div>
</template>

<style scoped>
.role-config {
  padding: 15px;
  border-radius: 14px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.022);
  min-width: 0;
}

.role-config.compact {
  padding: 12px;
  border-radius: 12px;
}

.role-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.role-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--av-accent-soft);
  color: var(--av-accent);
  flex-shrink: 0;
}

.role-title-wrap {
  flex: 1;
  min-width: 0;
}

.role-title {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12.5px;
  font-weight: 600;
}

.role-desc {
  color: var(--av-faint);
  font-size: 10px;
  margin-top: 1px;
}

.role-status {
  flex-shrink: 0;
  padding: 3px 7px;
  font-size: 9px;
}

.role-fields {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 12px;
}

.role-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.role-field > span:first-child,
.field-label-row {
  color: var(--av-muted);
  font-size: 10px;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.refresh-models {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  color: var(--av-accent);
  font-size: 9px;
  padding: 0;
}

.refresh-models:disabled {
  color: var(--av-faint);
}

.model-tools {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.model-count {
  color: var(--av-faint);
  font-size: 9px;
}

.model-mode {
  border: 0;
  background: transparent;
  color: var(--av-muted);
  font-size: 9px;
  padding: 0;
}

.model-mode:hover {
  color: var(--av-accent);
}

.role-config.compact .role-fields {
  margin-top: 9px;
}

.role-note {
  margin-top: 8px;
  color: var(--av-warning);
  font-size: 9.5px;
  line-height: 1.55;
}

.role-hint {
  margin-top: 8px;
  color: var(--av-faint);
  font-size: 9.5px;
  line-height: 1.55;
}

.role-hint a {
  color: var(--av-accent);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

:deep(.av-select),
:deep(.av-input) {
  padding-top: 8px;
  padding-bottom: 8px;
  font-size: 11.5px;
}
</style>
