<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.users') }}</h1><p>{{ t('users.subtitle') }}</p></div>
      <n-button type="primary" @click="edit(null)"><template #icon><n-icon :component="PersonAddOutline" /></template>{{ t('users.add') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="users" :loading="loading" :bordered="false" :single-line="false" :scroll-x="820" :row-key="r => r.username" />
    </div>
    <user-form-modal v-model:show="form.show" :user="form.user" @saved="load" />
  </div>
</template>

<script setup>
import { h, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NIcon, NTag } from 'naive-ui'
import { CreateOutline, PersonAddOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import UserFormModal from '../components/UserFormModal.vue'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatDate } from '../utils'

const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const users = ref([])
const loading = ref(false)
const form = reactive({ show: false, user: null })

async function load() {
  loading.value = true
  try { users.value = (await api.users()).users } catch (e) { fb.fail(e) } finally { loading.value = false }
}
const edit = u => { form.user = u; form.show = true }

async function remove(u) {
  if (!(await fb.confirm({ title: t('users.delete'), content: t('users.deleteConfirm', { name: u.name }), positive: t('common.delete'), danger: true }))) return
  try { await api.deleteUser(u.username); fb.ok(t('files.done')); await load() } catch (e) { fb.fail(e) }
}

const columns = [
  {
    title: t('users.user'), key: 'name', minWidth: 190,
    render: u => h('div', {}, [h('div', { style: 'font-weight:600' }, u.name), h('div', { class: 'muted mono' }, u.username)]),
  },
  { title: t('users.role'), key: 'role', width: 130, render: u => h(NTag, { size: 'small', round: true, bordered: false, type: u.role === 'admin' ? 'warning' : 'info' }, () => (u.role === 'admin' ? t('nav.admin') : t('users.regular'))) },
  { title: t('users.homedir'), key: 'homedir', width: 190, render: u => h('span', { class: 'mono' }, u.homedir) },
  { title: t('users.lastLogin'), key: 'lastLogin', width: 150, render: u => (u.lastLogin ? formatDate(u.lastLogin) : t('common.never')) },
  {
    title: '', key: 'a', width: 110, align: 'right',
    render: u => h('div', { style: 'display:flex;gap:4px;justify-content:flex-end' }, [
      h(NButton, { quaternary: true, circle: true, size: 'small', title: t('common.edit'), onClick: () => edit(u) }, { icon: () => h(NIcon, { component: CreateOutline }) }),
      h(NButton, { quaternary: true, circle: true, size: 'small', type: 'error', disabled: u.username === app.user.username, title: t('common.delete'), onClick: () => remove(u) }, { icon: () => h(NIcon, { component: TrashOutline }) }),
    ]),
  },
]
onMounted(load)
</script>
