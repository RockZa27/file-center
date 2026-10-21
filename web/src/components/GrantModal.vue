<template>
  <n-modal :show="show" preset="card" :title="t('grants.title', { name: item?.name || '' })" style="width: min(520px, 94vw)" @update:show="v => emit('update:show', v)">
    <p class="muted hint">{{ t('grants.hint') }}</p>

    <!-- who: a user or (when the caller is in one, or is an admin) a group -->
    <n-tabs v-if="groups.length && !picked" v-model:value="kind" type="segment" size="small" class="kinds">
      <n-tab name="user">{{ t('groups.tabUser') }}</n-tab>
      <n-tab name="group">{{ t('groups.tabGroup') }}</n-tab>
    </n-tabs>
    <!-- a search box, then the one recipient picked -->
    <div v-if="!picked && kind === 'group'" class="field">
      <n-input v-model:value="groupQuery" :placeholder="t('groups.searchGroup')" clearable :input-props="{ autocomplete: 'off', 'aria-label': t('groups.searchGroup') }" />
      <div class="results">
        <button v-for="g in shownGroups" :key="g.id" type="button" class="user" @click="picked = { group: true, id: g.id, name: g.name }">
          <n-icon :component="PeopleCircleOutline" size="18" />
          <span class="user-text"><span class="uname">{{ g.name }}</span></span>
        </button>
        <div v-if="!shownGroups.length" class="muted note">{{ t('groups.noGroups') }}</div>
      </div>
    </div>
    <div v-else-if="!picked" class="field">
      <n-input v-model:value="query" :placeholder="t('grants.searchPlaceholder', { n: MIN })" clearable :input-props="{ autocomplete: 'off', 'aria-label': t('grants.search') }" />
      <div class="results">
        <div v-if="[...query.trim()].length < MIN" class="muted note">{{ t('grants.searchShort', { n: MIN }) }}</div>
        <div v-else-if="searchError" class="note err">{{ searchError }}</div>
        <n-spin v-else :show="searching" size="small">
          <button v-for="u in found" :key="u.username" type="button" class="user" @click="pick(u)">
            <n-icon :component="PersonOutline" size="18" />
            <span class="user-text"><span class="uname">{{ u.name || u.username }}</span><span class="muted mono">{{ u.username }}</span></span>
          </button>
          <div v-if="!searching && !found.length" class="muted note">{{ t('grants.noUsers') }}</div>
        </n-spin>
      </div>
    </div>
    <div v-else class="picked">
      <span class="muted">{{ t('grants.pickedTitle') }}</span>
      <span v-if="picked.group" class="user-text"><span class="uname">{{ picked.name }}</span><span class="muted">{{ t('groups.groupLabel') }}</span></span>
      <span v-else class="user-text"><span class="uname">{{ picked.name || picked.username }}</span><span class="muted mono">{{ picked.username }}</span></span>
      <n-button size="tiny" quaternary @click="picked = null">{{ t('grants.clearPick') }}</n-button>
    </div>

    <!-- what they may do -->
    <n-radio-group v-model:value="perms" class="perms" name="grant-perms">
      <n-radio value="view"><span class="perm-t">{{ t('grants.permView') }}</span><span class="muted perm-h">{{ t('grants.permViewHelp') }}</span></n-radio>
      <n-radio value="edit"><span class="perm-t">{{ t('grants.permEdit') }}</span><span class="muted perm-h">{{ t('grants.permEditHelp') }}</span></n-radio>
    </n-radio-group>
    <div class="go"><n-button type="primary" :disabled="!picked" :loading="busy" @click="create">{{ t('grants.share') }}</n-button></div>

    <!-- who has it now -->
    <div class="current-title">{{ t('grants.current') }}</div>
    <n-spin :show="loading" size="small">
      <div v-if="!rows.length" class="muted note">{{ t('grants.currentNone') }}</div>
      <div v-for="g in rows" :key="g.id" class="row-g">
        <span v-if="g.toGroup" class="user-text"><span class="uname">{{ g.toGroupName }}</span><span class="muted">{{ t('groups.groupLabel') }}</span></span>
        <span v-else class="user-text"><span class="uname">{{ g.toName || g.to }}</span><span class="muted mono">{{ g.to }}</span></span>
        <n-radio-group :value="g.perms" size="small" :name="`perm-${g.id}`" @update:value="v => setPerms(g, v)">
          <n-radio-button value="view" :label="t('grants.permView')" />
          <n-radio-button value="edit" :label="t('grants.permEdit')" />
        </n-radio-group>
        <n-button size="small" quaternary type="error" :title="t('grants.remove')" :aria-label="t('grants.remove')" @click="remove(g)">
          <template #icon><n-icon :component="CloseOutline" /></template>
        </n-button>
      </div>
    </n-spin>
    <template #footer><div class="foot"><n-button @click="emit('update:show', false)">{{ t('common.close') }}</n-button></div></template>
  </n-modal>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NInput, NModal, NRadio, NRadioButton, NRadioGroup, NSpin, NTab, NTabs } from 'naive-ui'
import { CloseOutline, PeopleCircleOutline, PersonOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'

const props = defineProps({ show: Boolean, item: { type: Object, default: null } })
const emit = defineEmits(['update:show'])
const { t } = useI18n()
const fb = useFeedback()

/** letters before a search starts (the server's own minimum) */
const MIN = 3
const query = ref('')
const found = ref([])
const searching = ref(false)
const searchError = ref('')
const picked = ref(null)
const perms = ref('view')
const busy = ref(false)
const rows = ref([])
const loading = ref(false)
// the groups the caller may share with (their own; an admin: all); no tabs when there are none
const groups = ref([])
const kind = ref('user')
const groupQuery = ref('')
const shownGroups = computed(() => groups.value.filter(g => g.name.toLowerCase().includes(groupQuery.value.trim().toLowerCase())))
const targetName = g => (g.toGroup ? g.toGroupName : g.toName || g.to)

let timer = null
let seq = 0
// one search per pause in typing; an answer that comes after a newer question is dropped
watch(query, q => {
  clearTimeout(timer)
  found.value = []
  searchError.value = ''
  if ([...q.trim()].length < MIN) { searching.value = false; seq++; return }
  searching.value = true
  const mine = ++seq
  timer = setTimeout(async () => {
    try {
      const r = await api.lookupUsers(q.trim())
      if (mine === seq) found.value = r.users
    } catch (e) {
      if (mine === seq) searchError.value = e.message
    } finally {
      if (mine === seq) searching.value = false
    }
  }, 350)
})
onBeforeUnmount(() => clearTimeout(timer))

function pick(u) { picked.value = u }

async function loadRows() {
  loading.value = true
  try { rows.value = (await api.myGrants()).items.filter(g => g.path === props.item?.path) } catch (e) { fb.fail(e) } finally { loading.value = false }
}

watch(() => props.show, v => {
  if (!v) return
  query.value = ''
  found.value = []
  searchError.value = ''
  picked.value = null
  perms.value = 'view'
  kind.value = 'user'
  groupQuery.value = ''
  groups.value = []
  api.lookupGroups('').then(r => { groups.value = r.groups }).catch(() => { /* no groups to offer */ })
  loadRows()
})

async function create() {
  if (!picked.value || busy.value) return
  busy.value = true
  try {
    const p = picked.value
    const r = p.group ? await api.createGroupGrant(props.item.path, p.id, perms.value) : await api.createGrant(props.item.path, p.username, perms.value)
    const name = p.group ? p.name : p.name || p.username
    fb.ok(r.created ? t('grants.created', { name }) : t('grants.updated', { name }))
    picked.value = null
    query.value = ''
    await loadRows()
  } catch (e) { fb.fail(e) } finally { busy.value = false }
}

async function setPerms(g, v) {
  if (v === g.perms) return
  try {
    await api.updateGrant(g.id, v)
    g.perms = v
    fb.ok(t('grants.updated', { name: targetName(g) }))
  } catch (e) { fb.fail(e); await loadRows() }
}

async function remove(g) {
  const name = targetName(g)
  if (!(await fb.confirm({ title: t('grants.removeTitle', { name }), content: t('grants.removeBody', { name, folder: props.item?.name || '' }), positive: t('grants.remove'), danger: true }))) return
  try { await api.deleteGrant(g.id); fb.ok(t('grants.removed')) } catch (e) { fb.fail(e) }
  await loadRows()
}
</script>

<style scoped>
.hint { margin: 0 0 12px; font-size: 13.5px; }
.kinds { margin-bottom: 10px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.results { min-height: 40px; max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.note { padding: 10px 12px; font-size: 13px; }
.err { color: var(--danger); }
.user { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; }
.user:hover, .user:focus-visible { background: var(--primary-soft); }
.user-text { display: flex; flex-direction: column; min-width: 0; }
.uname { font-weight: 500; overflow-wrap: anywhere; }
.user-text .mono { overflow-wrap: anywhere; }
.picked { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 12px; border-radius: 8px; background: var(--primary-soft); }
.perms { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 10px; }
.perms :deep(.n-radio) { align-items: flex-start; }
.perm-t { font-weight: 500; margin-right: 8px; }
.perm-h { font-size: 12.5px; }
.go { display: flex; justify-content: flex-end; }
.current-title { margin: 16px 0 8px; font-weight: 600; font-size: 14px; border-top: 1px solid var(--border); padding-top: 14px; }
.row-g { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.row-g .user-text { flex: 1 1 140px; }
.foot { display: flex; justify-content: flex-end; }
</style>
