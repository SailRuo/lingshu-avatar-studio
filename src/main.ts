import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { installNativeFetch } from './services/platform/fetchShim'
import { isNativeRuntime } from './services/platform/bridge'
import { migrateLegacyCharacters } from './services/storage/characterRepo'
import { useProviderStore } from './stores/useProviderStore'
import './styles/tokens.css'
import './styles/base.css'

installNativeFetch()
// The shell header is the window's drag region: Tauri reads the
// `data-tauri-drag-region` attribute, and the CSS rules under `body.is-native`
// lay the header out as an overlay title bar.
if (isNativeRuntime()) {
  document.body.classList.add('is-native')
}

async function bootstrap() {
  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia).use(router)
  const providers = useProviderStore(pinia)
  try {
    await providers.hydrate()
  } catch (error) {
    console.warn('[avatar] provider settings failed to load', error)
  }
  try {
    await migrateLegacyCharacters()
  } catch (error) {
    console.warn('[avatar] legacy character migration failed', error)
  }
  app.mount('#app')
}

void bootstrap()
