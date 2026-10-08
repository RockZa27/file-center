import { createRouter, createWebHistory } from 'vue-router'
import { useAppStore } from './store'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'public', component: () => import('./views/PublicView.vue'), meta: { guestOk: true } },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { guestOk: true } },
    {
      path: '/',
      component: () => import('./layouts/AppLayout.vue'),
      meta: { auth: true },
      children: [
        { path: 'files', name: 'files', component: () => import('./views/FilesView.vue') },
        { path: 'shared', name: 'shared', component: () => import('./views/SharedView.vue') },
        { path: 'admin', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { admin: true } },
        { path: 'admin/users', name: 'users', component: () => import('./views/UsersView.vue'), meta: { admin: true } },
        { path: 'admin/activity', name: 'activity', component: () => import('./views/ActivityView.vue'), meta: { admin: true } },
        { path: 'admin/trash', name: 'trash', component: () => import('./views/TrashView.vue'), meta: { admin: true } },
        { path: 'admin/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { admin: true } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(to => {
  const app = useAppStore()
  if (to.name === 'login' && app.user) return { name: app.isAdmin ? 'dashboard' : 'files' }
  if (to.name === 'public' && app.user) return { name: 'files' }
  if (to.name === 'public' && !app.publicAvailable) return { name: 'login' }
  if (to.meta.auth && !app.user) return { name: 'login' }
  if (to.meta.admin && !app.isAdmin) return { name: 'files' }
  if (to.name === 'shared' && !app.hasSpace('public')) return { name: 'files' }
})
