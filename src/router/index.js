import { createRouter, createWebHistory } from 'vue-router'
import OpenUltronShell from '../components/openultron/OpenUltronShell.vue'
import ChatView from '../views/ChatView.vue'
import ControlCron from '../views/ControlCron.vue'
import SkillsView from '../views/SkillsView.vue'
import SettingsConfig from '../views/SettingsConfig.vue'
import SettingsLogs from '../views/SettingsLogs.vue'

const routes = [
  {
    path: '/',
    component: OpenUltronShell,
    children: [
      { path: '', redirect: { name: 'Chat' } },
      { path: 'chat', name: 'Chat', component: ChatView },
      { path: 'sessions', name: 'SessionsList', component: () => import('../views/SessionsListView.vue') },
      { path: 'control/cron', name: 'ControlCron', component: ControlCron },
      { path: 'skills', name: 'Skills', component: SkillsView },
      {
        path: 'web-apps',
        name: 'WebAppsHome',
        component: () => import('../views/WebAppsHomeView.vue')
      },
      {
        path: 'web-app-studio',
        name: 'WebAppStudio',
        component: () => import('../views/WebAppStudioView.vue')
      },
      {
        path: 'app-open',
        name: 'AppOpen',
        component: () => import('../views/AppOpenView.vue')
      },
      { path: 'settings/config', name: 'SettingsConfig', component: SettingsConfig },
      { path: 'settings/logs', name: 'SettingsLogs', component: SettingsLogs }
    ]
  }
]

const router = createRouter({
  history: createWebHistory('/'),
  routes
})

export default router
