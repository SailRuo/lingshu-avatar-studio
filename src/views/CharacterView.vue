<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileArchive,
  Layers,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  RotateCw,
  Send,
  Smile,
  Square,
  Volume2,
  VolumeX,
  Wind,
  Zap,
} from 'lucide-vue-next'
import type { CharacterRecord } from '../types/character'
import { useCharacterStore } from '../stores/useCharacterStore'
import { useProviderStore } from '../stores/useProviderStore'
import { useUiStore } from '../stores/useUiStore'
import { sendChat } from '../services/chat/chatService'
import { rebuildMouthCavity, upgradeMouthCavity } from '../services/agent/openMouthReference'
import { stripForSpeech } from '../services/chat/persona'
import {
  appendChat,
  clearChat,
  loadChat,
  saveChat,
  type StoredChatTurn,
} from '../services/chat/chatMemory'
import { pickReferenceId, synthesizeSpeech } from '../services/providers/tts'
import { fishLiveSupported, speakFishLive } from '../services/providers/fishLive'
import { userMessageForError } from '../services/providers/http'
import { SpeechQueue } from '../services/audio/ttsQueue'
import { exportCharacterZip, downloadBlob } from '../services/pack/exportZip'
import { exportCharacterPsd } from '../services/pack/exportPsd'
import AvatarStage from '../components/stage/AvatarStage.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import Modal from '../components/ui/Modal.vue'

const route = useRoute()
const characters = useCharacterStore()
const providers = useProviderStore()
const ui = useUiStore()

const record = ref<CharacterRecord | null>(null)
const loading = ref(true)
const notFound = ref(false)
const stageRef = ref<InstanceType<typeof AvatarStage> | null>(null)
const messagesEl = ref<HTMLElement | null>(null)
const messages = ref<StoredChatTurn[]>([])
const prompt = ref('')
const sending = ref(false)
const streamText = ref('')
const errorText = ref('')
const ttsEnabled = ref(true)
const idleEnabled = ref(false)
const speaking = ref(false)
const showClear = ref(false)
const exporting = ref(false)
const mouthUpgrading = ref(false)
const mouthRebuilding = ref(false)
/** Bumped to force the stage to rebuild after a layer is replaced. */
const stageKey = ref(0)
const speech = new SpeechQueue()
/** Per-layer visibility switches, keyed by layer id. */
const layerVisible = ref<Record<string, boolean>>({})
/** When set, only this layer is shown so a single piece can be inspected. */
const soloLayer = ref<string | null>(null)
const showLayerPanel = ref(false)
let controller: AbortController | null = null
let mouthFrame = 0

const chatProvider = computed(() => providers.roleProvider('chat'))
const chatModel = computed(() => providers.roleModel('chat'))
const chatReady = computed(
  () =>
    !!chatProvider.value &&
    providers.hasKey(chatProvider.value.id) &&
    !!chatProvider.value.baseUrl &&
    !!chatModel.value,
)
const ttsProvider = computed(() => {
  const preferred = record.value?.persona.voice.providerId
  return (preferred ? providers.providerById(preferred) : undefined) || providers.roleProvider('tts')
})
const ttsReady = computed(
  () =>
    !!ttsProvider.value &&
    providers.hasKey(ttsProvider.value.id) &&
    !!ttsProvider.value.baseUrl,
)
const tierText = computed(() => {
  const tier = record.value?.manifest.tier
  if (tier === 'full') return '完整分层绑定'
  if (tier === 'layered-lite') return '基础分层绑定'
  if (tier === 'portrait-plus') return '半身动态'
  return '单图动态'
})
const simplified = computed(() => !!record.value && record.value.manifest.tier !== 'full')
/** Which mouth model the character uses while it speaks. */
const visemeMode = computed(() => record.value?.persona.voice.visemeMode ?? 'approx')
/**
 * Why the character stays silent. Without this the chat simply produces no
 * voice and no lip movement, which reads as a broken app.
 */
const ttsIssue = computed(() => {
  if (ttsReady.value) return ''
  if (!ttsProvider.value) return '还没有选择语音服务商，角色不会朗读。'
  if (!providers.hasKey(ttsProvider.value.id)) return '语音服务商还没有保存 Key，角色不会朗读。'
  if (!ttsProvider.value.baseUrl) return '语音服务商地址为空，角色不会朗读。'
  return '语音服务商还没准备好，角色不会朗读。'
})
const greeting = computed(() => record.value?.persona.greeting ?? '')

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function scrollToBottom() {
  void nextTick(() => {
    const el = messagesEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function seedGreeting(character: CharacterRecord): StoredChatTurn[] {
  const existing = loadChat(character.id)
  if (existing.length) return existing
  if (!character.persona.greeting?.trim()) return []
  return appendChat(character.id, { role: 'assistant', text: character.persona.greeting })
}

async function loadCharacter() {
  loading.value = true
  try {
    const id = String(route.params.id || '')
    const found = await characters.get(id)
    if (!found) {
      notFound.value = true
      return
    }
    record.value = found
    messages.value = seedGreeting(found)
    await providers.refreshKeyPresence()
    scrollToBottom()
  } finally {
    loading.value = false
  }
}

function startMouthLoop() {
  if (mouthFrame) return
  const tick = () => {
    if (!speaking.value) {
      mouthFrame = 0
      stageRef.value?.setMouthOpen(0)
      return
    }
    stageRef.value?.setMouthShape(speech.mouthShape())
    mouthFrame = requestAnimationFrame(tick)
  }
  mouthFrame = requestAnimationFrame(tick)
}

function stopSpeech() {
  speech.stop()
  speaking.value = false
  if (mouthFrame) cancelAnimationFrame(mouthFrame)
  mouthFrame = 0
  stageRef.value?.setMouthOpen(0)
}

async function speakText(text: string) {
  if (!record.value || !ttsEnabled.value || !ttsReady.value || !ttsProvider.value) return
  const cleaned = stripForSpeech(text)
  if (!cleaned) return
  const key = await providers.getKey(ttsProvider.value.id)
  if (!key) {
    ui.notify('语音服务商还没有可用的 Key。', 'error')
    return
  }
  stopSpeech()
  speaking.value = true
  startMouthLoop()
  const character = record.value
  const provider = ttsProvider.value
  const voice = character.persona.voice.voiceId || providers.roleVoiceValue()
  const model = character.persona.voice.model || providers.roleModel('tts')
  try {
    if (provider.kind === 'fishaudio' && fishLiveSupported()) {
      // Fish streams the utterance while it is generated, so the mouth can
      // follow the audio instead of waiting for a complete file.
      await speech.speak(cleaned, {
        live: {
          run: (body, handlers) =>
            speakFishLive({
              provider,
              apiKey: key,
              text: body,
              model,
              referenceId: pickReferenceId(provider, voice),
              signal: handlers.signal,
              onAudio: handlers.onAudio,
            }),
        },
        visemeMode: visemeMode.value,
        onError: (err) => {
          ui.notify(userMessageForError(err), 'error', 6000)
        },
      })
    } else {
      await speech.speak(cleaned, {
        synthesize: (sentence, signal) =>
          synthesizeSpeech({
            provider,
            apiKey: key,
            text: sentence,
            voice,
            modelOverride: model,
            signal,
          }),
        visemeMode: visemeMode.value,
        onError: (err) => {
          ui.notify(userMessageForError(err), 'error', 6000)
        },
      })
    }
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 6000)
  } finally {
    speaking.value = false
    stageRef.value?.setMouthOpen(0)
  }
}

async function sendMessage() {
  const text = prompt.value.trim()
  if (!text || sending.value || !record.value) return
  if (!chatReady.value || !chatProvider.value) {
    ui.notify('先在服务商设置里绑定一个带 Key 的多模态智能体。', 'error', 6000)
    return
  }
  const apiKey = await providers.getKey(chatProvider.value.id)
  if (!apiKey) {
    ui.notify('没有读取到智能体的 Key。', 'error')
    return
  }
  stopSpeech()
  const before = messages.value.map(({ role, text: content }) => ({ role, text: content }))
  prompt.value = ''
  errorText.value = ''
  messages.value = appendChat(record.value.id, { role: 'user', text })
  messages.value = appendChat(record.value.id, { role: 'assistant', text: '' })
  streamText.value = ''
  sending.value = true
  scrollToBottom()
  controller = new AbortController()
  const current = controller
  try {
    const full = await sendChat({
      provider: chatProvider.value,
      apiKey,
      model: chatModel.value,
      persona: record.value.persona,
      history: before,
      userText: text,
      signal: current.signal,
      onDelta: (delta) => {
        streamText.value += delta
        const last = messages.value[messages.value.length - 1]
        if (last) last.text = streamText.value
        scrollToBottom()
      },
    })
    if (current.signal.aborted) return
    const finalText = full.trim() || streamText.value.trim()
    const last = messages.value[messages.value.length - 1]
    if (last) last.text = finalText
    if (!finalText) {
      messages.value = messages.value.slice(0, -1)
      errorText.value = '模型没有返回内容。'
    } else {
      saveChat(record.value.id, messages.value)
      if (ttsEnabled.value && ttsReady.value) void speakText(finalText)
    }
    scrollToBottom()
  } catch (err) {
    if (!current.signal.aborted) {
      const last = messages.value[messages.value.length - 1]
      if (last && !last.text.trim()) messages.value = messages.value.slice(0, -1)
      else saveChat(record.value.id, messages.value)
      errorText.value = userMessageForError(err)
      ui.notify(errorText.value, 'error', 6500)
    }
  } finally {
    if (controller === current) {
      controller = null
      sending.value = false
    }
  }
}

function stopAll() {
  controller?.abort()
  controller = null
  sending.value = false
  stopSpeech()
  if (record.value) {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && !last.text.trim()) {
      messages.value = messages.value.slice(0, -1)
      saveChat(record.value.id, messages.value)
    } else if (record.value) {
      saveChat(record.value.id, messages.value)
    }
  }
}

function clearHistory() {
  if (!record.value) return
  clearChat(record.value.id)
  messages.value = record.value.persona.greeting?.trim()
    ? appendChat(record.value.id, { role: 'assistant', text: record.value.persona.greeting })
    : []
  showClear.value = false
  stopSpeech()
  scrollToBottom()
  ui.notify('聊天记录已清空', 'info')
}

function blinkTest() {
  stageRef.value?.blink()
}

/**
 * Replaces the painted mouth cavity with real open-mouth pixels.
 *
 * A character generated from a closed mouth has no interior to sample, so the
 * cavity is painted. One image edit of the mouth gives the deformation real
 * teeth to reveal. This runs on demand — it costs one image call.
 */
/**
 * Rebuilds the cavity from the character's own pixels. Free, instant, and it
 * repairs a cavity baked by an older pipeline.
 */
async function rebuildMouth() {
  const current = record.value
  if (!current || mouthRebuilding.value) return
  mouthRebuilding.value = true
  try {
    const result = await rebuildMouthCavity({ record: current })
    if (!result.rebuilt) {
      ui.notify(result.note, 'error', 6000)
      return
    }
    await characters.save(result.record)
    record.value = result.record
    stageKey.value += 1
    ui.notify(result.note, 'success', 4000)
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 7000)
  } finally {
    mouthRebuilding.value = false
  }
}

async function upgradeMouth() {
  const current = record.value
  if (!current || mouthUpgrading.value) return
  const provider = providers.roleProvider('image')
  if (!provider) {
    ui.notify('还没有配置生图服务商。', 'error')
    return
  }
  if (!provider.supportsEdit || !provider.models.image) {
    ui.notify('当前生图服务商不支持图像编辑，无法生成张嘴素材。', 'error', 7000)
    return
  }
  if (!current.rig.mouth || !current.manifest.layers.mouthCavity) {
    ui.notify('这个角色没有连续口型绑定，无法替换口腔。', 'error', 7000)
    return
  }
  const key = await providers.getKey(provider.id)
  if (!key) {
    ui.notify('没有读取到生图 Key，请到服务商设置里重新保存。', 'error', 7000)
    return
  }
  mouthUpgrading.value = true
  try {
    const result = await upgradeMouthCavity({
      record: current,
      provider,
      apiKey: key,
      model: providers.roleModel('image'),
    })
    if (!result.upgraded) {
      ui.notify(result.note, 'info', 6000)
      return
    }
    await characters.save(result.record)
    record.value = result.record
    // The stage builds its textures once on mount, so remount it to pick up
    // the replaced cavity layer.
    stageKey.value += 1
    ui.notify('口腔与牙齿已换成真实张嘴素材。', 'success', 5000)
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 7000)
  } finally {
    mouthUpgrading.value = false
  }
}

function mouthTest() {
  stageRef.value?.setMouthOpen(0.88)
  window.setTimeout(() => stageRef.value?.setMouthOpen(0), 360)
}

/**
 * What each layer actually is. The rig needs a few extra pieces of the same
 * picture so it can move them independently, so not every layer is a separate
 * part of the character.
 */
const LAYER_KIND: Record<string, string> = {
  body: '部件',
  head: '部件·含头发',
  hairBack: '运动切片',
  hairFront: '运动切片',
  eyeL: '覆盖层',
  eyeR: '覆盖层',
  mouth: '覆盖层',
}

/** Layers of the character, topmost first. */
const stageLayers = computed(() =>
  Object.values(record.value?.manifest.layers ?? {})
    .filter(Boolean)
    .sort((a, b) => (b?.z ?? 0) - (a?.z ?? 0)),
)

function isLayerVisible(id: string): boolean {
  if (soloLayer.value) return soloLayer.value === id
  return layerVisible.value[id] !== false
}

function toggleLayer(id: string) {
  const next = !isLayerVisible(id)
  if (soloLayer.value) soloLayer.value = null
  layerVisible.value = { ...layerVisible.value, [id]: next }
  stageRef.value?.setLayerVisible(id, next)
}

function soloLayerId(id: string) {
  const next = soloLayer.value === id ? null : id
  soloLayer.value = next
  stageRef.value?.setSoloLayer(next)
}

function showAllLayers() {
  soloLayer.value = null
  layerVisible.value = {}
  for (const layer of stageLayers.value) {
    stageRef.value?.setLayerVisible(layer.id, true)
  }
  stageRef.value?.setSoloLayer(null)
}

function hideAllLayers() {
  soloLayer.value = null
  layerVisible.value = {}
  for (const layer of stageLayers.value) {
    stageRef.value?.setLayerVisible(layer.id, false)
  }
  stageRef.value?.setSoloLayer(null)
}

/** Push the selected idle mode and the layer switches into the new stage. */
function onStageReady() {
  stageRef.value?.playMotion(idleEnabled.value ? 'idle' : 'none')
  for (const layer of stageLayers.value) {
    stageRef.value?.setLayerVisible(layer.id, isLayerVisible(layer.id))
  }
  stageRef.value?.setSoloLayer(soloLayer.value)
}

function toggleIdle() {
  idleEnabled.value = !idleEnabled.value
  stageRef.value?.playMotion(idleEnabled.value ? 'idle' : 'none')
}

function setExpression(id: string) {
  stageRef.value?.setExpression(id)
}

function playGesture(id: 'nod' | 'shake' | 'tilt') {
  stageRef.value?.playMotion(id)
}

async function exportZip() {
  if (!record.value || exporting.value) return
  exporting.value = true
  try {
    const blob = await exportCharacterZip(record.value)
    const saved = await downloadBlob(blob, `${record.value.name}.avatar.zip`)
    if (saved) ui.notify('角色包已导出', 'success')
  } catch (err) {
    ui.notify(userMessageForError(err), 'error')
  } finally {
    exporting.value = false
  }
}

async function exportPsd() {
  if (!record.value || exporting.value) return
  exporting.value = true
  try {
    const blob = await exportCharacterPsd(record.value)
    const saved = await downloadBlob(blob, `${record.value.name}.psd`)
    if (saved) ui.notify('PSD 已导出（仅图层，不含绑定）', 'success')
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 6000)
  } finally {
    exporting.value = false
  }
}

watch(ttsReady, (ready) => {
  if (!ready) ttsEnabled.value = false
})

onMounted(loadCharacter)

onBeforeUnmount(() => {
  controller?.abort()
  stopSpeech()
})
</script>

<template>
  <div v-if="loading" class="character-loading">
    <LoaderCircle :size="22" class="spin" />
    正在读取角色…
  </div>

  <div v-else-if="notFound || !record" class="character-missing">
    <p class="av-kicker">Not found</p>
    <h1 class="av-title">这个角色不在这里</h1>
    <p class="av-muted">可能已被删除，或角色包来自另一台设备。</p>
    <RouterLink to="/"><BaseButton variant="primary">返回工作室</BaseButton></RouterLink>
  </div>

  <div v-else class="character-page">
    <header class="character-head">
      <div class="character-identity">
        <RouterLink to="/" class="icon-link" aria-label="返回工作室"><ArrowLeft :size="16" /></RouterLink>
        <div>
          <div class="name-row">
            <h1 class="character-name av-title">{{ record.name }}</h1>
            <span class="av-pill">{{ tierText }}</span>
            <span class="av-pill is-ok"><span class="live-dot" /> 本地运行</span>
          </div>
          <p class="character-sub">
            {{ record.persona.occupation }} · {{ record.persona.speech.tone }}
          </p>
        </div>
      </div>
      <div class="character-actions">
        <RouterLink :to="`/character/${record.id}/edit`">
          <BaseButton size="sm"><template #icon><Pencil :size="14" /></template>编辑人设</BaseButton>
        </RouterLink>
        <BaseButton size="sm" :loading="exporting" @click="exportZip">
          <template #icon><FileArchive :size="14" /></template>
          导出 ZIP
        </BaseButton>
        <BaseButton size="sm" :loading="exporting" @click="exportPsd">
          <template #icon><Download :size="14" /></template>
          PSD
        </BaseButton>
        <BaseButton
          size="sm"
          :loading="mouthRebuilding"
          :disabled="mouthRebuilding"
          @click="rebuildMouth"
        >
          <template #icon><RotateCw :size="14" /></template>
          修复口腔
        </BaseButton>
        <BaseButton
          size="sm"
          :loading="mouthUpgrading"
          :disabled="mouthUpgrading"
          @click="upgradeMouth"
        >
          <template #icon><Smile :size="14" /></template>
          补张嘴素材
        </BaseButton>
      </div>
    </header>

    <div v-if="simplified" class="simplified-banner">
      <span class="banner-tag">简化模式</span>
      <span>{{ record.manifest.notes?.[0] ?? '部分图层未能自动拆分，已使用近似动作。' }}</span>
      <details v-if="record.manifest.notes?.length">
        <summary>查看原因</summary>
        <ul>
          <li v-for="note in record.manifest.notes" :key="note">{{ note }}</li>
        </ul>
      </details>
    </div>

    <div class="character-main">
      <section class="stage-shell">
        <div class="stage-topline">
          <button
            type="button"
            class="stage-label stage-layers-trigger"
            :class="{ 'is-open': showLayerPanel }"
            @click="showLayerPanel = !showLayerPanel"
          >
            <span class="live-dot" /> STAGE / {{ record.manifest.layerOrder.length }} LAYERS
            <Layers :size="12" />
          </button>
          <span class="stage-label">{{ record.manifest.canvas.width }} × {{ record.manifest.canvas.height }}</span>
        </div>

        <div v-if="showLayerPanel" class="layer-panel">
          <p class="layer-panel-title">图层</p>
          <div v-for="layer in stageLayers" :key="layer.id" class="layer-panel-row">
            <button
              type="button"
              class="layer-eye"
              :class="{ 'is-off': !isLayerVisible(layer.id) }"
              :aria-label="isLayerVisible(layer.id) ? `隐藏${layer.nameZh}` : `显示${layer.nameZh}`"
              @click="toggleLayer(layer.id)"
            >
              <Eye v-if="isLayerVisible(layer.id)" :size="13" />
              <EyeOff v-else :size="13" />
            </button>
            <button
              type="button"
              class="layer-panel-name"
              :class="{ 'is-solo': soloLayer === layer.id }"
              @click="soloLayerId(layer.id)"
            >
              {{ layer.nameZh }}
            </button>
            <span class="layer-panel-kind">{{ LAYER_KIND[layer.id] ?? '图层' }}</span>
            <span class="layer-panel-z">z{{ layer.z }}</span>
            <button
              type="button"
              class="layer-solo"
              :class="{ 'is-active': soloLayer === layer.id }"
              @click="soloLayerId(layer.id)"
            >
              独
            </button>
          </div>
          <div class="layer-panel-actions">
            <button type="button" @click="showAllLayers">全部显示</button>
            <button type="button" @click="hideAllLayers">全部隐藏</button>
          </div>
          <p class="layer-panel-note">
            「头」是唯一真正的部件，里面烤进了脸和整头头发（转头时脸和头发必须一起形变，所以头发不能单独拆走）。后发、前发是从同一头头发上再切一份的运动切片，单独关掉它们，底图里的头发还在。
          </p>
        </div>
        <AvatarStage
          ref="stageRef"
          :key="stageKey"
          :manifest="record.manifest"
          :rig="record.rig"
          :layers="record.layers"
          @ready="onStageReady"
          @error="ui.notify('舞台初始化失败，已切换为静态预览。', 'error', 6000)"
        />
        <div class="stage-controls">
          <button type="button" class="stage-control" @click="setExpression('neutral')">平静</button>
          <button type="button" class="stage-control" @click="setExpression('smile')">
            <Smile :size="14" /> 微笑
          </button>
          <button type="button" class="stage-control" @click="setExpression('sad')">难过</button>
          <button type="button" class="stage-control" @click="setExpression('angry')">生气</button>
          <button type="button" class="stage-control" @click="setExpression('surprised')">惊讶</button>
          <button type="button" class="stage-control" @click="blinkTest">
            <Zap :size="14" /> 眨眼
          </button>
          <button type="button" class="stage-control" @click="mouthTest">
            <MessageSquareText :size="14" /> 口型
          </button>
          <button type="button" class="stage-control" @click="playGesture('nod')">
            <ArrowDown :size="14" /> 点头
          </button>
          <button type="button" class="stage-control" @click="playGesture('shake')">
            <ArrowLeftRight :size="14" /> 摇头
          </button>
          <button type="button" class="stage-control" @click="playGesture('tilt')">
            <RotateCw :size="14" /> 歪头
          </button>
          <button
            type="button"
            class="stage-control"
            :class="{ 'is-active': idleEnabled }"
            :title="
              idleEnabled
                ? '关掉自动待机：摇头、呼吸、眨眼（转头跟随鼠标和头发摆动仍然保留）'
                : '开启自动待机：摇头、呼吸、眨眼'
            "
            @click="toggleIdle"
          >
            <Wind :size="14" /> {{ idleEnabled ? '待机' : '静止' }}
          </button>
        </div>
        <span v-if="speaking" class="speaking-badge"><span class="live-dot" /> 正在说话</span>
      </section>

      <aside class="chat-panel">
        <header class="chat-head">
          <div>
            <p class="chat-title">和 {{ record.persona.displayName }} 说话</p>
            <p class="chat-provider">
              <template v-if="chatProvider">
                {{ chatProvider.label }} · {{ chatModel || '未填模型' }}
                <span v-if="!chatReady" class="provider-warn">缺 Key</span>
              </template>
              <template v-else>未绑定智能体</template>
            </p>
          </div>
          <div class="chat-head-actions">
            <button
              type="button"
              class="tts-toggle"
              :class="{ 'is-on': ttsEnabled && ttsReady }"
              :disabled="!ttsReady"
              :aria-pressed="ttsEnabled && ttsReady"
              @click="ttsEnabled = !ttsEnabled"
            >
              <Volume2 v-if="ttsEnabled && ttsReady" :size="14" />
              <VolumeX v-else :size="14" />
              语音
            </button>
            <button type="button" class="icon-link" aria-label="清空聊天" @click="showClear = true">
              <Eraser :size="15" />
            </button>
          </div>
        </header>

        <div v-if="!chatReady" class="chat-setup">
          <MessageSquareText :size="18" />
          <div>
            <p>还没有可用的多模态智能体。</p>
            <RouterLink to="/settings/providers" class="av-link">去绑定服务商</RouterLink>
          </div>
        </div>

        <div v-else-if="ttsIssue" class="chat-setup is-warn">
          <VolumeX :size="18" />
          <div>
            <p>{{ ttsIssue }}</p>
            <RouterLink to="/settings/providers" class="av-link">去配置语音服务商</RouterLink>
          </div>
        </div>

        <div ref="messagesEl" class="chat-messages">
          <div
            v-for="(message, index) in messages"
            :key="`${message.ts}-${index}`"
            class="chat-message"
            :class="`is-${message.role}`"
          >
            <div class="message-meta">
              <span>{{ message.role === 'user' ? '你' : record.persona.displayName }}</span>
              <span>{{ formatTime(message.ts) }}</span>
            </div>
            <div class="message-bubble">
              <span v-if="message.text">{{ message.text }}</span>
              <span
                v-else-if="sending && index === messages.length - 1"
                class="typing-dots"
                aria-label="正在输入"
              >
                <i /><i /><i />
              </span>
            </div>
          </div>
          <div v-if="errorText" class="chat-error">{{ errorText }}</div>
        </div>

        <div v-if="greeting && !messages.length" class="chat-greeting">{{ greeting }}</div>

        <footer class="composer">
          <textarea
            v-model="prompt"
            class="composer-input"
            rows="2"
            :placeholder="chatReady ? '说点什么…' : '先配置智能体'"
            :disabled="!chatReady"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <div class="composer-foot">
            <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <div class="composer-actions">
              <BaseButton
                v-if="sending || speaking"
                size="sm"
                variant="danger"
                @click="stopAll"
              >
                <template #icon><Square :size="12" /></template>
                停止
              </BaseButton>
              <BaseButton
                size="sm"
                variant="primary"
                :loading="sending"
                :disabled="!prompt.trim() || !chatReady"
                @click="sendMessage"
              >
                <template #icon><Send :size="13" /></template>
                发送
              </BaseButton>
            </div>
          </div>
        </footer>
      </aside>
    </div>

    <p class="character-footnote">
      形象、表情和声音是表现层；角色包只保存在本机。当前是自研 2.5D 分层格式，不是 Live2D `.moc3`。
    </p>

    <Modal :open="showClear" title="清空聊天记录" width="420px" @close="showClear = false">
      <p class="delete-copy">会清空这个角色的本地对话记录，不影响人设、图层和绑定。</p>
      <template #footer>
        <BaseButton size="sm" @click="showClear = false">取消</BaseButton>
        <BaseButton size="sm" variant="danger" @click="clearHistory">清空</BaseButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.character-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.character-loading,
.character-missing {
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  color: var(--av-muted);
}

.character-missing h1 {
  font-size: 30px;
}

.spin {
  animation: spin 900ms linear infinite;
}

.character-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
}

.character-identity {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.icon-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--av-muted);
  flex-shrink: 0;
}

.icon-link:hover {
  color: var(--av-text);
  border-color: var(--av-border-strong);
}

.name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.character-name {
  font-size: clamp(27px, 3.4vw, 38px);
  line-height: 1.15;
}

.character-sub {
  color: var(--av-muted);
  font-size: 12px;
  margin-top: 4px;
}

.live-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--av-success);
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.65);
}

.character-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.simplified-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: 11px;
  border: 1px solid rgba(251, 191, 36, 0.16);
  background: rgba(251, 191, 36, 0.06);
  color: var(--av-muted);
  font-size: 11.5px;
}

.banner-tag {
  color: var(--av-warning);
  font-weight: 600;
  flex-shrink: 0;
}

.simplified-banner details {
  margin-left: auto;
  flex-shrink: 0;
}

.simplified-banner summary {
  cursor: pointer;
  color: var(--av-warning);
}

.simplified-banner ul {
  position: absolute;
  right: 24px;
  z-index: 20;
  width: min(420px, calc(100vw - 48px));
  margin-top: 8px;
  padding: 12px 16px 12px 28px;
  border-radius: 12px;
  border: 1px solid var(--av-border-strong);
  background: #151d2b;
  box-shadow: var(--av-shadow);
  line-height: 1.7;
}

.character-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 390px;
  gap: 16px;
  align-items: stretch;
}

.stage-shell {
  position: relative;
  height: min(72vh, 760px);
  min-height: 480px;
  overflow: hidden;
  border-radius: var(--av-radius-lg);
  border: 1px solid var(--av-border);
  background:
    radial-gradient(ellipse at 50% 78%, rgba(224, 164, 92, 0.1), transparent 46%),
    linear-gradient(180deg, #0d1420, #080c13);
  box-shadow: var(--av-shadow-soft);
}

.stage-topline {
  position: absolute;
  z-index: 5;
  top: 14px;
  left: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: none;
}

.stage-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--av-faint);
  font-size: 9px;
  letter-spacing: 0.16em;
}

.stage-layers-trigger {
  border: 0;
  background: transparent;
  padding: 2px 0;
  cursor: pointer;
  pointer-events: auto;
}

.stage-layers-trigger:hover,
.stage-layers-trigger.is-open {
  color: var(--av-accent);
}

.layer-panel {
  position: absolute;
  z-index: 7;
  top: 34px;
  left: 16px;
  width: 268px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--av-border);
  background: rgba(10, 15, 24, 0.94);
  box-shadow: var(--av-shadow-soft);
  backdrop-filter: blur(10px);
}

.layer-panel-title {
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--av-faint);
  margin-bottom: 8px;
}

.layer-panel-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 0;
}

.layer-eye {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--av-accent);
  cursor: pointer;
  flex-shrink: 0;
}

.layer-eye.is-off {
  color: var(--av-faint);
}

.layer-panel-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--av-text-soft);
  font-size: 11.5px;
  padding: 2px 0;
  cursor: pointer;
}

.layer-panel-name.is-solo {
  color: var(--av-accent);
}

.layer-panel-kind {
  font-size: 9px;
  color: var(--av-faint);
  border: 1px solid var(--av-border);
  border-radius: 4px;
  padding: 2px 4px;
  white-space: nowrap;
}

.layer-panel-z {
  font-size: 9.5px;
  color: var(--av-faint);
  font-variant-numeric: tabular-nums;
}

.layer-solo {
  border: 1px solid var(--av-border);
  border-radius: 5px;
  background: transparent;
  color: var(--av-faint);
  font-size: 9.5px;
  line-height: 1;
  padding: 3px 5px;
  cursor: pointer;
}

.layer-solo.is-active {
  border-color: var(--av-accent);
  color: var(--av-accent);
}

.layer-panel-actions {
  display: flex;
  gap: 6px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--av-border);
}

.layer-panel-actions button {
  border: 0;
  background: transparent;
  color: var(--av-muted);
  font-size: 10.5px;
  cursor: pointer;
  padding: 0;
}

.layer-panel-actions button:hover {
  color: var(--av-accent);
}

.layer-panel-note {
  margin-top: 9px;
  color: var(--av-faint);
  font-size: 9.5px;
  line-height: 1.6;
}

.stage-controls {
  position: absolute;
  z-index: 6;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 2px;
  width: max-content;
  max-width: calc(100% - 24px);
  padding: 3px;
  border-radius: 20px;
  border: 1px solid var(--av-border-strong);
  background: rgba(10, 15, 24, 0.7);
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
}

.stage-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--av-muted);
  font-size: 10.5px;
  white-space: nowrap;
}

.stage-control:hover {
  color: var(--av-text);
  background: rgba(255, 255, 255, 0.06);
}

.stage-control.is-active {
  color: var(--av-accent);
  background: var(--av-accent-soft);
}

.speaking-badge {
  position: absolute;
  z-index: 6;
  right: 16px;
  bottom: 20px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid rgba(94, 234, 212, 0.18);
  background: rgba(10, 15, 24, 0.68);
  color: var(--av-success);
  font-size: 10px;
  backdrop-filter: blur(10px);
}

.chat-panel {
  height: min(72vh, 760px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--av-radius-lg);
  border: 1px solid var(--av-border);
  background: var(--av-panel);
  backdrop-filter: blur(16px);
}

.chat-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 15px 16px 12px;
  border-bottom: 1px solid var(--av-border);
}

.chat-title {
  font-family: var(--av-font-serif);
  font-size: 16px;
}

.chat-provider {
  color: var(--av-faint);
  font-size: 10px;
  margin-top: 3px;
}

.provider-warn {
  color: var(--av-warning);
  margin-left: 5px;
}

.chat-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tts-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--av-border);
  background: transparent;
  color: var(--av-muted);
  font-size: 10px;
}

.tts-toggle.is-on {
  color: var(--av-success);
  border-color: rgba(94, 234, 212, 0.22);
  background: var(--av-success-soft);
}

.tts-toggle:disabled {
  opacity: 0.45;
}

.chat-setup {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 12px 14px 0;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1px solid rgba(224, 164, 92, 0.18);
  background: var(--av-accent-soft);
  color: var(--av-text-soft);
  font-size: 11.5px;
}

.chat-setup.is-warn {
  border-color: rgba(251, 191, 36, 0.2);
  background: rgba(251, 191, 36, 0.05);
}

.chat-setup svg {
  color: var(--av-accent);
  flex-shrink: 0;
  margin-top: 1px;
}

.chat-setup.is-warn svg {
  color: var(--av-warning);
}

.chat-messages {
  flex: 1;
  overflow: auto;
  padding: 14px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-message {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 92%;
}

.chat-message.is-user {
  align-self: flex-end;
  align-items: flex-end;
}

.chat-message.is-assistant {
  align-self: flex-start;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--av-faint);
  font-size: 9px;
}

.message-bubble {
  padding: 9px 12px;
  border-radius: 14px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.is-assistant .message-bubble {
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.035);
  border-top-left-radius: 5px;
  color: var(--av-text-soft);
}

.is-user .message-bubble {
  border: 1px solid rgba(224, 164, 92, 0.18);
  background: var(--av-accent-soft);
  border-top-right-radius: 5px;
  color: var(--av-text);
}

.typing-dots {
  display: inline-flex;
  gap: 3px;
  padding: 3px 0;
}

.typing-dots i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: var(--av-muted);
  animation: typing 1s infinite ease-in-out;
}

.typing-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.typing-dots i:nth-child(3) {
  animation-delay: 240ms;
}

.chat-error {
  align-self: center;
  color: var(--av-danger);
  font-size: 11px;
  text-align: center;
  padding: 6px 10px;
}

.chat-greeting {
  margin: 0 14px 10px;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1px dashed var(--av-border);
  color: var(--av-muted);
  font-size: 11px;
  text-align: center;
}

.composer {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--av-border);
  background: rgba(8, 12, 19, 0.35);
}

.composer-input {
  width: 100%;
  resize: none;
  border: 1px solid var(--av-border);
  border-radius: 13px;
  background: rgba(5, 9, 15, 0.5);
  color: var(--av-text);
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.6;
  outline: none;
}

.composer-input:focus {
  border-color: rgba(224, 164, 92, 0.45);
  box-shadow: 0 0 0 3px rgba(224, 164, 92, 0.08);
}

.composer-input:disabled {
  opacity: 0.55;
}

.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
}

.composer-hint {
  color: var(--av-faint);
  font-size: 9px;
}

.composer-actions {
  display: flex;
  gap: 6px;
}

.character-footnote {
  color: var(--av-faint);
  font-size: 10px;
  text-align: center;
  line-height: 1.6;
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

@keyframes typing {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@media (max-width: 980px) {
  .character-main {
    grid-template-columns: 1fr;
  }

  .stage-shell {
    height: 460px;
    min-height: 420px;
  }

  .chat-panel {
    height: 560px;
    min-height: 480px;
  }

  .character-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .character-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .stage-controls {
    gap: 1px;
    padding: 3px;
  }

  .stage-control {
    padding: 6px 8px;
    font-size: 10px;
  }

  .speaking-badge {
    display: none;
  }

  .simplified-banner {
    align-items: flex-start;
  }
}
</style>
