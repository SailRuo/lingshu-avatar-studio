<script setup lang="ts">
import { reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ArrowLeft, Check, Eye, EyeOff, LoaderCircle, ShieldCheck } from 'lucide-vue-next'
import type { ProviderConfig } from '../types/provider'
import { createCustomProvider } from '../services/providers/catalog'
import { testProviderConnection } from '../services/providers/connectivity'
import { userMessageForError } from '../services/providers/http'
import { useProviderStore } from '../stores/useProviderStore'
import { useUiStore } from '../stores/useUiStore'
import BaseButton from '../components/ui/BaseButton.vue'
import Field from '../components/ui/Field.vue'

const router = useRouter()
const providers = useProviderStore()
const ui = useUiStore()

const form = reactive({
  label: '',
  baseUrl: '',
  apiKey: '',
  sessionOnly: false,
  accepted: false,
})

const testing = ref(false)
const error = ref('')
const note = ref('')
const showKey = ref(false)

function draftProvider(): ProviderConfig {
  return {
    ...createCustomProvider(),
    label: form.label.trim(),
    baseUrl: form.baseUrl.trim(),
    models: {},
    extra: { defaultVoice: 'alloy' },
  }
}

async function save() {
  error.value = ''
  note.value = ''
  if (!form.label.trim()) {
    error.value = '请填写服务商名称。'
    return
  }
  if (!form.baseUrl.trim()) {
    error.value = '请填写服务商地址（Base URL）。'
    return
  }
  if (!form.apiKey.trim()) {
    error.value = '请填写 API Key。'
    return
  }
  if (!form.accepted) {
    error.value = '请先勾选本机密钥存储说明。'
    return
  }

  testing.value = true
  const draft = draftProvider()
  let keySaved = false
  try {
    note.value = '正在测试联通…'
    const result = await testProviderConnection(draft, form.apiKey.trim())
    await providers.saveKey(draft.id, form.apiKey, form.sessionOnly)
    keySaved = true
    providers.addCustomProvider(draft)
    await providers.refreshKeyPresence()
    ui.notify(result.message || '测试通过，服务商已保存', 'success')
    router.push('/settings/providers')
  } catch (err) {
    if (keySaved) {
      try {
        await providers.deleteKey(draft.id)
        providers.removeProvider(draft.id)
      } catch {
        // The form remains available for a retry.
      }
    }
    note.value = ''
    error.value = userMessageForError(err)
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="create-provider">
    <header class="create-head">
      <div>
        <RouterLink to="/settings/providers" class="back-link">
          <ArrowLeft :size="14" /> 服务商
        </RouterLink>
        <h1 class="create-title av-title">添加服务商</h1>
        <p class="create-sub">OpenAI 兼容接口 · 测试通过后才会保存</p>
      </div>
    </header>

    <div class="create-grid">
      <form class="av-card form-card" @submit.prevent="save">
        <div class="form-head">
          <div>
            <p class="av-kicker">Custom provider</p>
            <h2 class="card-title">连接信息</h2>
          </div>
          <span class="av-pill">OpenAI 兼容</span>
        </div>

        <Field label="服务商名称" for-id="provider-name">
          <input
            id="provider-name"
            v-model="form.label"
            class="av-input"
            placeholder="例如：我的中转服务"
            maxlength="40"
            autocomplete="off"
          />
        </Field>
        <Field
          label="服务商地址"
          for-id="provider-url"
          class="spaced"
          help="填写服务商的 OpenAI 兼容 Base URL，通常以 /v1 结尾；程序会请求 {Base URL}/models 做联通测试。"
        >
          <input
            id="provider-url"
            v-model="form.baseUrl"
            class="av-input av-mono"
            placeholder="https://api.example.com/v1"
            spellcheck="false"
            autocomplete="off"
          />
        </Field>
        <Field label="API Key" for-id="provider-key" class="spaced">
          <div class="key-wrap">
            <input
              id="provider-key"
              v-model="form.apiKey"
              class="av-input av-mono key-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="粘贴服务商提供的 Key"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="key-eye"
              :aria-label="showKey ? '隐藏 Key' : '显示 Key'"
              @click="showKey = !showKey"
            >
              <EyeOff v-if="showKey" :size="15" />
              <Eye v-else :size="15" />
            </button>
          </div>
        </Field>

        <label class="check-row">
          <input v-model="form.sessionOnly" type="checkbox" />
          <span>仅本次会话保存 Key（重启应用后失效）</span>
        </label>
        <label class="check-row warning-check">
          <input v-model="form.accepted" type="checkbox" />
          <span>
            我了解 Key 只保存在此设备；桌面端使用 macOS 安全存储，浏览器版使用本地 IndexedDB。任何能访问此设备配置的人都可能读取，请使用限额 Key。
          </span>
        </label>

        <p v-if="note" class="status-note"><LoaderCircle :size="13" class="spin" /> {{ note }}</p>
        <div v-if="error" class="error-panel">{{ error }}</div>

        <div class="form-actions">
          <RouterLink to="/settings/providers"><BaseButton size="sm">取消</BaseButton></RouterLink>
          <BaseButton type="submit" variant="primary" :loading="testing" :disabled="!form.accepted">
            <template #icon><Check :size="15" /></template>
            测试并保存
          </BaseButton>
        </div>
      </form>

      <aside class="side">
        <div class="av-card side-card">
          <p class="av-kicker">Save gate</p>
          <h2 class="side-title">测不通，就不保存</h2>
          <ul class="rules">
            <li><Check :size="13" /> 请求 <span class="mono">{Base URL}/models</span> 验证地址和 Key。</li>
            <li><Check :size="13" /> 测试失败时，名称、地址和 Key 都不会写入本机。</li>
            <li><Check :size="13" /> 保存后，在「用途配置」里为生图、智能体、语音分别选模型。</li>
          </ul>
        </div>
        <div class="av-card side-card security-card">
          <ShieldCheck :size="17" />
          <p>
            请求由桌面端本机网络层直接发出，不经过任何服务器。Key 只在本机，不会写进角色包。
          </p>
        </div>
        <RouterLink to="/settings/providers" class="side-back"><ArrowLeft :size="13" /> 返回服务商列表</RouterLink>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.create-provider {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.create-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-muted);
  font-size: 11px;
  margin-bottom: 5px;
}

.back-link:hover {
  color: var(--av-accent);
}

.create-title {
  font-size: clamp(30px, 4vw, 42px);
  margin-top: 4px;
}

.create-sub {
  color: var(--av-muted);
  font-size: 12px;
  margin-top: 4px;
}

.create-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  gap: 18px;
  align-items: start;
}

.form-card {
  padding: 20px;
}

.form-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 17px;
}

.card-title {
  font-family: var(--av-font-serif);
  font-size: 21px;
  margin-top: 2px;
}

.spaced {
  margin-top: 13px;
}

.key-wrap {
  position: relative;
}

.key-input {
  padding-right: 38px;
}

.key-eye {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--av-muted);
  padding: 4px;
}

.key-eye:hover {
  color: var(--av-text);
}

.model-section {
  margin-top: 20px;
  padding-top: 17px;
  border-top: 1px solid var(--av-border);
}

.model-title {
  font-size: 13px;
  font-weight: 600;
}

.model-desc {
  color: var(--av-faint);
  font-size: 10.5px;
  line-height: 1.7;
  margin: 4px 0 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.6;
}

.check-row input {
  margin-top: 2px;
  accent-color: var(--av-accent);
  flex-shrink: 0;
}

.warning-check {
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(251, 191, 36, 0.14);
  background: rgba(251, 191, 36, 0.04);
}

.status-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  color: var(--av-accent);
  font-size: 11px;
}

.error-panel {
  margin-top: 12px;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px solid rgba(251, 113, 133, 0.26);
  background: var(--av-danger-soft);
  color: var(--av-text-soft);
  font-size: 12px;
  line-height: 1.7;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.spin {
  animation: spin 900ms linear infinite;
}

.side {
  position: sticky;
  top: 92px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.side-card {
  padding: 16px;
}

.side-title {
  font-family: var(--av-font-serif);
  font-size: 19px;
  margin: 4px 0 10px;
}

.rules {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.65;
}

.rules li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}

.rules svg {
  color: var(--av-success);
  flex-shrink: 0;
  margin-top: 2px;
}

.mono {
  color: var(--av-text-soft);
  font-family: "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
}

.security-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--av-muted);
  font-size: 10.5px;
  line-height: 1.7;
  border-color: rgba(94, 234, 212, 0.14);
  background: rgba(94, 234, 212, 0.035);
}

.security-card svg {
  color: var(--av-success);
  flex-shrink: 0;
  margin-top: 1px;
}

.side-back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-muted);
  font-size: 11px;
  padding: 4px 2px;
}

.side-back:hover {
  color: var(--av-accent);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 980px) {
  .create-grid {
    grid-template-columns: 1fr;
  }

  .side {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .side-card {
    flex: 1;
    min-width: 240px;
  }
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .form-actions {
    flex-wrap: wrap;
  }
}
</style>
