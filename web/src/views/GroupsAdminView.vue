<template>
  <div class="page">
    <page-header :title="t('nav.groupsAdmin')" :description="app.isAdmin ? t('groups.adminSubtitle') : t('groups.adminSubtitleManager')">
      <template #actions>
      <n-button v-if="app.isAdmin" type="primary" @click="openForm(null)"><template #icon><n-icon :component="AddOutline" /></template>{{ t('groups.add') }}</n-button>
      </template>
    </page-header>
    <div class="surface">
      <list-skeleton v-if="loading && !groups.length" />
      <n-data-table v-else :columns="columns" :data="groups" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 760" table-layout="fixed" :row-key="r => r.id" :pagination="{ pageSize: 25 }"
      >
        <template #empty><n-empty :description="app.isAdmin ? t('groups.adminNone') : t('groups.adminNoneManager')" /></template>
      </n-data-table>
    </div>

    <!-- make or edit a group -->
    <n-modal v-model:show="form.show" preset="card" :title="form.group ? t('groups.editGroup') : t('groups.add')" style="width: min(480px, 94vw)">
      <n-form label-placement="top" :show-feedback="false" class="gform" @submit.prevent="save">
        <n-form-item :label="t('groups.name')"><n-input v-model:value="form.name" :maxlength="64" :placeholder="t('groups.name')" :input-props="{ autocomplete: 'off' }" @keyup.enter="save" /></n-form-item>
        <n-form-item :label="t('groups.quota')">
          <div class="quota">
            <n-switch v-model:value="form.limited"><template #checked>{{ t('users.limited') }}</template><template #unchecked>{{ t('users.noLimit') }}</template></n-switch>
            <template v-if="form.limited">
              <n-input-number v-model:value="form.quotaValue" :min="0.01" :precision="2" :show-button="false" class="qnum" :input-props="{ inputmode: 'decimal', 'aria-label': t('groups.quota') }" />
              <n-select v-model:value="form.quotaUnit" :options="[{ label: 'MB', value: 'MB' }, { label: 'GB', value: 'GB' }]" class="qunit" />
            </template>
          </div>
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="foot"><n-button @click="form.show = false">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="form.busy" :disabled="!formReady" @click="save">{{ t('common.save') }}</n-button></div>
      </template>
    </n-modal>

    <!-- delete: the folder goes to the admin trash, and the password is asked again -->
    <n-modal v-model:show="del.show" preset="card" :title="t('groups.deleteTitle', { name: del.group?.name || '' })" style="width: min(460px, 94vw)">
      <n-alert type="warning" :show-icon="true" class="gap">{{ t('groups.deleteBody') }}</n-alert>
      <n-form-item :label="t('groups.deletePassword')" :show-feedback="false">
        <n-input v-model:value="del.password" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" @keyup.enter="doDelete" />
      </n-form-item>
      <template #footer>
        <div class="foot"><n-button @click="del.show = false">{{ t('common.cancel') }}</n-button><n-button type="error" :loading="del.busy" :disabled="!del.password" @click="doDelete">{{ t('groups.deleteGo') }}</n-button></div>
      </template>
    </n-modal>

    <group-members-drawer v-model:show="members.show" :group="memberGroup" @changed="load" />
  </div>
</template>

<script setup>
import ListSkeleton from '../components/ListSkeleton.vue'
import PageHeader from '../components/PageHeader.vue'
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDataTable, NEmpty, NForm, NFormItem, NIcon, NInput, NInputNumber, NModal, NSelect, NSwitch } from 'naive-ui'
import { AddOutline, CreateOutline, PeopleCircleOutline, PeopleOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { joinQuota, splitQuota } from '../account-utils'
import GroupMembersDrawer from '../components/GroupMembersDrawer.vue'
import UsageBar from '../components/UsageBar.vue'
import { useFeedback, useNarrow } from '../composables'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const groups = ref([])
const loading = ref(false)
const form = reactive({ show: false, group: null, name: '', limited: false, quotaValue: null, quotaUnit: 'GB', busy: false })
const del = reactive({ show: false, group: null, password: '', busy: false })
const members = reactive({ show: false, id: '' })
const memberGroup = computed(() => groups.value.find(g => g.id === members.id) || null)
const formReady = computed(() => form.name.trim().length > 0 && (!form.limited || form.quotaValue > 0))

async function load() {
  loading.value = true
  try { groups.value = (await api.adminGroups()).items } catch (e) { fb.fail(e) } finally { loading.value = false }
  // the side menu follows (a member added or removed may be the signed-in user)
  app.loadGroups()
}

function openForm(g) {
  const q = splitQuota(g?.quotaBytes)
  Object.assign(form, { show: true, group: g, name: g?.name || '', limited: !!g?.quotaBytes, quotaValue: q.value, quotaUnit: q.unit })
}
async function save() {
  if (!formReady.value || form.busy) return
  form.busy = true
  try {
    const body = { name: form.name.trim(), quotaBytes: form.limited ? joinQuota(form.quotaValue, form.quotaUnit) : 0 }
    if (form.group) await api.updateGroup(form.group.id, body)
    else await api.createGroup(body)
    fb.ok(form.group ? t('groups.saved') : t('groups.created'))
    form.show = false
    await load()
  } catch (e) { fb.fail(e) } finally { form.busy = false }
}

const askDelete = g => Object.assign(del, { show: true, group: g, password: '' })
async function doDelete() {
  if (!del.password || del.busy) return
  del.busy = true
  try {
    await api.deleteGroup(del.group.id, del.password)
    fb.ok(t('groups.deleted'))
    del.show = false
    await load()
  } catch (e) { fb.fail(e); del.password = '' } finally { del.busy = false }
}

const openMembers = g => { members.id = g.id; members.show = true }

const nameCell = g => h('div', { class: 'g-name-cell' }, [
  h(NIcon, { component: PeopleCircleOutline, size: 22, color: 'var(--folder)' }),
  h('div', { style: 'min-width:0' }, [h('div', { class: 'g-name' }, g.name), h('div', { class: 'muted small' }, t('groups.createdBy', { name: g.createdBy }))]),
])
const countCell = g => t('groups.membersCount', { n: g.members.length })
const usageCell = g => h(UsageBar, { used: g.used, quota: g.quotaBytes })
const actions = g => h('div', { class: 'row-actions' }, [
  h(NButton, { size: 'small', secondary: true, type: 'primary', onClick: () => openMembers(g) }, { default: () => t('groups.manage'), icon: () => h(NIcon, { component: PeopleOutline }) }),
  ...(app.isAdmin
    ? [
        h(NButton, { quaternary: true, circle: true, size: 'small', title: t('groups.editGroup'), 'aria-label': t('groups.editGroup'), onClick: () => openForm(g) }, { icon: () => h(NIcon, { component: CreateOutline }) }),
        h(NButton, { quaternary: true, circle: true, size: 'small', type: 'error', title: t('groups.delete'), 'aria-label': t('groups.delete'), onClick: () => askDelete(g) }, { icon: () => h(NIcon, { component: TrashOutline }) }),
      ]
    : []),
])

const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('nav.groupsAdmin'), key: 'name',
      render: g => h('div', { class: 'stacked' }, [nameCell(g), h('div', { class: 'stacked-meta' }, [h('div', {}, countCell(g)), usageCell(g)]), actions(g)]),
    }]
  : [
      { title: t('groups.name'), key: 'name', minWidth: 200, render: nameCell },
      { title: t('groups.members'), key: 'members', width: 110, render: countCell },
      { title: t('groups.usage'), key: 'usage', width: 220, render: usageCell },
      { title: '', key: 'a', width: app.isAdmin ? 250 : 170, align: 'right', fixed: 'right', render: actions },
    ]))

onMounted(load)
</script>

<style scoped>
.gform { display: flex; flex-direction: column; gap: 14px; }
.quota { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
.qnum { width: 120px; }
.qunit { width: 90px; }
.gap { margin-bottom: 14px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
:deep(.g-name-cell) { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
:deep(.g-name) { font-weight: 600; overflow-wrap: anywhere; }
:deep(.small) { font-size: 12.5px; overflow-wrap: anywhere; }
:deep(.row-actions) { display: flex; gap: 4px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
:deep(.stacked-meta) { display: flex; flex-direction: column; gap: 4px; padding-left: 32px; font-size: 13px; }
:deep(.stacked .row-actions) { justify-content: flex-start; padding-left: 32px; }
</style>
