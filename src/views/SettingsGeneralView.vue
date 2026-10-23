<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  Cpu,
  Database,
  ExternalLink,
  FileArchive,
  HardDrive,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { useProviderStore } from '../stores/useProviderStore'
import { useCharacterStore } from '../stores/useCharacterStore'
import { useUiStore } from '../stores/useUiStore'
import { importCharacterZip } from '../services/pack/importZip'
import { RMBG_1_4, modelFileError } from '../services/cv/matting/spec'
import {
  deleteModel,
  getModelInfo,
  saveModel,
  type StoredModelInfo,
} from '../services/storage/modelRepo'
import BaseButton from '../components/ui/BaseButton.vue'
import Modal from '../components/ui/Modal.vue'

const router = useRouter()
const providers = useProviderStore()
const characters = useCharacterStore()
const ui = useUiStore()

const usage = ref<number | null>(null)
const quota = ref<number | null>(null)
const showClearKeys = ref(false)
const showClearChats = ref(false)
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const mattingInfo = ref<StoredModelInfo | null>(null)
const mattingImporting = ref(false)
const mattingInput = ref<HTMLInputElement | null>(null)

const chatStores = computed(() => {
  if (typeof localStorage === 'undefined') return 0
  let count = 0
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith('lingshu-avatar-studio.chat.')) count += 1
  }
  return count
})

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '未知'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function loadStorage() {
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate()
    usage.value = estimate.usage ?? null
    quota.value = estimate.quota ?? null
  }
}

async function clearKeys() {
  await providers.clearAllKeys()
  showClearKeys.value = false
  ui.notify('所有本机 Key 已清除', 'info')
}

function clearChats() {
  if (typeof localStorage !== 'undefined') {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('lingshu-avatar-studio.chat.')) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  }
  showClearChats.value = false
  ui.notify('聊天记录已清空', 'info')
}

async function onImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const record = await importCharacterZip(file)
    await characters.save(record)
    ui.notify('角色包已导入', 'success')
    router.push(`/character/${record.id}`)
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : '导入失败', 'error', 6000)
  } finally {
    importing.value = false
  }
}

async function onImportMatting(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const error = modelFileError(file, RMBG_1_4)
  if (error) {
    ui.notify(error, 'error', 6000)
    return
  }
  mattingImporting.value = true
  try {
    mattingInfo.value = await saveModel(RMBG_1_4.id, file)
    ui.notify('抠图模型已导入，新建角色时生效', 'success', 5000)
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : '模型导入失败', 'error', 6000)
  } finally {
    mattingImporting.value = false
  }
}

async function removeMatting() {
  await deleteModel(RMBG_1_4.id)
  mattingInfo.value = null
  ui.notify('抠图模型已移除', 'info')
}

onMounted(async () => {
  await Promise.all([
    providers.refreshKeyPresence(),
    characters.load(),
    getModelInfo(RMBG_1_4.id).then((info) => {
      mattingInfo.value = info
    }),
  ])
  await loadStorage()
})
</script>

<template>
  <div class="general-page">
    <header class="general-head">
      <div>
        <p class="av-kicker">Local data</p>
        <h1 class="general-title av-title">设置与数据</h1>
        <p class="general-sub">没有账号，没有云同步。角色、密钥和聊天都在这台设备上；桌面端密钥使用系统安全存储。</p>
      </div>
      <RouterLink to="/settings/providers"><BaseButton size="sm"><KeyRound :size="14" /> 服务商与密钥</BaseButton></RouterLink>
    </header>

    <div class="general-grid">
      <section class="av-card panel">
        <div class="panel-head">
          <span class="panel-icon"><HardDrive :size="17" /></span>
          <div>
            <h2 class="panel-title">本机存储</h2>
            <p class="panel-desc">角色包用 IndexedDB，聊天记录用 localStorage。</p>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat">
            <span class="stat-label">已用空间</span>
            <strong>{{ formatBytes(usage) }}</strong>
          </div>
          <div class="stat">
            <span class="stat-label">存储配额</span>
            <strong>{{ formatBytes(quota) }}</strong>
          </div>
          <div class="stat">
            <span class="stat-label">角色</span>
            <strong>{{ characters.characters.length }}</strong>
          </div>
          <div class="stat">
            <span class="stat-label">聊天记录</span>
            <strong>{{ chatStores }} 份</strong>
          </div>
        </div>
        <div class="panel-actions">
          <BaseButton size="sm" @click="loadStorage">刷新用量</BaseButton>
          <BaseButton size="sm" variant="danger" @click="showClearChats = true">
            <template #icon><MessageSquareText :size="13" /></template>
            清空聊天记录
          </BaseButton>
        </div>
      </section>

      <section class="av-card panel">
        <div class="panel-head">
          <span class="panel-icon danger"><KeyRound :size="17" /></span>
          <div>
            <h2 class="panel-title">密钥</h2>
            <p class="panel-desc">Key 只在本机。清除后，所有模型请求会立即失效。</p>
          </div>
        </div>
        <div class="key-summary">
          <span class="av-pill" :class="{ 'is-ok': providers.readyCount > 0 }">
            {{ providers.readyCount }} 个服务商已保存 Key
          </span>
          <span class="av-muted">{{ providers.providers.length }} 个服务商配置</span>
        </div>
        <div class="panel-actions">
          <RouterLink to="/settings/providers"><BaseButton size="sm">管理服务商</BaseButton></RouterLink>
          <BaseButton size="sm" variant="danger" @click="showClearKeys = true">
            <template #icon><Trash2 :size="13" /></template>
            清除所有 Key
          </BaseButton>
        </div>
      </section>

      <section class="av-card panel">
        <div class="panel-head">
          <span class="panel-icon"><FileArchive :size="17" /></span>
          <div>
            <h2 class="panel-title">角色包</h2>
            <p class="panel-desc">ZIP 包含 manifest、绑定、人设与图层；不包含 Key、代理和聊天记录。</p>
          </div>
        </div>
        <div class="panel-actions">
          <BaseButton size="sm" :loading="importing" @click="fileInput?.click()">
            <template #icon><Upload :size="14" /></template>
            导入 ZIP
          </BaseButton>
          <RouterLink to="/"><BaseButton size="sm">查看角色库</BaseButton></RouterLink>
        </div>
        <p class="panel-note">
          导出的 PSD 只用于后期图层编辑，不能导回本应用；回读请使用 ZIP 角色包。
        </p>
      </section>

      <section class="av-card panel">
        <div class="panel-head">
          <span class="panel-icon"><Cpu :size="17" /></span>
          <div>
            <h2 class="panel-title">抠图模型</h2>
            <p class="panel-desc">可选。导入 RMBG-1.4 后，新建角色时会用它抠前景；未导入时继续使用内置分割。</p>
          </div>
        </div>
        <div class="key-summary">
          <span class="av-pill" :class="{ 'is-ok': mattingInfo }">
            {{ mattingInfo ? 'RMBG-1.4 已导入' : '未导入' }}
          </span>
          <span class="av-muted">{{ mattingInfo ? formatBytes(mattingInfo.size) : '约 176 MB' }}</span>
        </div>
        <div class="panel-actions">
          <BaseButton size="sm" :loading="mattingImporting" @click="mattingInput?.click()">
            <template #icon><Upload :size="14" /></template>
            导入 ONNX
          </BaseButton>
          <BaseButton v-if="mattingInfo" size="sm" variant="danger" @click="removeMatting">
            <template #icon><Trash2 :size="13" /></template>
            移除
          </BaseButton>
        </div>
        <p class="panel-note">
          权重由 BRIA 提供，仅限非商用；商用请另行获取授权。本应用不内置权重，请自行
          <a :href="RMBG_1_4.sourceUrl" target="_blank" rel="noreferrer">下载 model.onnx</a>
          后导入。模型只用于创建阶段，播放角色包不依赖它。
        </p>
      </section>

      <section class="av-card panel about-panel">
        <div class="panel-head">
          <span class="panel-icon"><ShieldCheck :size="17" /></span>
          <div>
            <h2 class="panel-title">关于这套格式</h2>
            <p class="panel-desc">自研 2.5D 分层角色包，不是 Live2D `.moc3`。</p>
          </div>
        </div>
        <ul class="about-list">
          <li><Sparkles :size="13" /> 本机直接请求模型服务商，没有本站服务器。</li>
          <li><Database :size="13" /> 角色包与密钥都不离开本机。</li>
          <li><ExternalLink :size="13" /> 真 Live2D 需要在 Cubism Editor 里绑定后导入，当前版本不支持导入 `.moc3`。</li>
        </ul>
        <p class="panel-note">格式版本 1 · 角色包可通过 ZIP 跨设备导入，但密钥需要重新填写。</p>
      </section>
    </div>

    <input ref="fileInput" type="file" accept=".zip,application/zip" class="hidden-input" @change="onImport" />
    <input ref="mattingInput" type="file" accept=".onnx" class="hidden-input" @change="onImportMatting" />

    <Modal :open="showClearKeys" title="清除所有 Key" width="440px" @close="showClearKeys = false">
      <p class="modal-copy">会删除本机保存的所有服务商 Key，角色包不会删除。清除后，聊天、语音和生图都会停止工作，直到重新填写。</p>
      <template #footer>
        <BaseButton size="sm" @click="showClearKeys = false">取消</BaseButton>
        <BaseButton size="sm" variant="danger" @click="clearKeys">确认清除</BaseButton>
      </template>
    </Modal>

    <Modal :open="showClearChats" title="清空聊天记录" width="440px" @close="showClearChats = false">
      <p class="modal-copy">会删除所有角色的本地聊天记录，不影响人设、图层和绑定。</p>
      <template #footer>
        <BaseButton size="sm" @click="showClearChats = false">取消</BaseButton>
        <BaseButton size="sm" variant="danger" @click="clearChats">确认清空</BaseButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.general-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.general-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.general-title {
  font-size: clamp(30px, 4vw, 44px);
  margin: 6px 0 7px;
}

.general-sub {
  color: var(--av-muted);
  font-size: 13px;
}

.general-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.panel {
  padding: 18px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-bottom: 14px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  background: var(--av-accent-soft);
  color: var(--av-accent);
  flex-shrink: 0;
}

.panel-icon.danger {
  background: var(--av-danger-soft);
  color: var(--av-danger);
}

.panel-title {
  font-family: var(--av-font-serif);
  font-size: 19px;
}

.panel-desc {
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 2px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.stat {
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  color: var(--av-faint);
  font-size: 9px;
}

.stat strong {
  font-size: 13px;
  font-weight: 600;
}

.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.key-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
}

.panel-note {
  color: var(--av-faint);
  font-size: 10px;
  line-height: 1.7;
  margin-top: 12px;
}

.about-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.6;
}

.about-list li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}

.about-list svg {
  color: var(--av-accent);
  flex-shrink: 0;
  margin-top: 2px;
}

.hidden-input {
  display: none;
}

.modal-copy {
  color: var(--av-text-soft);
  font-size: 13px;
  line-height: 1.7;
}

@media (max-width: 900px) {
  .general-grid {
    grid-template-columns: 1fr;
  }

  .general-head {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 560px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
