<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.users') }}</h1><p>{{ t('users.subtitle') }}</p></div>
      <n-button type="primary" @click="edit(null)"><template #icon><n-icon :component="PersonAddOutline" /></template>{{ t('users.add') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="users" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 1050" :row-key="r => r.username"
      />
    </div>
    <user-form-modal v-model:show="form.show" :user="form.user" @saved="load" />
    <user-devices-modal v-model:show="dev.show" :user="dev.user" @changed="load" />
    <n-modal v-model:show="reset.show" preset="card" :title="t('users.resetTitle')" style="width: min(440px, 94vw)">
      <p class="reset-text">{{ t('users.resetExplain', { name: reset.user?.name || '' }) }}</p>
      <n-form-item :label="t('users.adminPassword')" :show-feedback="false">
        <n-input :placeholder="t('users.adminPassword')" v-model:value="reset.password" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" @keyup.enter="doReset" />
      </n-form-item>
      <template #footer>
        <div class="reset-foot">
          <n-button @click="reset.show = false">{{ t('common.cancel') }}</n-button>
          <n-button type="error" :loading="reset.busy" :disabled="!reset.password" @click="doReset">{{ t('users.resetGo') }}</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NDataTable, NDropdown, NFormItem, NIcon, NInput, NModal, NTag } from 'naive-ui'
import { CreateOutline, EllipsisHorizontal, FolderOpenOutline, PersonAddOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import UserDevicesModal from '../components/UserDevicesModal.vue'
import UserFormModal from '../components/UserFormModal.vue'
import { useFeedback, useNarrow, useRoleLabel } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const app = useAppStore()
const router = useRouter()
const roleLabel = useRoleLabel()
const fb = useFeedback()
const users = ref([])
const loading = ref(false)
const form = reactive({ show: false, user: null })

async function load() {
  loading.value = true
  try { users.value = (await api.users()).users } catch (e) { fb.fail(e) } finally { loading.value = false }
}
const dev = reactive({ show: false, user: null })
const reset = reactive({ show: false, user: null, password: '', busy: false })

async function signOutEverywhere(u) {
  if (!(await fb.confirm({ title: t('users.signOutAll'), content: t('users.signOutAllConfirm', { name: u.name }), positive: t('users.signOutAll'), danger: true }))) return
  try { const r = await api.revokeUserSessions(u.username); fb.ok(t('users.signedOutCount', { n: r.revoked ?? 0 })) } catch (e) { fb.fail(e) }
}
async function doReset() {
  if (!reset.password || reset.busy) return
  reset.busy = true
  try {
    await api.resetTwoFactor(reset.user.username, reset.password)
    fb.ok(t('users.resetDone'))
    reset.show = false
    await load()
  } catch (e) { fb.fail(e); reset.password = '' } finally { reset.busy = false }
}
function more(u, key) {
  if (key === 'devices') { dev.user = u; dev.show = true }
  else if (key === 'signout') signOutEverywhere(u)
  else if (key === 'reset') Object.assign(reset, { user: u, password: '', show: true })
}
const moreOptions = u => [
  { key: 'devices', label: t('users.devices') },
  { key: 'signout', label: t('users.signOutAll') },
  ...(u.twoFactor ? [{ key: 'reset', label: t('users.resetTwoFactor') }] : []),
]
const quotaText = u => (u.manageable === false ? '' : u.quotaBytes ? formatBytes(u.quotaBytes) : t('users.noLimit'))
const edit = u => { form.user = u; form.show = true }

async function remove(u) {
  if (!(await fb.confirm({ title: t('users.delete'), content: t('users.deleteConfirm', { name: u.name }), positive: t('common.delete'), danger: true }))) return
  try { await api.deleteUser(u.username); fb.ok(t('files.done')); await load() } catch (e) { fb.fail(e) }
}

const who = u => h('div', { style: 'min-width:0' }, [h('div', { class: 'who' }, u.name), h('div', { class: 'muted mono wrap' }, u.username)])
const roleTag = u => h('div', { class: 'tags' }, [
  h(NTag, { size: 'small', round: true, bordered: false, type: u.role === 'admin' ? 'warning' : u.role === 'manager' ? 'success' : 'info' }, () => roleLabel(u.role)),
  ...(u.twoFactor ? [h(NTag, { size: 'small', round: true, bordered: false, type: 'success' }, () => '2FA')] : []),
])
const lastLogin = u => (u.lastLogin ? formatDate(u.lastLogin) : t('common.never'))
const viewFiles = u => router.push({ name: 'user-files', params: { username: u.username } })
// an account the server will not let this person change: shown, never offered a button
const actions = u => (u.manageable === false
  ? h('div', { class: 'row-actions' }, [h(NTag, { size: 'small', round: true, bordered: false, title: t('users.notManageableHint') }, () => t('users.notManageable'))])
  : h('div', { class: 'row-actions' }, [
  u.username !== app.user?.username ? h(NButton, { secondary: true, size: 'small', onClick: () => viewFiles(u) }, { default: () => t('users.viewFiles'), icon: () => h(NIcon, { component: FolderOpenOutline }) }) : null,
  h(NButton, { quaternary: true, circle: true, size: 'small', title: t('common.edit'), 'aria-label': t('common.edit'), onClick: () => edit(u) }, { icon: () => h(NIcon, { component: CreateOutline }) }),
  h(NDropdown, { trigger: 'click', options: moreOptions(u), onSelect: k => more(u, k) }, () =>
    h(NButton, { quaternary: true, circle: true, size: 'small', title: t('users.more'), 'aria-label': t('users.more') }, { icon: () => h(NIcon, { component: EllipsisHorizontal }) })),
  h(NButton, { quaternary: true, circle: true, size: 'small', type: 'error', disabled: u.username === app.user?.username, title: t('common.delete'), 'aria-label': t('common.delete'), onClick: () => remove(u) }, { icon: () => h(NIcon, { component: TrashOutline }) }),
]))

// on a phone the edit and delete buttons sat off screen to the right: one stacked card per account instead
const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('users.user'), key: 'name',
      render: u => h('div', { class: 'stacked' }, [
        h('div', { class: 'stacked-head' }, [who(u), actions(u)]),
        h('div', {}, [roleTag(u)]),
        h('div', { class: 'stacked-meta' }, [
          h('div', {}, [h('span', { class: 'muted' }, `${t('users.homedir')}: `), h('span', { class: 'mono wrap' }, u.homedir ?? '')]),
          h('div', {}, [h('span', { class: 'muted' }, `${t('users.quota')}: `), quotaText(u)]),
          h('div', {}, [h('span', { class: 'muted' }, `${t('users.lastLogin')}: `), lastLogin(u)]),
        ]),
      ]),
    }]
  : [
      { title: t('users.user'), key: 'name', minWidth: 190, render: who },
      { title: t('users.role'), key: 'role', width: 130, render: roleTag },
      { title: t('users.homedir'), key: 'homedir', width: 190, render: u => h('span', { class: 'mono' }, u.homedir ?? '') },
      { title: t('users.quota'), key: 'quota', width: 110, render: quotaText },
      { title: t('users.lastLogin'), key: 'lastLogin', width: 150, render: lastLogin },
      { title: '', key: 'a', width: 250, align: 'right', fixed: 'right', render: actions },
    ]))
onMounted(load)
</script>

<style scoped>
:deep(.who) { font-weight: 600; }
:deep(.wrap) { overflow-wrap: anywhere; }
:deep(.row-actions) { display: flex; gap: 4px; justify-content: flex-end; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
:deep(.stacked-head) { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
:deep(.stacked-meta) { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.reset-text { margin: 0 0 14px; overflow-wrap: anywhere; }
.reset-foot { display: flex; justify-content: flex-end; gap: 8px; }
:deep(.tags) { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
