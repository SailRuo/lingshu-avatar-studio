<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  ArrowRight,
  ChevronRight,
  Image,
  KeyRound,
  Plus,
  ScanFace,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-vue-next'
import type { CharacterMeta } from '../types/character'
import { useCharacterStore } from '../stores/useCharacterStore'
import { useProviderStore } from '../stores/useProviderStore'
import { useUiStore } from '../stores/useUiStore'
import { providerNeedsUserProxy } from '../services/platform/runtime'
import { importCharacterZip } from '../services/pack/importZip'
import BaseButton from '../components/ui/BaseButton.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Modal from '../components/ui/Modal.vue'

const router = useRouter()
const characters = useCharacterStore()
const providers = useProviderStore()
const ui = useUiStore()

const fileInput = ref<HTMLInputElement | null>(null)
const deleteTarget = ref<CharacterMeta | null>(null)
const importing = ref(false)
const heroImageFailed = ref(false)

const roles = [
  { id: 'image' as const, label: '生图', icon: Image },
  { id: 'chat' as const, label: '智能体', icon: ScanFace },
  { id: 'tts' as const, label: '语音', icon: Volume2 },
]

function roleLabel(role: (typeof roles)[number]['id']): string {
  const provider = providers.roleProvider(role)
  if (!provider || !providers.hasKey(provider.id) || !provider.baseUrl) return '未配置服务商'
  if (providerNeedsUserProxy(provider)) return `${provider.label} · 网页版需代理`
  const model = providers.roleModel(role)
  return model ? `${provider.label} · ${model}` : provider.label
}

function tierLabel(tier: CharacterMeta['tier']): string {
  if (tier === 'full') return '完整绑定'
  if (tier === 'layered-lite') return '基础分层'
  if (tier === 'portrait-plus') return '半身动态'
  return '单图动态'
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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

async function confirmDelete() {
  if (!deleteTarget.value) return
  await characters.remove(deleteTarget.value.id)
  ui.notify('角色已删除', 'success')
  deleteTarget.value = null
}

onMounted(async () => {
  await Promise.all([characters.load(), providers.refreshKeyPresence()])
})
</script>

<template>
  <div class="home">
    <section class="hero">
      <div class="hero-copy">
        <p class="av-kicker">Browser studio · bring your own keys</p>
        <h1 class="hero-title av-title">
          把一张设定，
          <br />
          变成会呼吸的数字人。
        </h1>
        <p class="hero-desc">
          接上你自己的生图模型与多模态模型。生成正面立绘，自动拆分图层、绑定表情与口型，
          然后和 TA 说话。角色包保存在本机，密钥不上传。
        </p>
        <div class="hero-actions">
          <RouterLink to="/create">
            <BaseButton variant="primary" size="lg">
              <template #icon><Sparkles :size="16" /></template>
              开始创建
            </BaseButton>
          </RouterLink>
          <BaseButton size="lg" @click="fileInput?.click()">
            <template #icon><Upload :size="16" /></template>
            导入角色包
          </BaseButton>
        </div>
        <div class="hero-facts">
          <span><KeyRound :size="14" /> BYOK · 本地密钥</span>
          <span><ScanFace :size="14" /> 自动分层与绑骨</span>
          <span><Sparkles :size="14" /> 不是 Live2D，不生成 .moc3</span>
        </div>
      </div>

      <div class="hero-art" aria-hidden="true">
        <div class="art-orbit orbit-one" />
        <div class="art-orbit orbit-two" />
        <div class="art-frame">
          <img
            v-if="!heroImageFailed"
            class="art-portrait"
            src="/brand/hero-character.png"
            alt=""
            @error="heroImageFailed = true"
          />
          <div v-else class="art-fallback">
            <div class="art-head">
              <span class="art-hair art-hair-back" />
              <span class="art-face">
                <span class="art-brow left" />
                <span class="art-brow right" />
                <span class="art-eye left" />
                <span class="art-eye right" />
                <span class="art-mouth" />
              </span>
              <span class="art-hair art-hair-front" />
            </div>
            <span class="art-shoulder left" />
            <span class="art-shoulder right" />
            <span class="art-collar" />
          </div>
          <span class="art-vignette" />
        </div>
        <span class="art-caption">LIVE LAYERS / 2.5D</span>
      </div>
    </section>

    <section class="readiness">
      <div class="readiness-head">
        <div>
          <p class="av-kicker">Connection</p>
          <h2 class="section-title">创作链路</h2>
        </div>
        <RouterLink to="/settings/providers" class="readiness-link">
          管理服务商 <ChevronRight :size="14" />
        </RouterLink>
      </div>
      <div class="readiness-grid">
        <RouterLink
          v-for="role in roles"
          :key="role.id"
          to="/settings/providers"
          class="readiness-card"
          :class="{ 'is-ready': providers.isRoleReady(role.id) }"
        >
          <span class="readiness-icon"><component :is="role.icon" :size="17" /></span>
          <span class="readiness-copy">
            <span class="readiness-label">{{ role.label }}</span>
            <span class="readiness-value">{{ roleLabel(role.id) }}</span>
          </span>
          <span class="readiness-dot" />
        </RouterLink>
      </div>
    </section>

    <section class="library">
      <div class="library-head">
        <div>
          <p class="av-kicker">Local library</p>
          <h2 class="section-title">你的角色</h2>
        </div>
        <div class="library-actions">
          <BaseButton size="sm" @click="fileInput?.click()">
            <template #icon><Upload :size="14" /></template>
            导入
          </BaseButton>
          <RouterLink to="/create">
            <BaseButton size="sm" variant="primary">
              <template #icon><Plus :size="14" /></template>
              新建
            </BaseButton>
          </RouterLink>
        </div>
      </div>

      <div v-if="characters.loading" class="library-loading">
        <span v-for="index in 3" :key="index" class="loading-card" />
      </div>

      <EmptyState
        v-else-if="!characters.characters.length"
        title="还没有角色"
        description="准备一个生图模型的 Key，写一句角色设定，剩下的交给自动分层与绑定。"
      >
        <RouterLink to="/create">
          <BaseButton variant="primary">
            <template #icon><Sparkles :size="15" /></template>
            创建第一个角色
          </BaseButton>
        </RouterLink>
      </EmptyState>

      <div v-else class="character-grid">
        <RouterLink
          v-for="character in characters.characters"
          :key="character.id"
          :to="`/character/${character.id}`"
          class="character-card"
        >
          <div class="character-thumb">
            <img v-if="character.thumbnailUrl" :src="character.thumbnailUrl" :alt="character.name" />
            <span v-else class="character-placeholder"><Sparkles :size="22" /></span>
            <span class="tier-badge">{{ tierLabel(character.tier) }}</span>
          </div>
          <div class="character-meta">
            <div>
              <h3 class="character-name">{{ character.name }}</h3>
              <p class="character-date">{{ formatDate(character.updatedAt) }} 更新</p>
            </div>
            <span class="character-enter"><ArrowRight :size="15" /></span>
          </div>
          <button
            type="button"
            class="character-delete"
            :aria-label="`删除 ${character.name}`"
            @click.prevent.stop="deleteTarget = character"
          >
            <Trash2 :size="14" />
          </button>
        </RouterLink>
      </div>
    </section>

    <input
      ref="fileInput"
      type="file"
      accept=".zip,application/zip"
      class="hidden-input"
      @change="onImport"
    />

    <Modal :open="!!deleteTarget" title="删除角色" width="420px" @close="deleteTarget = null">
      <p class="delete-copy">
        确定删除「{{ deleteTarget?.name }}」吗？图层、绑定与人设会一起从本机移除，无法撤销。
      </p>
      <template #footer>
        <BaseButton size="sm" @click="deleteTarget = null">取消</BaseButton>
        <BaseButton size="sm" variant="danger" @click="confirmDelete">删除</BaseButton>
      </template>
    </Modal>

    <div v-if="importing" class="importing-mask">正在导入角色包…</div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 54px;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(340px, 0.95fr);
  gap: 48px;
  align-items: center;
  padding: 26px 0 12px;
}

.hero-title {
  font-size: clamp(34px, 4.4vw, 58px);
  line-height: 1.12;
  margin: 14px 0 20px;
  text-wrap: balance;
  background: linear-gradient(120deg, #f4efe7 10%, #e8c79b 52%, #9fc8dc 96%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero-desc {
  max-width: 560px;
  color: var(--av-muted);
  font-size: 15px;
  line-height: 1.85;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.hero-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 24px;
  color: var(--av-faint);
  font-size: 11px;
}

.hero-facts span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hero-art {
  position: relative;
  min-height: 480px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.art-orbit {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(224, 164, 92, 0.13);
}

.orbit-one {
  width: 390px;
  height: 390px;
  animation: orbit 26s linear infinite;
}

.orbit-two {
  width: 300px;
  height: 300px;
  border-color: rgba(125, 211, 252, 0.1);
  animation: orbit 18s linear infinite reverse;
}

.art-frame {
  position: relative;
  width: 330px;
  height: 430px;
  border-radius: 44% 44% 22% 22% / 32% 32% 16% 16%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background:
    radial-gradient(circle at 50% 26%, rgba(255, 255, 255, 0.13), transparent 26%),
    linear-gradient(165deg, rgba(224, 164, 92, 0.1), rgba(125, 211, 252, 0.035) 45%, rgba(7, 10, 16, 0.5));
  box-shadow: 0 36px 90px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  overflow: hidden;
  animation: float 7s ease-in-out infinite;
}

.art-portrait {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 24%;
  filter: saturate(0.96) contrast(1.03);
}

.art-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 50% 36%, transparent 42%, rgba(7, 10, 16, 0.28) 78%, rgba(7, 10, 16, 0.7) 100%),
    linear-gradient(180deg, transparent 58%, rgba(7, 10, 16, 0.8) 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.art-fallback {
  position: absolute;
  inset: 0;
}

.art-head {
  position: absolute;
  left: 50%;
  top: 58px;
  width: 172px;
  height: 214px;
  transform: translateX(-50%);
}

.art-face {
  position: absolute;
  left: 50%;
  top: 38px;
  width: 132px;
  height: 168px;
  transform: translateX(-50%);
  border-radius: 48% 48% 46% 46% / 42% 42% 58% 58%;
  background: linear-gradient(160deg, #e8d5bd, #cfa987 62%, #b28462);
  box-shadow: inset -10px -14px 24px rgba(75, 42, 20, 0.16);
}

.art-hair {
  position: absolute;
  background: linear-gradient(150deg, #3c2b24, #211816 60%, #100c0b);
  box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.08);
}

.art-hair-back {
  left: 6px;
  top: 18px;
  width: 160px;
  height: 196px;
  border-radius: 48% 48% 42% 42%;
}

.art-hair-front {
  left: 26px;
  top: 44px;
  width: 120px;
  height: 62px;
  border-radius: 52% 52% 38% 38%;
  transform: rotate(-4deg);
}

.art-brow {
  position: absolute;
  top: 58px;
  width: 28px;
  height: 4px;
  border-radius: 999px;
  background: #5e4031;
  opacity: 0.7;
}

.art-brow.left {
  left: 22px;
  transform: rotate(-5deg);
}

.art-brow.right {
  right: 22px;
  transform: rotate(5deg);
}

.art-eye {
  position: absolute;
  top: 74px;
  width: 30px;
  height: 13px;
  border-radius: 50% 50% 45% 45%;
  background: linear-gradient(180deg, #2b1c17, #765341);
  box-shadow: inset 0 -2px 0 rgba(255, 255, 255, 0.26);
  animation: blink 5.6s infinite;
}

.art-eye.left {
  left: 18px;
}

.art-eye.right {
  right: 18px;
}

.art-mouth {
  position: absolute;
  left: 50%;
  bottom: 34px;
  width: 22px;
  height: 7px;
  transform: translateX(-50%);
  border-radius: 0 0 12px 12px;
  background: linear-gradient(180deg, #9c5b55, #7b3e3c);
  opacity: 0.85;
}

.art-shoulder {
  position: absolute;
  bottom: 48px;
  width: 122px;
  height: 150px;
  border-radius: 44% 44% 20% 20%;
  background: linear-gradient(165deg, #1d2c3d, #121a26 70%);
  border: 1px solid rgba(255, 255, 255, 0.045);
}

.art-shoulder.left {
  left: 26px;
  transform: rotate(9deg);
}

.art-shoulder.right {
  right: 26px;
  transform: rotate(-9deg);
}

.art-collar {
  position: absolute;
  left: 50%;
  bottom: 44px;
  width: 64px;
  height: 84px;
  transform: translateX(-50%);
  border-radius: 0 0 26px 26px;
  background: linear-gradient(180deg, #d9b78d, #9a6f48);
  opacity: 0.7;
}

.art-caption {
  position: absolute;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--av-faint);
  font-size: 10px;
  letter-spacing: 0.28em;
}

.section-title {
  font-family: var(--av-font-serif);
  font-size: 25px;
  margin-top: 4px;
}

.readiness-head,
.library-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 16px;
}

.readiness-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--av-muted);
  font-size: 12px;
}

.readiness-link:hover {
  color: var(--av-accent);
}

.readiness-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.readiness-card {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 14px;
  border-radius: var(--av-radius-sm);
  border: 1px solid var(--av-border);
  background: rgba(255, 255, 255, 0.022);
  transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
}

.readiness-card:hover {
  border-color: var(--av-border-strong);
  background: rgba(255, 255, 255, 0.04);
  transform: translateY(-1px);
}

.readiness-icon {
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

.readiness-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.readiness-label {
  color: var(--av-muted);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.readiness-value {
  color: var(--av-text-soft);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.readiness-dot {
  width: 6px;
  height: 6px;
  margin-left: auto;
  border-radius: 999px;
  background: var(--av-faint);
  flex-shrink: 0;
}

.readiness-card.is-ready .readiness-dot {
  background: var(--av-success);
  box-shadow: 0 0 10px rgba(94, 234, 212, 0.5);
}

.readiness-card.is-ready .readiness-icon {
  background: var(--av-success-soft);
  color: var(--av-success);
}

.library-actions {
  display: flex;
  gap: 8px;
}

.character-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.character-card {
  position: relative;
  overflow: hidden;
  border-radius: var(--av-radius);
  border: 1px solid var(--av-border);
  background: var(--av-panel);
  transition: transform 170ms ease, border-color 170ms ease, box-shadow 170ms ease;
}

.character-card:hover {
  transform: translateY(-3px);
  border-color: rgba(224, 164, 92, 0.28);
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.25);
}

.character-thumb {
  position: relative;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 40%, rgba(224, 164, 92, 0.12), transparent 50%),
    linear-gradient(180deg, #121a27, #0b1018);
}

.character-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 18%;
  transition: transform 400ms ease;
}

.character-card:hover .character-thumb img {
  transform: scale(1.025);
}

.character-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--av-faint);
}

.tier-badge {
  position: absolute;
  left: 12px;
  top: 12px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(8, 12, 19, 0.62);
  backdrop-filter: blur(8px);
  color: var(--av-text-soft);
  font-size: 10px;
}

.character-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 15px 15px;
}

.character-name {
  font-family: var(--av-font-serif);
  font-size: 17px;
}

.character-date {
  color: var(--av-faint);
  font-size: 10px;
  margin-top: 2px;
}

.character-enter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: 1px solid var(--av-border);
  color: var(--av-muted);
}

.character-delete {
  position: absolute;
  right: 11px;
  top: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(8, 12, 19, 0.55);
  color: var(--av-muted);
  opacity: 0;
  transition: opacity 150ms ease, color 150ms ease;
}

.character-card:hover .character-delete {
  opacity: 1;
}

.character-delete:hover {
  color: var(--av-danger);
}

.library-loading {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}

.loading-card {
  aspect-ratio: 4 / 5;
  border-radius: var(--av-radius);
  border: 1px solid var(--av-border);
  background: linear-gradient(100deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.03));
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite linear;
}

.hidden-input {
  display: none;
}

.delete-copy {
  color: var(--av-text-soft);
  font-size: 13px;
  line-height: 1.7;
}

.importing-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 7, 12, 0.62);
  backdrop-filter: blur(6px);
  color: var(--av-text-soft);
  font-size: 13px;
}

@keyframes orbit {
  to {
    transform: rotate(360deg);
  }
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-9px);
  }
}

@keyframes blink {
  0%,
  44%,
  48%,
  100% {
    transform: scaleY(1);
  }
  46% {
    transform: scaleY(0.12);
  }
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

@media (max-width: 980px) {
  .hero {
    grid-template-columns: 1fr;
    gap: 24px;
  }

  .hero-art {
    min-height: 380px;
    transform: scale(0.9);
  }

  .readiness-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .character-grid,
  .library-loading {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .readiness-grid,
  .character-grid,
  .library-loading {
    grid-template-columns: 1fr;
  }

  .hero {
    padding-top: 6px;
  }

  .hero-art {
    min-height: 330px;
    transform: scale(0.78);
  }

  .hero-facts {
    gap: 6px 12px;
  }
}
</style>
