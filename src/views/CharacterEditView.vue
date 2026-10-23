<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  ArrowLeft,
  Check,
  Layers,
  MessageSquareText,
  Save,
  Volume2,
} from 'lucide-vue-next'
import type { CharacterRecord } from '../types/character'
import { useCharacterStore } from '../stores/useCharacterStore'
import { useProviderStore } from '../stores/useProviderStore'
import { useUiStore } from '../stores/useUiStore'
import BaseButton from '../components/ui/BaseButton.vue'
import Field from '../components/ui/Field.vue'
import HelpDot from '../components/ui/HelpDot.vue'

const route = useRoute()
const router = useRouter()
const characters = useCharacterStore()
const providers = useProviderStore()
const ui = useUiStore()

const record = ref<CharacterRecord | null>(null)
const loading = ref(true)
const notFound = ref(false)
const saving = ref(false)

const traitsText = computed({
  get: () => record.value?.persona.personality.traits.join('、') ?? '',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.personality.traits = value
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})

/** Which mouth model drives the stage while the character speaks. */
const visemeMode = computed({
  get: () => record.value?.persona.voice.visemeMode ?? 'approx',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.voice.visemeMode = value === 'approx' ? 'approx' : 'envelope'
    record.value.persona.voice.visemeModeMigrated = true
  },
})
const valuesText = computed({
  get: () => record.value?.persona.personality.values.join('、') ?? '',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.personality.values = value
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})
const flawsText = computed({
  get: () => record.value?.persona.personality.flaws.join('、') ?? '',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.personality.flaws = value
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})
const boundariesText = computed({
  get: () => record.value?.persona.boundaries.join('\n') ?? '',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.boundaries = value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
  },
})
const catchphrasesText = computed({
  get: () => record.value?.persona.speech.catchphrases.join('；') ?? '',
  set: (value: string) => {
    if (!record.value) return
    record.value.persona.speech.catchphrases = value
      .split(/[；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})

const globalTtsProvider = computed(() =>
  providers.isRoleReady('tts') ? providers.roleProvider('tts') : undefined,
)

const layerEntries = computed(() =>
  Object.values(record.value?.manifest.layers ?? {}).filter(Boolean).sort((a, b) => (a?.z ?? 0) - (b?.z ?? 0)),
)

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function save() {
  if (!record.value) return
  saving.value = true
  try {
    const recordValue = record.value
    const name = recordValue.persona.displayName.trim() || recordValue.name
    recordValue.name = name
    recordValue.manifest.name = name
    recordValue.persona.voice.providerId = globalTtsProvider.value?.id
    recordValue.persona.voice.model = globalTtsProvider.value
      ? providers.roleModel('tts') || undefined
      : undefined
    recordValue.persona.voice.voiceId = globalTtsProvider.value
      ? providers.roleVoiceValue() || undefined
      : undefined
    recordValue.updatedAt = Date.now()
    recordValue.manifest.updatedAt = recordValue.updatedAt
    await characters.save(recordValue)
    ui.notify('人设已保存', 'success')
    router.push(`/character/${recordValue.id}`)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  loading.value = true
  try {
    const found = await characters.get(String(route.params.id || ''))
    if (!found) {
      notFound.value = true
      return
    }
    record.value = found
    await providers.refreshKeyPresence()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="edit-loading">正在读取人设…</div>

  <div v-else-if="notFound || !record" class="edit-missing">
    <p class="av-kicker">Not found</p>
    <h1 class="av-title">没有找到这个角色</h1>
    <RouterLink to="/"><BaseButton>返回工作室</BaseButton></RouterLink>
  </div>

  <div v-else class="edit-page">
    <header class="edit-head">
      <div>
        <RouterLink :to="`/character/${record.id}`" class="back-link"><ArrowLeft :size="14" /> 返回舞台</RouterLink>
        <h1 class="edit-title av-title">编辑 {{ record.persona.displayName }}</h1>
        <p class="edit-sub">人设会写进系统提示；图层和绑定保持自动生成的结果。</p>
      </div>
      <BaseButton variant="primary" :loading="saving" @click="save">
        <template #icon><Save :size="15" /></template>
        保存人设
      </BaseButton>
    </header>

    <div class="edit-grid">
      <div class="edit-form">
        <section class="av-card form-card">
          <div class="section-head">
            <div>
              <p class="av-kicker">Identity</p>
              <h2 class="card-title">身份</h2>
            </div>
            <span class="av-pill">{{ record.manifest.tier === 'full' ? '完整绑定' : '简化模式' }}</span>
          </div>
          <div class="form-grid">
            <Field label="显示名">
              <input v-model="record.persona.displayName" class="av-input" maxlength="24" />
            </Field>
            <Field label="职业">
              <input v-model="record.persona.occupation" class="av-input" />
            </Field>
            <Field label="年龄感">
              <input v-model="record.persona.agePresentation" class="av-input" placeholder="例如：青年" />
            </Field>
            <Field label="代词">
              <input v-model="record.persona.pronouns" class="av-input" placeholder="例如：TA" />
            </Field>
            <Field label="世界观" class="span-2">
              <input v-model="record.persona.world" class="av-input" />
            </Field>
          </div>
        </section>

        <section class="av-card form-card">
          <div class="section-head">
            <div>
              <p class="av-kicker">Personality</p>
              <h2 class="card-title">性格与说话</h2>
            </div>
          </div>
          <div class="form-grid">
            <Field label="性格关键词">
              <input v-model="traitsText" class="av-input" placeholder="用顿号分隔" />
            </Field>
            <Field label="在意的事">
              <input v-model="valuesText" class="av-input" placeholder="用顿号分隔" />
            </Field>
            <Field label="不完美之处">
              <input v-model="flawsText" class="av-input" placeholder="用顿号分隔" />
            </Field>
            <Field label="口头禅">
              <input v-model="catchphrasesText" class="av-input" placeholder="用分号分隔，可留空" />
            </Field>
            <Field label="说话风格" class="span-2">
              <input v-model="record.persona.speech.tone" class="av-input" />
            </Field>
            <Field label="句子长度">
              <select v-model="record.persona.speech.sentenceLength" class="av-select">
                <option value="short">短句</option>
                <option value="medium">中等</option>
              </select>
            </Field>
            <Field label="表情符号">
              <select v-model="record.persona.speech.emoji" class="av-select">
                <option :value="false">不使用</option>
                <option :value="true">偶尔使用</option>
              </select>
            </Field>
          </div>
        </section>

        <section class="av-card form-card">
          <div class="section-head">
            <div>
              <p class="av-kicker">Background</p>
              <h2 class="card-title">背景与边界</h2>
            </div>
          </div>
          <Field label="背景">
            <textarea v-model="record.persona.background" class="av-textarea" rows="4" />
          </Field>
          <Field label="和用户的关系" class="spaced">
            <textarea v-model="record.persona.relationships" class="av-textarea" rows="2" />
          </Field>
          <Field
            label="边界"
            class="spaced"
            help="每行一条。边界会写入系统提示，优先级高于角色设定。"
          >
            <textarea v-model="boundariesText" class="av-textarea" rows="4" />
          </Field>
          <Field label="补充设定" class="spaced" help="可选。不要在这里写系统指令或工具说明。">
            <textarea v-model="record.persona.systemPromptExtra" class="av-textarea" rows="2" />
          </Field>
          <Field label="开场白" class="spaced">
            <textarea v-model="record.persona.greeting" class="av-textarea" rows="2" />
          </Field>
        </section>

        <section class="av-card form-card">
          <div class="section-head">
            <div>
              <p class="av-kicker">Voice</p>
              <h2 class="card-title">声音</h2>
            </div>
            <HelpDot>语音会调用服务商 HTTP 接口；Fish Audio 这类只支持 WS 鉴权的服务商需要代理。</HelpDot>
          </div>
          <div class="voice-summary">
            <div>
              <span>服务商</span>
              <strong>{{ globalTtsProvider?.label ?? '未选择' }}</strong>
            </div>
            <div>
              <span>模型</span>
              <strong class="av-mono">{{ globalTtsProvider ? providers.roleModel('tts') || '未选择' : '未选择' }}</strong>
            </div>
            <div>
              <span>音色</span>
              <strong class="av-mono">{{ globalTtsProvider ? providers.roleVoiceValue() || '服务商默认' : '未选择' }}</strong>
            </div>
            <RouterLink to="/settings/providers" class="voice-config-link">修改用途配置</RouterLink>
          </div>
          <Field
            label="口型"
            class="viseme-field"
            help="「音量跟随」只让嘴巴随声音开合；「精细口型」会分析音频频谱，圆唇、露齿等口型会分开变化。"
          >
            <select v-model="visemeMode" class="av-select">
              <option value="envelope">音量跟随</option>
              <option value="approx">精细口型</option>
            </select>
          </Field>
          <p class="voice-note">
            <Volume2 :size="13" />
            语音服务商、模型和音色在「服务商 → 用途配置」里统一选择；保存人设时会写入当前配置。试听和口型请在角色舞台的聊天面板里使用。
          </p>
        </section>

        <div class="form-actions">
          <RouterLink :to="`/character/${record.id}`"><BaseButton>取消</BaseButton></RouterLink>
          <BaseButton variant="primary" :loading="saving" @click="save">
            <template #icon><Check :size="15" /></template>
            保存并返回
          </BaseButton>
        </div>
      </div>

      <aside class="edit-side">
        <section class="av-card side-card">
          <div class="side-head">
            <p class="av-kicker">Rig</p>
            <h2 class="side-title"><Layers :size="16" /> 图层与绑定</h2>
          </div>
          <div class="layer-list">
            <div v-for="layer in layerEntries" :key="layer?.id" class="layer-row">
              <span class="layer-name">{{ layer?.nameZh }}</span>
              <span class="layer-z">z {{ layer?.z }}</span>
            </div>
          </div>
          <p class="side-note">图层自动生成，暂不支持手动重绑；可通过编辑人设改变对话表现。</p>
        </section>

        <section class="av-card side-card">
          <p class="av-kicker">Notes</p>
          <h2 class="side-title"><MessageSquareText :size="16" /> 绑定说明</h2>
          <ul v-if="record.manifest.notes?.length" class="notes-list">
            <li v-for="note in record.manifest.notes" :key="note">{{ note }}</li>
          </ul>
          <p v-else class="side-note">没有降级或缺失图层的提示。</p>
          <p class="side-note">画布 {{ record.manifest.canvas.width }} × {{ record.manifest.canvas.height }} · 更新于 {{ formatDate(record.updatedAt) }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.edit-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.edit-loading,
.edit-missing {
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--av-muted);
}

.edit-head {
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

.edit-title {
  font-size: clamp(28px, 3.6vw, 40px);
}

.edit-sub {
  color: var(--av-muted);
  font-size: 12px;
  margin-top: 4px;
}

.edit-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  gap: 16px;
  align-items: start;
}

.edit-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.form-card {
  padding: 19px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 15px;
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

.spaced {
  margin-top: 13px;
}

.voice-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  gap: 10px;
  align-items: end;
  padding: 12px;
  border-radius: 11px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.02);
}

.voice-summary > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.voice-summary span {
  color: var(--av-faint);
  font-size: 9px;
}

.voice-summary strong {
  color: var(--av-text-soft);
  font-size: 11.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-config-link {
  color: var(--av-accent);
  font-size: 10px;
  white-space: nowrap;
}

.viseme-field {
  margin-top: 14px;
}

.voice-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 13px;
  color: var(--av-faint);
  font-size: 10px;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .voice-summary {
    grid-template-columns: 1fr;
  }
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding-bottom: 8px;
}

.edit-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: sticky;
  top: 92px;
}

.side-card {
  padding: 16px;
}

.side-head {
  margin-bottom: 12px;
}

.side-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--av-font-serif);
  font-size: 17px;
  margin-top: 2px;
}

.side-title + * {
  margin-top: 10px;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--av-border);
}

.layer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 11px;
}

.layer-name {
  color: var(--av-text-soft);
}

.layer-z {
  color: var(--av-faint);
  font-size: 9px;
}

.side-note {
  color: var(--av-faint);
  font-size: 10px;
  line-height: 1.7;
  margin-top: 10px;
}

.notes-list {
  margin: 0;
  padding-left: 15px;
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.7;
}

@media (max-width: 980px) {
  .edit-grid {
    grid-template-columns: 1fr;
  }

  .edit-side {
    position: static;
    order: -1;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .side-card {
    flex: 1;
    min-width: 240px;
  }

  .edit-head {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .span-2 {
    grid-column: auto;
  }

  .edit-side {
    flex-direction: column;
  }
}
</style>
