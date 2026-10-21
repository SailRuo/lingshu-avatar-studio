<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Play,
  ScanFace,
  Sparkles,
  Square,
  Volume2,
  Wand2,
} from 'lucide-vue-next'
import type { CharacterSpec } from '../types/character'
import type { ProviderRole } from '../types/provider'
import { useProviderStore } from '../stores/useProviderStore'
import { useCharacterStore } from '../stores/useCharacterStore'
import { useUiStore } from '../stores/useUiStore'
import { createCharacter, type CreateCharacterResult } from '../services/agent/createCharacter'
import { buildBasePrompt } from '../services/agent/prompts'
import { providerNeedsUserProxy } from '../services/platform/runtime'
import { userMessageForError, ProviderError } from '../services/providers/http'
import { pickReferenceId, synthesizeSpeech } from '../services/providers/tts'
import { fishLiveSupported, speakFishLive } from '../services/providers/fishLive'
import { SpeechQueue } from '../services/audio/ttsQueue'
import AvatarStage from '../components/stage/AvatarStage.vue'
import RoleConfigCard from '../components/settings/RoleConfigCard.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import Field from '../components/ui/Field.vue'
import HelpDot from '../components/ui/HelpDot.vue'

const router = useRouter()
const providers = useProviderStore()
const characters = useCharacterStore()
const ui = useUiStore()

const steps = [
  { id: 1, label: '服务商', detail: '接上你的模型' },
  { id: 2, label: '角色设定', detail: '写下第一印象' },
  { id: 3, label: '生成与绑定', detail: '自动拆分图层' },
  { id: 4, label: '人设与声音', detail: '让 TA 开口' },
]

const step = ref(1)
const busy = ref(false)
const error = ref('')
const result = ref<CreateCharacterResult | null>(null)
const progress = ref<{ label: string; detail?: string; progress?: number } | null>(null)
const showPrompt = ref(false)
const activePreset = ref('')
const controller = ref<AbortController | null>(null)
const stageRef = ref<InstanceType<typeof AvatarStage> | null>(null)
const testingVoice = ref(false)
const speech = new SpeechQueue()
let mouthFrame = 0

const spec = reactive<CharacterSpec>({
  name: '',
  description: '',
  style: 'soft anime cel shading, warm cinematic light',
  hair: '',
  eyes: '',
  outfit: '',
  palette: '',
  aspect: '2:3',
})

const styleOptions = [
  { value: 'soft anime cel shading, warm cinematic light', label: '柔和动画赛璐璐 · 暖光' },
  { value: 'clean anime cel shading, crisp line art, cool light', label: '清爽动画赛璐璐 · 冷光' },
  { value: 'semi-realistic anime illustration, soft painterly light', label: '半写实动画插画' },
  { value: 'chibi anime character, cute proportions, soft colors', label: 'Q 版角色' },
]

type CharacterPreset = Omit<CharacterSpec, 'seed'> & {
  id: string
  tagline: string
  swatch: string
}

const characterPresets: CharacterPreset[] = [
  {
    id: 'record-store',
    name: '青岚',
    tagline: '深夜唱片店主',
    description:
      '一位总在深夜整理旧唱片的年轻店主，安静、敏锐，偶尔有点毒舌。熟悉每张唱片背后的故事，对陌生人保持距离，却会为真正喜欢音乐的人留一盏灯。',
    style: 'soft anime cel shading, warm cinematic light',
    palette: '墨蓝、暖金、米白',
    hair: '黑色短发，额前碎发',
    eyes: '琥珀色眼睛，眼尾微垂',
    outfit: '深色高领毛衣，肩上披着旧外套',
    aspect: '2:3',
    swatch: 'linear-gradient(135deg, #26324d, #d3a052)',
  },
  {
    id: 'night-courier',
    name: '岚',
    tagline: '雨夜信使',
    description:
      '穿梭在霓虹雨幕里的城市信使，话少、动作快，把秘密送到该去的地方。外表冷淡，实际上会偷偷照顾巷子里的流浪猫。',
    style: 'clean anime cel shading, crisp line art, cool light',
    palette: '霓虹青、雨夜蓝、信号橙',
    hair: '银灰色短发，侧边一道蓝色挑染',
    eyes: '冰蓝色眼睛，目光锐利',
    outfit: '黑色机能风夹克，半透明雨披，腰间斜挎邮包',
    aspect: '2:3',
    swatch: 'linear-gradient(135deg, #123245, #34d6c1)',
  },
  {
    id: 'garden-musician',
    name: '疏影',
    tagline: '旧园琴师',
    description:
      '独居在旧园林里的琴师，性情温润，却像藏着一桩不愿提起的旧事。月夜会在水榭抚琴，很少见客。',
    style: 'semi-realistic anime illustration, soft painterly light',
    palette: '月白、黛青、浅金',
    hair: '及腰墨发，松挽发髻，插一支白玉簪',
    eyes: '浅茶色眼睛，神情温和',
    outfit: '月白交领长衫，外披黛青薄纱',
    aspect: '3:4',
    swatch: 'linear-gradient(135deg, #e8e2d2, #667d72)',
  },
  {
    id: 'seaside-barista',
    name: '小栗',
    tagline: '海边咖啡师',
    description:
      '海边小咖啡店的店员，笑起来很亮，喜欢给客人推荐当天的心情特调。对海风和甜点都没有抵抗力。',
    style: 'soft anime cel shading, warm cinematic light',
    palette: '奶油白、焦糖棕、海盐蓝',
    hair: '焦糖色微卷短发，别着贝壳发夹',
    eyes: '蜜糖色眼睛，笑起来弯成月牙',
    outfit: '米色针织开衫，白色围裙，袖口挽起',
    aspect: '3:4',
    swatch: 'linear-gradient(135deg, #f4e6d0, #b47a4c)',
  },
]

function applyPreset(preset: CharacterPreset) {
  spec.name = preset.name
  spec.description = preset.description
  spec.style = preset.style
  spec.palette = preset.palette
  spec.hair = preset.hair
  spec.eyes = preset.eyes
  spec.outfit = preset.outfit
  spec.aspect = preset.aspect
  activePreset.value = preset.id
}

const roles: ProviderRole[] = ['image', 'chat', 'tts']

const imageProvider = computed(() => providers.roleProvider('image'))
const agentProvider = computed(() => providers.roleProvider('chat'))
const ttsProvider = computed(() =>
  providers.isRoleReady('tts') ? providers.roleProvider('tts') : undefined,
)

const imageReady = computed(() => providers.isRoleReady('image'))
const agentReady = computed(() => providers.isRoleReady('chat'))
const ttsReady = computed(() => providers.isRoleReady('tts'))

const promptPreview = computed(() => buildBasePrompt(spec))

const traitsText = computed({
  get: () => result.value?.record.persona.personality.traits.join('、') ?? '',
  set: (value: string) => {
    if (!result.value) return
    result.value.record.persona.personality.traits = value
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})

const valuesText = computed({
  get: () => result.value?.record.persona.personality.values.join('、') ?? '',
  set: (value: string) => {
    if (!result.value) return
    result.value.record.persona.personality.values = value
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  },
})

const boundariesText = computed({
  get: () => result.value?.record.persona.boundaries.join('\n') ?? '',
  set: (value: string) => {
    if (!result.value) return
    result.value.record.persona.boundaries = value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
  },
})

function goStep(target: number) {
  if (target < step.value) {
    step.value = target
    return
  }
  if (target === 2) {
    if (!imageReady.value) {
      ui.notify('先给生图角色绑定一个带 Key 的服务商。', 'error')
      return
    }
    step.value = 2
    return
  }
  if (target === 3) {
    void startGenerate()
    return
  }
  if (target === 4) {
    if (!result.value) {
      ui.notify('先生成并接受一个角色。', 'error')
      return
    }
    step.value = 4
  }
}

async function startGenerate() {
  if (!spec.name.trim()) {
    ui.notify('先给角色起一个名字。', 'error')
    return
  }
  if (!spec.description.trim()) {
    ui.notify('写一句角色设定，再开始生成。', 'error')
    return
  }
  if (!imageReady.value || !imageProvider.value) {
    ui.notify('生图服务商还没有就绪（缺 Key 或自备代理）。', 'error')
    return
  }
  const imageKey = await providers.getKey(imageProvider.value.id)
  if (!imageKey) {
    ui.notify('没有读取到生图 Key，请重新保存。', 'error')
    return
  }
  let agentKey: string | undefined
  if (agentReady.value && agentProvider.value) {
    agentKey = await providers.getKey(agentProvider.value.id)
  }

  error.value = ''
  result.value = null
  busy.value = true
  step.value = 3
  controller.value = new AbortController()
  const current = controller.value
  try {
    const created = await createCharacter({
      spec,
      imageProvider: imageProvider.value,
      imageKey,
      imageModel: providers.roleModel('image'),
      agentProvider: agentReady.value ? agentProvider.value : undefined,
      agentKey,
      agentModel: providers.roleModel('chat'),
      signal: current.signal,
      onProgress: (event) => {
        progress.value = event
      },
    })
    if (current.signal.aborted) return
    result.value = created
    result.value.record.persona.greeting =
      result.value.record.persona.greeting || `你好，我是${created.record.name}。`
    result.value.record.persona.voice.providerId = ttsProvider.value?.id
    result.value.record.persona.voice.model = ttsProvider.value
      ? providers.roleModel('tts') || undefined
      : undefined
    result.value.record.persona.voice.voiceId = ttsProvider.value
      ? providers.roleVoiceValue() || undefined
      : undefined
  } catch (err) {
    if (current.signal.aborted) return
    error.value = userMessageForError(err)
    if (err instanceof ProviderError && err.kind === 'cors') error.value += ' 可在服务商设置里配置代理。'
  } finally {
    if (controller.value === current) {
      busy.value = false
      controller.value = null
    }
  }
}

function cancelGenerate() {
  controller.value?.abort()
  controller.value = null
  busy.value = false
  progress.value = null
  ui.notify('已取消本次生成', 'info')
}

function regenerate() {
  result.value = null
  error.value = ''
  step.value = 2
}

function goPersona() {
  if (!result.value) return
  step.value = 4
}

function pumpMouth() {
  if (!testingVoice.value) {
    stageRef.value?.setMouthOpen(0)
    return
  }
  stageRef.value?.setMouthShape(speech.mouthShape())
  mouthFrame = requestAnimationFrame(pumpMouth)
}

async function testVoice() {
  if (!result.value || !ttsProvider.value) {
    ui.notify('先绑定一个语音服务商。', 'error')
    return
  }
  const key = await providers.getKey(ttsProvider.value.id)
  if (!key) {
    ui.notify('语音服务商还没有 Key。', 'error')
    return
  }
  speech.stop()
  testingVoice.value = true
  cancelAnimationFrame(mouthFrame)
  mouthFrame = requestAnimationFrame(pumpMouth)
  try {
    const text = result.value.record.persona.greeting || `你好，我是${result.value.record.name}。`
    const provider = ttsProvider.value
    const voice = providers.roleVoiceValue()
    const model = providers.roleModel('tts')
    if (provider.kind === 'fishaudio' && fishLiveSupported()) {
      await speech.speak(text, {
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
      })
    } else {
      await speech.speak(text, {
        synthesize: (sentence, signal) =>
          synthesizeSpeech({
            provider,
            apiKey: key,
            text: sentence,
            voice,
            modelOverride: model,
            signal,
          }),
      })
    }
  } catch (err) {
    ui.notify(userMessageForError(err), 'error', 6000)
  } finally {
    testingVoice.value = false
    cancelAnimationFrame(mouthFrame)
    stageRef.value?.setMouthOpen(0)
  }
}

async function saveCharacter() {
  if (!result.value) return
  const record = result.value.record
  record.persona.voice.providerId = ttsProvider.value?.id
  record.persona.voice.model = ttsProvider.value
    ? providers.roleModel('tts') || undefined
    : undefined
  record.persona.voice.voiceId = ttsProvider.value
    ? providers.roleVoiceValue() || undefined
    : undefined
  const name = record.persona.displayName.trim() || spec.name.trim() || '未命名角色'
  record.name = name
  record.manifest.name = name
  record.updatedAt = Date.now()
  record.manifest.updatedAt = record.updatedAt
  await characters.save(record)
  ui.notify('角色已保存到本机', 'success')
  router.push(`/character/${record.id}`)
}

function tierLabel(tier: string): string {
  if (tier === 'full') return '完整分层绑定'
  if (tier === 'layered-lite') return '基础分层绑定'
  if (tier === 'portrait-plus') return '半身动态'
  return '单图动态'
}

onMounted(async () => {
  await providers.refreshKeyPresence()
})

onBeforeUnmount(() => {
  controller.value?.abort()
  speech.stop()
  cancelAnimationFrame(mouthFrame)
})
</script>

<template>
  <div class="create">
    <header class="create-head">
      <div>
        <p class="av-kicker">Creation pipeline</p>
        <h1 class="create-title av-title">创建数字人</h1>
        <p class="create-sub">生成立绘 → 自动分层 → 绑定表情与口型 → 写入人设</p>
      </div>
      <RouterLink to="/" class="back-link"><ArrowLeft :size="14" /> 返回工作室</RouterLink>
    </header>

    <div class="create-layout">
      <section class="wizard">
        <nav class="stepper" aria-label="创建步骤">
          <button
            v-for="item in steps"
            :key="item.id"
            type="button"
            class="step"
            :class="{
              'is-current': step === item.id,
              'is-done': step > item.id,
              'is-locked': item.id > step && !(item.id === 4 && result) && item.id !== 2,
            }"
            @click="goStep(item.id)"
          >
            <span class="step-number">
              <Check v-if="step > item.id" :size="12" />
              <template v-else>{{ item.id }}</template>
            </span>
            <span class="step-copy">
              <span class="step-label">{{ item.label }}</span>
              <span class="step-detail">{{ item.detail }}</span>
            </span>
          </button>
        </nav>

        <div class="wizard-card av-card">
          <template v-if="step === 1">
            <div class="panel-head">
              <div>
                <p class="av-kicker">Step 01</p>
                <h2 class="panel-title">接上你的模型</h2>
              </div>
              <RouterLink to="/settings/providers" class="panel-link">服务商设置 <ArrowRight :size="13" /></RouterLink>
            </div>
            <p class="panel-desc">
              模型请求由本机直接发出，密钥只留在这台设备，不经过本站服务器。生图是必需项，其余可稍后配置。
            </p>
            <div class="create-role-grid">
              <RoleConfigCard v-for="role in roles" :key="role" :role="role" compact />
            </div>
            <p v-if="providerNeedsUserProxy(imageProvider)" class="provider-warning">
              当前是网页版运行，这个生图服务商需要自备代理；本站不提供代理。请到服务商详情填写你自己的代理，或下载桌面客户端 / 换用 OpenAI / 火山 / 硅基流动等可直连服务商。
            </p>
            <div class="panel-actions">
              <RouterLink to="/settings/providers">
                <BaseButton size="sm"><template #icon><KeyRound :size="14" /></template>管理密钥</BaseButton>
              </RouterLink>
              <BaseButton variant="primary" :disabled="!imageReady" @click="goStep(2)">
                下一步：角色设定 <ArrowRight :size="14" />
              </BaseButton>
            </div>
          </template>

          <template v-else-if="step === 2">
            <div class="panel-head">
              <div>
                <p class="av-kicker">Step 02</p>
                <h2 class="panel-title">写下第一印象</h2>
              </div>
              <span class="av-pill">{{ imageProvider?.label ?? '未绑定生图' }}</span>
            </div>
            <div class="preset-block">
              <div class="preset-head">
                <span class="preset-label">快速预设</span>
                <span class="preset-note">点一个，自动填好下面的全部内容</span>
              </div>
              <div class="preset-grid">
                <button
                  v-for="preset in characterPresets"
                  :key="preset.id"
                  type="button"
                  class="preset-card"
                  :class="{ 'is-active': activePreset === preset.id }"
                  :aria-pressed="activePreset === preset.id"
                  @click="applyPreset(preset)"
                >
                  <span class="preset-swatch" :style="{ background: preset.swatch }" aria-hidden="true" />
                  <span class="preset-copy">
                    <span class="preset-name">{{ preset.name }}</span>
                    <span class="preset-tagline">{{ preset.tagline }}</span>
                  </span>
                  <Check v-if="activePreset === preset.id" :size="12" class="preset-check" />
                </button>
              </div>
            </div>
            <div class="form-grid">
              <Field label="名字" for-id="character-name">
                <input id="character-name" v-model="spec.name" class="av-input" placeholder="例如：青岚" maxlength="24" />
              </Field>
              <Field label="画幅">
                <select v-model="spec.aspect" class="av-select">
                  <option value="2:3">2:3 · 竖版立绘</option>
                  <option value="3:4">3:4 · 半身</option>
                  <option value="1:1">1:1 · 方形</option>
                </select>
              </Field>
            </div>
            <Field label="角色设定" for-id="character-desc" class="spaced">
              <textarea
                id="character-desc"
                v-model="spec.description"
                class="av-textarea"
                rows="4"
                placeholder="例如：一位总在深夜整理旧唱片的年轻店主，安静、敏锐，偶尔有点毒舌。"
              />
            </Field>
            <div class="form-grid spaced">
              <Field label="画风">
                <select v-model="spec.style" class="av-select">
                  <option v-for="option in styleOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </Field>
              <Field label="配色">
                <input v-model="spec.palette" class="av-input" placeholder="例如：墨蓝、暖金、米白" />
              </Field>
              <Field label="发型">
                <input v-model="spec.hair" class="av-input" placeholder="例如：黑色短发，额前碎发" />
              </Field>
              <Field label="眼睛">
                <input v-model="spec.eyes" class="av-input" placeholder="例如：琥珀色眼睛，眼尾微垂" />
              </Field>
              <Field label="服装" class="span-2">
                <input v-model="spec.outfit" class="av-input" placeholder="例如：深色高领毛衣，肩上披着旧外套" />
              </Field>
            </div>

            <button type="button" class="prompt-toggle" @click="showPrompt = !showPrompt">
              <Wand2 :size="14" />
              查看生图 Prompt
              <ChevronDown :size="14" :class="{ 'is-open': showPrompt }" />
            </button>
            <pre v-if="showPrompt" class="prompt-preview">{{ promptPreview }}</pre>

            <div class="panel-actions">
              <BaseButton size="sm" @click="step = 1"><ArrowLeft :size="14" /> 上一步</BaseButton>
              <BaseButton
                variant="primary"
                :disabled="!spec.name.trim() || !spec.description.trim() || !imageReady"
                @click="startGenerate"
              >
                <template #icon><Sparkles :size="15" /></template>
                生成角色
              </BaseButton>
            </div>
            <p class="cost-note">
              <HelpDot>生成会调用一次生图模型；多模态分析只有在绑定了智能体模型时才会调用。</HelpDot>
              本次预计 1 次生图调用{{ agentReady ? ' + 1 次多模态分析' : '' }}。费用由你的服务商账户结算。
            </p>
          </template>

          <template v-else-if="step === 3">
            <div class="panel-head">
              <div>
                <p class="av-kicker">Step 03</p>
                <h2 class="panel-title">{{ busy ? '正在生成与绑定' : result ? '角色已经能动了' : '生成没有完成' }}</h2>
              </div>
              <span v-if="result" class="av-pill is-ok">{{ tierLabel(result.record.manifest.tier) }}</span>
            </div>

            <div v-if="busy" class="progress-panel">
              <div class="progress-top">
                <span class="progress-spinner"><LoaderCircle :size="20" class="spin" /></span>
                <div>
                  <p class="progress-label">{{ progress?.label ?? '准备中' }}</p>
                  <p class="progress-detail">{{ progress?.detail ?? '请保持页面在前台' }}</p>
                </div>
              </div>
              <div class="progress-track">
                <span :style="{ width: `${Math.round((progress?.progress ?? 0.04) * 100)}%` }" />
              </div>
              <div class="progress-actions">
                <span class="av-muted">首次加载本地人脸与分割模型可能需要几秒。</span>
                <BaseButton size="sm" variant="danger" @click="cancelGenerate">
                  <template #icon><Square :size="13" /></template>
                  取消
                </BaseButton>
              </div>
            </div>

            <div v-else-if="error" class="error-panel">
              <p>{{ error }}</p>
              <div class="error-actions">
                <BaseButton size="sm" @click="regenerate">返回设定</BaseButton>
                <RouterLink to="/settings/providers"><BaseButton size="sm">检查服务商</BaseButton></RouterLink>
                <BaseButton size="sm" variant="primary" @click="startGenerate">重试</BaseButton>
              </div>
            </div>

            <template v-else-if="result">
              <div class="result-summary">
                <div class="summary-item">
                  <span class="summary-label">能力档位</span>
                  <strong>{{ tierLabel(result.record.manifest.tier) }}</strong>
                </div>
                <div class="summary-item">
                  <span class="summary-label">图层</span>
                  <strong>{{ Object.keys(result.record.manifest.layers).length }} 层</strong>
                </div>
                <div class="summary-item">
                  <span class="summary-label">画布</span>
                  <strong>{{ result.record.manifest.canvas.width }} × {{ result.record.manifest.canvas.height }}</strong>
                </div>
                <div class="summary-item">
                  <span class="summary-label">多模态分析</span>
                  <strong>{{ result.analysis ? `${Math.round(result.analysis.qa.overallScore * 100)} 分` : '未启用' }}</strong>
                </div>
              </div>

              <div v-if="result.record.manifest.notes?.length" class="notes-panel">
                <p class="notes-title">绑定说明</p>
                <ul>
                  <li v-for="note in result.record.manifest.notes" :key="note">{{ note }}</li>
                </ul>
              </div>

              <div v-if="result.analysis?.qa.issues?.length" class="notes-panel">
                <p class="notes-title">智能体提示</p>
                <ul>
                  <li v-for="issue in result.analysis.qa.issues" :key="issue.code">
                    {{ issue.message }}
                  </li>
                </ul>
              </div>

              <div class="layer-chips">
                <span v-for="(layer, id) in result.record.manifest.layers" :key="id" class="av-pill">
                  {{ layer?.nameZh ?? id }}
                </span>
              </div>

              <div class="panel-actions">
                <BaseButton size="sm" @click="regenerate">重新生成</BaseButton>
                <BaseButton variant="primary" @click="goPersona">
                  继续设置人设 <ArrowRight :size="14" />
                </BaseButton>
              </div>
            </template>
          </template>

          <template v-else-if="step === 4 && result">
            <div class="panel-head">
              <div>
                <p class="av-kicker">Step 04</p>
                <h2 class="panel-title">让 TA 开口</h2>
              </div>
              <span class="av-pill">{{ result.record.name }}</span>
            </div>
            <div class="form-grid">
              <Field label="显示名" for-id="persona-name">
                <input id="persona-name" v-model="result.record.persona.displayName" class="av-input" maxlength="24" />
              </Field>
              <Field label="职业">
                <input v-model="result.record.persona.occupation" class="av-input" placeholder="例如：旧唱片店主" />
              </Field>
            </div>
            <Field label="说话风格" class="spaced">
              <input v-model="result.record.persona.speech.tone" class="av-input" placeholder="例如：自然、简短、偶尔冷幽默" />
            </Field>
            <div class="form-grid spaced">
              <Field label="性格关键词">
                <input v-model="traitsText" class="av-input" placeholder="用顿号分隔" />
              </Field>
              <Field label="在意的事">
                <input v-model="valuesText" class="av-input" placeholder="用顿号分隔" />
              </Field>
            </div>
            <Field label="开场白" class="spaced">
              <textarea v-model="result.record.persona.greeting" class="av-textarea" rows="2" />
            </Field>
            <Field label="背景" class="spaced">
              <textarea v-model="result.record.persona.background" class="av-textarea" rows="3" />
            </Field>
            <Field label="边界" class="spaced" help="每行一条。边界会写进系统提示，避免角色越界。">
              <textarea v-model="boundariesText" class="av-textarea" rows="3" />
            </Field>

            <div class="voice-section">
              <div class="voice-head">
                <div>
                  <p class="voice-title"><Volume2 :size="15" /> 声音</p>
                  <p class="voice-desc">服务商、模型和音色在「用途配置」里统一选择。</p>
                </div>
                <span class="av-pill" :class="{ 'is-ok': ttsReady }">{{ ttsReady ? '可试听' : '未配置' }}</span>
              </div>
              <div class="voice-summary">
                <div>
                  <span>服务商</span>
                  <strong>{{ ttsProvider?.label ?? '未选择' }}</strong>
                </div>
                <div>
                  <span>模型</span>
                  <strong class="av-mono">{{ ttsProvider ? providers.roleModel('tts') || '未选择' : '未选择' }}</strong>
                </div>
                <div>
                  <span>音色</span>
                  <strong class="av-mono">{{ ttsProvider ? providers.roleVoiceValue() || '服务商默认' : '未选择' }}</strong>
                </div>
                <RouterLink to="/settings/providers" class="voice-config-link">修改语音配置</RouterLink>
              </div>
              <div class="voice-actions">
                <BaseButton size="sm" :disabled="!ttsReady || testingVoice" @click="testVoice">
                  <template #icon><Play :size="14" /></template>
                  {{ testingVoice ? '正在播放' : '试听开场白' }}
                </BaseButton>
                <span class="av-muted">会调用一次 TTS 并驱动口型。</span>
              </div>
            </div>

            <div class="panel-actions">
              <BaseButton size="sm" @click="step = 3"><ArrowLeft :size="14" /> 返回预览</BaseButton>
              <BaseButton variant="primary" @click="saveCharacter">
                <template #icon><Check :size="15" /></template>
                保存并进入舞台
              </BaseButton>
            </div>
          </template>
        </div>
      </section>

      <aside class="preview-panel">
        <div class="preview-card av-card">
          <div class="preview-head">
            <div>
              <p class="av-kicker">Live preview</p>
              <h2 class="preview-title">{{ result?.record.name ?? (spec.name || '未命名角色') }}</h2>
            </div>
            <span class="av-pill">{{ result ? tierLabel(result.record.manifest.tier) : '等待生成' }}</span>
          </div>
          <div class="preview-stage">
            <AvatarStage
              v-if="result"
              ref="stageRef"
              :key="result.record.id"
              :manifest="result.record.manifest"
              :rig="result.record.rig"
              :layers="result.record.layers"
            />
            <div v-else class="preview-placeholder">
              <div class="placeholder-face">
                <span class="placeholder-eye" />
                <span class="placeholder-eye" />
                <span class="placeholder-mouth" />
              </div>
              <p>生成立绘后，这里会变成可动舞台。</p>
            </div>
          </div>
          <div class="preview-foot">
            <span><ScanFace :size="13" /> {{ result ? '自动绑定完成' : '等待智能体分析' }}</span>
            <span v-if="result?.analysis">{{ result.analysis.character.style }}</span>
          </div>
        </div>
        <p class="preview-note">
          输出为自研 2.5D 角色包，不是 Live2D `.moc3`。导出的 PSD 可在 Cubism Editor 里继续手工绑定。
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.create {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.create-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.create-title {
  font-size: clamp(30px, 4vw, 44px);
  margin: 6px 0 8px;
}

.create-sub {
  color: var(--av-muted);
  font-size: 13px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--av-muted);
  font-size: 12px;
  padding-bottom: 4px;
}

.back-link:hover {
  color: var(--av-accent);
}

.create-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr);
  gap: 22px;
  align-items: start;
}

.wizard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.stepper {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--av-muted);
  text-align: left;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
}

.step:hover {
  background: rgba(255, 255, 255, 0.03);
}

.step.is-current {
  border-color: rgba(224, 164, 92, 0.24);
  background: var(--av-accent-soft);
  color: var(--av-text);
}

.step.is-done {
  color: var(--av-text-soft);
}

.step.is-locked {
  opacity: 0.5;
}

.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid var(--av-border-strong);
  font-size: 11px;
  flex-shrink: 0;
}

.step.is-current .step-number {
  color: #23180b;
  background: var(--av-accent);
  border-color: transparent;
}

.step.is-done .step-number {
  color: var(--av-success);
  border-color: rgba(94, 234, 212, 0.35);
}

.step-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.step-label {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.step-detail {
  font-size: 10px;
  color: var(--av-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wizard-card {
  padding: 22px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 10px;
}

.panel-title {
  font-family: var(--av-font-serif);
  font-size: 24px;
  margin-top: 3px;
}

.panel-desc {
  color: var(--av-muted);
  font-size: 13px;
  line-height: 1.75;
  max-width: 640px;
  margin-bottom: 18px;
}

.preset-block {
  margin-bottom: 18px;
}

.preset-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.preset-label {
  color: var(--av-muted);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.preset-note {
  color: var(--av-faint);
  font-size: 10px;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.preset-card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border-radius: 11px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.02);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
}

.preset-card:hover,
.preset-card.is-active {
  border-color: rgba(224, 164, 92, 0.38);
  background: var(--av-accent-soft);
}

.preset-swatch {
  width: 20px;
  height: 20px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  flex-shrink: 0;
}

.preset-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.preset-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--av-text);
}

.preset-tagline {
  color: var(--av-faint);
  font-size: 9.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset-check {
  margin-left: auto;
  color: var(--av-accent);
  flex-shrink: 0;
}

.panel-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--av-accent);
  font-size: 12px;
  white-space: nowrap;
}

.create-role-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.role-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.role-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 13px;
  border-radius: 13px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.022);
}

.role-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--av-accent-soft);
  color: var(--av-accent);
  flex-shrink: 0;
}

.role-copy {
  flex: 1;
  min-width: 0;
}

.role-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
}

.required-tag {
  color: var(--av-accent);
  font-size: 10px;
  font-weight: 500;
}

.role-desc {
  color: var(--av-faint);
  font-size: 11px;
  margin-top: 1px;
}

.role-select {
  width: 190px;
  flex-shrink: 0;
  padding: 8px 10px;
  font-size: 12px;
}

.provider-warning {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid rgba(251, 191, 36, 0.16);
  background: rgba(251, 191, 36, 0.05);
  color: var(--av-muted);
  font-size: 11px;
  line-height: 1.65;
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 22px;
  flex-wrap: wrap;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.form-grid.spaced {
  margin-top: 14px;
}

.span-2 {
  grid-column: 1 / -1;
}

.spaced {
  margin-top: 14px;
}

.prompt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--av-muted);
  font-size: 12px;
}

.prompt-toggle:hover {
  color: var(--av-accent);
}

.prompt-toggle svg:last-child {
  transition: transform 150ms ease;
}

.prompt-toggle svg.is-open {
  transform: rotate(180deg);
}

.prompt-preview {
  margin-top: 10px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--av-border);
  background: rgba(4, 8, 14, 0.55);
  color: var(--av-muted);
  font-family: var(--av-font-sans);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.cost-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 12px;
  color: var(--av-faint);
  font-size: 11px;
  line-height: 1.6;
}

.progress-panel {
  padding: 18px;
  border-radius: 14px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.025);
}

.progress-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-spinner {
  display: inline-flex;
  color: var(--av-accent);
}

.progress-label {
  font-size: 14px;
  font-weight: 600;
}

.progress-detail {
  color: var(--av-muted);
  font-size: 12px;
  margin-top: 2px;
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
  margin: 16px 0 12px;
}

.progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--av-accent), var(--av-accent-strong));
  transition: width 300ms ease;
}

.progress-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}

.spin {
  animation: spin 900ms linear infinite;
}

.error-panel {
  padding: 16px;
  border-radius: 13px;
  border: 1px solid rgba(251, 113, 133, 0.26);
  background: var(--av-danger-soft);
  color: var(--av-text-soft);
  font-size: 13px;
  line-height: 1.7;
}

.error-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.result-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.summary-item {
  padding: 11px 12px;
  border-radius: 11px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.summary-label {
  color: var(--av-faint);
  font-size: 10px;
}

.summary-item strong {
  font-size: 13px;
  font-weight: 600;
}

.notes-panel {
  margin-top: 14px;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.02);
}

.notes-title {
  color: var(--av-text-soft);
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 5px;
}

.notes-panel ul {
  margin: 0;
  padding-left: 16px;
  color: var(--av-muted);
  font-size: 12px;
  line-height: 1.7;
}

.layer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}

.voice-section {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--av-border);
}

.voice-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.voice-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.voice-desc {
  color: var(--av-faint);
  font-size: 11px;
  margin-top: 2px;
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

.voice-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 11px;
}

.preview-panel {
  position: sticky;
  top: 92px;
  min-width: 0;
}

.preview-card {
  overflow: hidden;
}

.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 16px 18px 12px;
}

.preview-title {
  font-family: var(--av-font-serif);
  font-size: 20px;
  margin-top: 3px;
}

.preview-stage {
  position: relative;
  height: min(58vh, 560px);
  min-height: 360px;
  border-top: 1px solid var(--av-border);
  border-bottom: 1px solid var(--av-border);
}

.preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  color: var(--av-faint);
  font-size: 12px;
  text-align: center;
  padding: 22px;
}

.placeholder-face {
  position: relative;
  width: 112px;
  height: 136px;
  border-radius: 46% 46% 44% 44% / 42% 42% 58% 58%;
  border: 1px solid rgba(224, 164, 92, 0.22);
  background: linear-gradient(160deg, rgba(224, 164, 92, 0.12), rgba(125, 211, 252, 0.04));
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 17px;
}

.placeholder-eye {
  width: 11px;
  height: 5px;
  border-radius: 999px;
  background: rgba(224, 164, 92, 0.7);
}

.placeholder-mouth {
  position: absolute;
  left: 50%;
  bottom: 28px;
  width: 22px;
  height: 6px;
  transform: translateX(-50%);
  border-radius: 0 0 10px 10px;
  border-bottom: 2px solid rgba(224, 164, 92, 0.4);
}

.preview-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 18px;
  color: var(--av-faint);
  font-size: 11px;
}

.preview-foot span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.preview-note {
  margin-top: 10px;
  padding: 0 4px;
  color: var(--av-faint);
  font-size: 11px;
  line-height: 1.6;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 980px) {
  .create-layout {
    grid-template-columns: 1fr;
  }

  .create-role-grid {
    grid-template-columns: 1fr;
  }

  .preset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .preview-panel {
    position: static;
    order: -1;
  }

  .preview-stage {
    height: 360px;
  }

  .stepper {
    grid-template-columns: repeat(4, minmax(150px, 1fr));
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .step-detail {
    display: none;
  }
}

@media (max-width: 640px) {
  .form-grid,
  .result-summary,
  .voice-summary {
    grid-template-columns: 1fr;
  }

  .span-2 {
    grid-column: auto;
  }

  .role-card {
    flex-wrap: wrap;
  }

  .role-select {
    width: 100%;
  }

  .wizard-card {
    padding: 17px;
  }

  .create-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
