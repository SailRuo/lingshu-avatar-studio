<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, ShieldAlert, Trash2 } from 'lucide-vue-next'
import { useProviderStore } from '../stores/useProviderStore'
import { useUiStore } from '../stores/useUiStore'
import { testProviderConnection } from '../services/providers/connectivity'
import { userMessageForError } from '../services/providers/http'
import { providerNeedsUserProxy } from '../services/platform/runtime'
import { isNativeRuntime } from '../services/platform/bridge'
import BaseButton from '../components/ui/BaseButton.vue'
import Field from '../components/ui/Field.vue'
import Modal from '../components/ui/Modal.vue'

const route = useRoute()
const router = useRouter()
const providers = useProviderStore()
const ui = useUiStore()

const providerId = computed(() => String(route.params.id || ''))
const provider = computed(() => providers.providerById(providerId.value))
const hasKey = computed(() => providers.hasKey(providerId.value))

const config = reactive({
  label: '',
  baseUrl: '',
  proxyUrl: '',
  referenceId: '',
  latency: 'balanced',
})

const apiKey = ref('')
const showKey = ref(false)
const accepted = ref(false)
const sessionOnly = ref(false)
const saving = ref(false)
const error = ref('')
const note = ref('')
const showDelete = ref(false)

/** Fish speaks through its own live protocol instead of an OpenAI-style API. */
const isFish = computed(() => provider.value?.kind === 'fishaudio')
const latencyOptions = [
  { value: 'low_latency', label: '低延迟（更快，音质略低）' },
  { value: 'balanced', label: '均衡（默认）' },
  { value: 'high_quality', label: '高音质（更慢）' },
]

function sync() {
  const current = provider.value
  if (!current) return
  config.label = current.label
  config.baseUrl = current.baseUrl
  config.proxyUrl = current.proxyUrl ?? ''
  config.referenceId = current.extra.referenceId ?? ''
  config.latency = current.extra.latency || 'balanced'
  error.value = ''
  note.value = ''
}

function candidateProvider() {
  const current = provider.value!
  return {
    ...current,
    label: config.label.trim() || current.label,
    baseUrl: config.baseUrl.trim(),
    proxyUrl: config.proxyUrl.trim() || undefined,
    extra: {
      ...current.extra,
      referenceId: config.referenceId.trim(),
      latency: config.latency,
    },
  }
}

async function saveProvider() {
  if (!provider.value) return
  error.value = ''
  note.value = ''
  if (!config.label.trim()) {
    error.value = '请填写服务商名称。'
    return
  }
  if (!config.baseUrl.trim()) {
    error.value = '请填写服务商地址（Base URL）。'
    return
  }
  const newKey = apiKey.value.trim()
  if (newKey && !accepted.value) {
    error.value = '保存新 Key 前，请先勾选本机密钥存储说明。'
    return
  }
  const key = newKey || (await providers.getKey(provider.value.id))
  if (!key) {
    error.value = '请填写 API Key；保存前需要先测试联通。'
    return
  }

  saving.value = true
  try {
    note.value = '正在测试联通…'
    const result = await testProviderConnection(candidateProvider(), key)
    providers.updateProvider(provider.value.id, {
      label: config.label.trim(),
      baseUrl: config.baseUrl.trim(),
      proxyUrl: config.proxyUrl.trim() || undefined,
      extra: {
        ...provider.value.extra,
        referenceId: config.referenceId.trim(),
        latency: config.latency,
      },
    })
    if (newKey) {
      await providers.saveKey(provider.value.id, newKey, sessionOnly.value)
      apiKey.value = ''
      accepted.value = false
    }
    note.value = result.message
    ui.notify('测试通过，服务商已保存', 'success')
  } catch (err) {
    note.value = ''
    error.value = userMessageForError(err)
  } finally {
    saving.value = false
  }
}

async function deleteKey() {
  if (!provider.value) return
  try {
    await providers.deleteKey(provider.value.id)
    ui.notify('Key 已删除', 'info')
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 6500)
  }
}

function deleteProvider() {
  if (!provider.value || provider.value.builtin) return
  providers.removeProvider(provider.value.id)
  showDelete.value = false
  ui.notify('自定义服务商已删除', 'info')
  router.push('/settings/providers')
}

onMounted(async () => {
  await providers.refreshKeyPresence()
  sync()
})
</script>

<template>
  <div v-if="!provider" class="missing">
    <p class="av-kicker">Not found</p>
    <h1 class="av-title">服务商不存在</h1>
    <RouterLink to="/settings/providers"><BaseButton>返回列表</BaseButton></RouterLink>
  </div>

  <div v-else class="provider-page">
    <header class="provider-head">
      <div>
        <RouterLink to="/settings/providers" class="back-link"><ArrowLeft :size="14" /> 服务商</RouterLink>
        <h1 class="provider-title av-title">{{ provider.label }}</h1>
        <p class="provider-sub">
          服务商 · {{ isNativeRuntime() ? '桌面端本机直连' : '浏览器直连' }}
        </p>
      </div>
      <div class="head-actions">
        <span v-if="providerNeedsUserProxy(provider)" class="av-pill is-warn">网页版需代理</span>
        <span class="av-pill" :class="{ 'is-ok': hasKey }">
          <KeyRound :size="12" />
          {{ hasKey ? 'Key 已保存' : '未保存 Key' }}
        </span>
        <BaseButton v-if="!provider.builtin" size="sm" variant="danger" @click="showDelete = true">
          <template #icon><Trash2 :size="14" /></template>
          删除
        </BaseButton>
      </div>
    </header>

    <div class="provider-grid">
      <div class="provider-main">
        <section class="av-card form-card">
          <div class="card-head">
            <div>
              <p class="av-kicker">Endpoint</p>
              <h2 class="card-title">连接信息</h2>
            </div>
            <span class="av-pill">{{ isFish ? 'Fish 实时协议' : 'OpenAI 兼容' }}</span>
          </div>
          <div class="form-grid">
            <Field label="服务商名称">
              <input v-model="config.label" class="av-input" maxlength="40" />
            </Field>
            <Field
              label="服务商地址"
              class="span-2"
              :help="
                isFish
                  ? '填写 Fish Audio 的地址（https://api.fish.audio）；实时朗读会连接 {Base URL}/v1/tts/live，保存时会真实合成一句测试语音。'
                  : '填写 OpenAI 兼容 Base URL，通常以 /v1 结尾；保存时会请求 {Base URL}/models 做联通测试。'
              "
            >
              <input
                v-model="config.baseUrl"
                class="av-input av-mono"
                :placeholder="isFish ? 'https://api.fish.audio' : 'https://api.example.com/v1'"
                spellcheck="false"
              />
            </Field>
          </div>

          <template v-if="isFish">
            <div class="form-grid fish-grid">
              <Field
                label="音色模型 ID"
                class="span-2"
                help="Fish 用音色模型 ID 选声音（reference_id），可以在 Fish 广场复制；留空则使用默认音色。"
              >
                <input
                  v-model="config.referenceId"
                  class="av-input av-mono"
                  placeholder="例如 7f92f8afb8ec43bf81429cc1c9199cb1"
                  spellcheck="false"
                />
              </Field>
              <Field label="延迟档" class="span-2" help="越低延迟越快，音质略有损失。">
                <select v-model="config.latency" class="av-select">
                  <option v-for="option in latencyOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </Field>
            </div>
            <p class="advanced-note">
              实时朗读只在桌面端可用：Fish 需要在握手时带上 Key，浏览器无法自定义请求头。
            </p>
          </template>

          <details class="advanced" :open="providerNeedsUserProxy(provider)">
            <summary>{{ providerNeedsUserProxy(provider) ? '网页版自备代理（桌面端不需要）' : '高级：自定义代理' }}</summary>
            <div class="advanced-body">
              <Field
                label="代理地址"
                help="支持包含 {url} 的模板，或一个前缀。代理会看到你的密钥和图片内容，只使用你信任的自建代理。"
              >
                <input
                  v-model="config.proxyUrl"
                  class="av-input av-mono"
                  placeholder="https://your-proxy.example/?url={url}"
                  spellcheck="false"
                />
              </Field>
              <p class="advanced-note">代理地址只保存在本机设置，不会写入导出的角色包。</p>
            </div>
          </details>
        </section>

        <section class="av-card form-card key-card">
          <div class="card-head">
            <div>
              <p class="av-kicker">Secret</p>
              <h2 class="card-title">API Key</h2>
            </div>
            <span class="av-pill" :class="{ 'is-ok': hasKey }">{{ hasKey ? '已保存' : '未保存' }}</span>
          </div>
          <div class="key-input-wrap">
            <input
              v-model="apiKey"
              class="av-input av-mono key-input"
              :type="showKey ? 'text' : 'password'"
              :placeholder="hasKey ? '输入新 Key 以替换（留空则使用已保存的 Key）' : '粘贴你的 API Key'"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="button" class="key-eye" :aria-label="showKey ? '隐藏 Key' : '显示 Key'" @click="showKey = !showKey">
              <EyeOff v-if="showKey" :size="15" />
              <Eye v-else :size="15" />
            </button>
          </div>

          <label class="check-row">
            <input v-model="sessionOnly" type="checkbox" />
            <span>仅本次会话保存（重启应用后失效）</span>
          </label>
          <label class="check-row warning-check">
            <input v-model="accepted" type="checkbox" />
            <span>
              我了解 Key 只保存在此设备；桌面端使用 macOS 安全存储，浏览器版使用本地 IndexedDB。任何能访问此设备配置的人都可能读取，请使用限额 Key。
            </span>
          </label>
          <div v-if="hasKey" class="key-actions">
            <span class="key-stored"><CheckCircle2 :size="13" /> 已在本机检测到 Key</span>
            <button type="button" class="text-danger" @click="deleteKey">删除 Key</button>
          </div>
        </section>

        <div class="save-bar">
          <div>
            <p class="save-note">
              {{ isFish ? '保存前会真实合成一句测试语音；测试失败时名称、地址和 Key 都不会保存。' : '保存前会真实请求一次 /models；测试失败时名称、地址和 Key 都不会保存。' }}
            </p>
            <p v-if="note" class="save-status">
              <LoaderCircle v-if="saving" :size="13" class="spin" />
              {{ note }}
            </p>
            <p v-if="error" class="save-error">{{ error }}</p>
          </div>
          <BaseButton variant="primary" :loading="saving" @click="saveProvider">
            测试并保存
          </BaseButton>
        </div>
      </div>

      <aside class="provider-side">
        <div class="side-card av-card">
          <p class="av-kicker">Security</p>
          <h3 class="side-title">密钥不是角色包的一部分</h3>
          <p class="side-copy">导出的 ZIP / PSD 不包含 Key、代理地址或聊天记录。角色包只包含图层、绑定和人设。</p>
        </div>
        <div class="side-card av-card side-warning">
          <ShieldAlert :size="17" />
          <p v-if="isNativeRuntime()">
            桌面端通过本机网络层直接请求服务商，不受浏览器 CORS 限制；密钥存系统安全存储，不经过任何服务器。
          </p>
          <p v-else>
            网页版直连受服务商 CORS 策略影响。如果浏览器报“Failed to fetch”，先确认不是断网，再考虑配置你自己的代理。
          </p>
        </div>
        <div
          v-if="provider.kind === 'sensenova' && !isNativeRuntime()"
          class="side-card av-card side-warning"
        >
          <ShieldAlert :size="17" />
          <p>商汤日日新的浏览器预检返回 404，纯网页无法直连；桌面客户端不受此限制。网页版要用它，只能填写你自己的代理。</p>
        </div>
        <RouterLink to="/settings/providers" class="side-back"><ArrowLeft :size="13" /> 返回服务商列表</RouterLink>
      </aside>
    </div>

    <Modal :open="showDelete" title="删除自定义服务商" width="440px" @close="showDelete = false">
      <p class="delete-copy">删除后会清理本机保存的服务商设置和 Key，角色包不受影响。</p>
      <template #footer>
        <BaseButton size="sm" @click="showDelete = false">取消</BaseButton>
        <BaseButton size="sm" variant="danger" @click="deleteProvider">删除</BaseButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.provider-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.missing {
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.provider-head {
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

.provider-title {
  font-size: clamp(28px, 3.6vw, 40px);
}

.provider-sub {
  color: var(--av-muted);
  font-size: 12px;
  margin-top: 4px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.provider-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 18px;
  align-items: start;
}

.provider-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.form-card {
  padding: 19px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.card-title {
  font-family: var(--av-font-serif);
  font-size: 20px;
  margin-top: 2px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
}

.span-2 {
  grid-column: 1 / -1;
}

.fish-grid {
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--av-border);
}

.advanced {
  margin-top: 15px;
  border-top: 1px solid var(--av-border);
  padding-top: 12px;
}

.advanced summary {
  cursor: pointer;
  color: var(--av-muted);
  font-size: 11px;
}

.advanced summary:hover {
  color: var(--av-accent);
}

.advanced-body {
  margin-top: 12px;
}

.advanced-note {
  color: var(--av-faint);
  font-size: 10px;
  margin-top: 6px;
}

.key-input-wrap {
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

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 11px;
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

.key-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid var(--av-border);
}

.key-stored {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-success);
  font-size: 11px;
}

.text-danger {
  border: 0;
  background: transparent;
  color: var(--av-danger);
  font-size: 11px;
  padding: 0;
}

.save-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.022);
}

.save-note {
  color: var(--av-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

.save-status {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--av-accent);
  font-size: 10.5px;
  margin-top: 4px;
}

.save-error {
  color: var(--av-danger);
  font-size: 11px;
  margin-top: 4px;
}

.spin {
  animation: spin 900ms linear infinite;
}

.provider-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 92px;
}

.side-card {
  padding: 15px;
}

.side-title {
  font-family: var(--av-font-serif);
  font-size: 16px;
  margin: 3px 0 6px;
}

.side-copy {
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.7;
}

.side-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--av-muted);
  font-size: 10.5px;
  line-height: 1.6;
  border-color: rgba(251, 191, 36, 0.14);
  background: rgba(251, 191, 36, 0.035);
}

.side-warning svg {
  color: var(--av-warning);
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

.delete-copy {
  color: var(--av-text-soft);
  font-size: 13px;
  line-height: 1.7;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 980px) {
  .provider-grid {
    grid-template-columns: 1fr;
  }

  .provider-side {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .side-card {
    flex: 1;
    min-width: 240px;
  }

  .provider-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .head-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .span-2 {
    grid-column: auto;
  }

  .save-bar {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
