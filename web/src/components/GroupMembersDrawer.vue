<template>
  <n-drawer :show="show" :width="narrow ? '100%' : 460" placement="right" @update:show="v => emit('update:show', v)">
    <n-drawer-content :title="t('groups.memberTitle', { name: group?.name || '' })" closable :native-scrollbar="true">
      <template v-if="group">
        <!-- add -->
        <h3>{{ t('groups.addMember') }}</h3>
        <div class="add">
          <n-select v-model:value="pick" filterable :options="options" :placeholder="t('groups.pickUser')" :loading="loadingUsers" :consistent-menu-width="false" class="pick">
            <template #empty><span class="muted">{{ t('groups.noUserOptions') }}</span></template>
          </n-select>
          <n-radio-group v-model:value="perms" name="gm-perms" size="small">
            <n-radio-button value="view">{{ t('groups.view') }}</n-radio-button>
            <n-radio-button value="edit" :disabled="!mayGiveEdit">{{ t('groups.edit') }}</n-radio-button>
          </n-radio-group>
          <n-button type="primary" :loading="busy === 'add'" :disabled="!pick" @click="add">{{ t('groups.add2') }}</n-button>
        </div>
        <div v-if="!mayGiveEdit" class="muted small">{{ t('groups.noEditHere') }}</div>

        <!-- members -->
        <h3>{{ t('groups.members') }} ({{ group.members.length }})</h3>
        <div v-if="!group.members.length" class="muted small">{{ t('groups.noMembers') }}</div>
        <div v-for="m in group.members" :key="m.username" class="member" data-testid="group-member">
          <div class="who">
            <span class="mname">{{ m.name || m.username }}<span v-if="m.username === app.user?.username" class="muted"> ({{ t('groups.you') }})</span></span>
            <span class="muted mono">{{ m.username }}</span>
            <span v-if="!mayChange(m)" class="muted small">{{ t('groups.notYours') }}</span>
          </div>
          <n-radio-group v-if="mayChange(m)" :value="m.perms" size="small" :name="`gm-${m.username}`" :disabled="busy === m.username" @update:value="v => setPerms(m, v)">
            <n-radio-button value="view">{{ t('groups.view') }}</n-radio-button>
            <n-radio-button value="edit" :disabled="!mayGiveEdit">{{ t('groups.edit') }}</n-radio-button>
          </n-radio-group>
          <n-tag v-else size="small" round :bordered="false" :type="m.perms === 'edit' ? 'success' : 'default'">{{ m.perms === 'edit' ? t('groups.edit') : t('groups.view') }}</n-tag>
          <n-button v-if="mayChange(m)" size="small" quaternary type="error" :loading="busy === `rm-${m.username}`" @click="remove(m)">
            <template #icon><n-icon :component="CloseOutline" /></template>{{ t('groups.removeMember') }}
          </n-button>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDrawer, NDrawerContent, NIcon, NRadioButton, NRadioGroup, NSelect, NTag } from 'naive-ui'
import { CloseOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback, useNarrow } from '../composables'
import { useAppStore } from '../store'

/**
 * The members of one group. An admin may do everything; a manager only touches the plain users they manage (the user
 * list says which: `manageable`) and gives `edit` only when they hold it in this group, as the server insists.
 */
const props = defineProps({ show: Boolean, group: { type: Object, default: null } })
const emit = defineEmits(['update:show', 'changed'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const narrow = useNarrow('(max-width: 520px)')
const users = ref([])
const loadingUsers = ref(false)
const pick = ref(null)
const perms = ref('view')
const busy = ref('')

const myPerms = computed(() => props.group?.members.find(m => m.username.toLowerCase() === app.user?.username.toLowerCase())?.perms)
const mayGiveEdit = computed(() => app.isAdmin || myPerms.value === 'edit')
const manageableNames = computed(() => new Set(users.value.filter(u => u.manageable !== false).map(u => u.username.toLowerCase())))
const mayChange = m => app.isAdmin || manageableNames.value.has(m.username.toLowerCase())
const options = computed(() => {
  const inGroup = new Set((props.group?.members ?? []).map(m => m.username.toLowerCase()))
  return users.value
    .filter(u => u.manageable !== false && !inGroup.has(u.username.toLowerCase()))
    .map(u => ({ value: u.username, label: u.name && u.name !== u.username ? `${u.name} (${u.username})` : u.username }))
})

watch(() => props.show, async v => {
  if (!v) return
  pick.value = null
  perms.value = 'view'
  loadingUsers.value = true
  try { users.value = (await api.users()).users } catch (e) { fb.fail(e) } finally { loadingUsers.value = false }
})

async function add() {
  if (!pick.value || busy.value) return
  busy.value = 'add'
  try {
    const r = await api.setGroupMember(props.group.id, pick.value, perms.value)
    fb.ok(t(r.added ? 'groups.memberAdded' : 'groups.memberChanged', { name: pick.value }))
    pick.value = null
    perms.value = 'view'
    emit('changed')
  } catch (e) { fb.fail(e) } finally { busy.value = '' }
}
async function setPerms(m, v) {
  if (v === m.perms || busy.value) return
  busy.value = m.username
  try {
    await api.setGroupMember(props.group.id, m.username, v)
    fb.ok(t('groups.memberChanged', { name: m.name || m.username }))
  } catch (e) { fb.fail(e) } finally { busy.value = '' }
  emit('changed')
}
async function remove(m) {
  const name = m.name || m.username
  if (!(await fb.confirm({ title: t('groups.removeTitle', { name }), content: t('groups.removeBody', { name }), positive: t('groups.removeMember'), danger: true }))) return
  busy.value = `rm-${m.username}`
  try { await api.removeGroupMember(props.group.id, m.username); fb.ok(t('groups.memberRemoved')) } catch (e) { fb.fail(e) } finally { busy.value = '' }
  emit('changed')
}
</script>

<style scoped>
h3 { margin: 4px 0 10px; font-size: 14.5px; }
h3:not(:first-child) { margin-top: 22px; }
.small { font-size: 12.5px; }
.add { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pick { flex: 1 1 200px; min-width: 0; }
.member { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.who { flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; }
.mname { font-weight: 600; overflow-wrap: anywhere; }
.who .mono { overflow-wrap: anywhere; }
</style>
