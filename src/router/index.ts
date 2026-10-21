import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import CreateView from '../views/CreateView.vue'
import CharacterView from '../views/CharacterView.vue'
import CharacterEditView from '../views/CharacterEditView.vue'
import SettingsProvidersView from '../views/SettingsProvidersView.vue'
import SettingsProviderCreateView from '../views/SettingsProviderCreateView.vue'
import SettingsProviderView from '../views/SettingsProviderView.vue'
import SettingsGeneralView from '../views/SettingsGeneralView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/create', name: 'create', component: CreateView },
    { path: '/character/:id', name: 'character', component: CharacterView },
    { path: '/character/:id/edit', name: 'character-edit', component: CharacterEditView },
    { path: '/settings/providers', name: 'providers', component: SettingsProvidersView },
    { path: '/settings/providers/new', name: 'provider-new', component: SettingsProviderCreateView },
    { path: '/settings/providers/:id', name: 'provider', component: SettingsProviderView },
    { path: '/settings/general', name: 'settings-general', component: SettingsGeneralView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
