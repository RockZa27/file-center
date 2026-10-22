import { createRouter, createWebHistory } from 'vue-router'
import { useAppStore } from './store'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'public', component: () => import('./views/PublicView.vue'), meta: { guestOk: true } },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { guestOk: true } },
    // a share link: opened by people without an account, and by signed-in users alike
    { path: '/s/:token', name: 'share', component: () => import('./views/ShareLinkView.vue'), meta: { guestOk: true } },
    {
      path: '/',
      component: () => import('./layouts/AppLayout.vue'),
      meta: { auth: true },
      children: [
        { path: 'files', name: 'files', component: () => import('./views/FilesView.vue') },
        { path: 'favorites', name: 'favorites', component: () => import('./views/FavoritesView.vue') },
        { path: 'trash', name: 'my-trash', component: () => import('./views/MyTrashView.vue') },
        // the list of folders other people share with the user; with an id, the folder itself (a folder-shared notice links to /with-me/<id>)
        { path: 'with-me/:id?', name: 'with-me', component: () => import('./views/WithMeView.vue') },
        // the group folders the user is in: a list, or with an id the group's folder (a group-added notice links to /groups/<id>)
        { path: 'groups/:id?', name: 'groups', component: () => import('./views/GroupFoldersView.vue') },
        { path: 'shared', name: 'shared', component: () => import('./views/SharedView.vue') },
        { path: 'links', name: 'links', component: () => import('./views/SharesView.vue') },
        { path: 'admin', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { staff: true } },
        { path: 'admin/users', name: 'users', component: () => import('./views/UsersView.vue'), meta: { staff: true } },
        { path: 'admin/users/:username/files', name: 'user-files', component: () => import('./views/UserFilesView.vue'), meta: { staff: true } },
        { path: 'admin/groups', name: 'admin-groups', component: () => import('./views/GroupsAdminView.vue'), meta: { staff: true } },
        { path: 'admin/activity', name: 'activity', component: () => import('./views/ActivityView.vue'), meta: { staff: true } },
        // the system area: one page with tabs; the old addresses stay, each opens its tab
        { path: 'admin/system', redirect: { name: 'settings' } },
        {
          path: '',
          component: () => import('./views/SystemView.vue'),
          meta: { admin: true, system: true },
          children: [
            { path: 'admin/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { admin: true } },
            { path: 'admin/backup', name: 'backup', component: () => import('./views/BackupView.vue'), meta: { admin: true } },
            { path: 'admin/update', name: 'update', component: () => import('./views/UpdateView.vue'), meta: { admin: true } },
            { path: 'admin/logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { admin: true } },
            { path: 'admin/trash', name: 'trash', component: () => import('./views/TrashView.vue'), meta: { admin: true } },
          ],
        },
        { path: 'help', name: 'help', component: () => import('./views/HelpView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(to => {
  const app = useAppStore()
  if (to.name === 'login' && app.user) return { name: app.isStaff ? 'dashboard' : 'files' }
  if (to.name === 'public' && app.user) return { name: 'files' }
  if (to.name === 'public' && !app.publicAvailable) return { name: 'login' }
  if (to.meta.auth && !app.user) return { name: 'login' }
  if (to.meta.admin && !app.isAdmin) return { name: 'files' }
  if (to.meta.staff && !app.isStaff) return { name: 'files' }
  if (to.name === 'shared' && !app.hasSpace('public')) return { name: 'files' }
  if (to.name === 'links' && !app.canShare && !app.canGrant && !app.isStaff) return { name: 'files' }
})
