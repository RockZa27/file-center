<template>
  <n-modal :show="show" preset="card" :title="isEdit ? t('users.edit') : t('users.add')" style="width: min(560px, 95vw)" @update:show="v => emit('update:show', v)">
    <n-form label-placement="top" :show-feedback="false" class="form" @submit.prevent="save">
      <div class="two">
        <n-form-item :label="t('login.username')"><n-input :placeholder="t('login.username')" v-model:value="f.username" :disabled="isEdit" :status="reserved ? 'error' : undefined" :input-props="{ autocomplete: 'off' }" /></n-form-item>
        <n-form-item :label="t('users.name')"><n-input :placeholder="t('users.name')" v-model:value="f.name" /></n-form-item>
      </div>
      <n-alert v-if="reserved" type="error" :show-icon="true">{{ t('users.guestReserved') }}</n-alert>
      <n-form-item :label="isEdit ? t('users.newPassword') : t('login.password')">
        <div class="field">
          <n-input v-model:value="f.password" type="password" show-password-on="click" :placeholder="isEdit ? t('users.keepPassword') : ''" :input-props="{ autocomplete: 'new-password' }" />
          <password-rules :password="f.password" :username="f.username" />
        </div>
      </n-form-item>
      <!-- a manager who sets someone's password proves it is them -->
      <n-form-item v-if="needsOwn" :label="t('users.confirmOwn')">
        <div class="field">
          <n-input v-model:value="f.confirmPassword" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" />
          <div class="muted hint">{{ t('users.confirmOwnHint') }}</div>
        </div>
      </n-form-item>
      <n-form-item :label="t('users.role')">
        <n-radio-group v-model:value="f.role" :disabled="isEdit && user.username === app.user.username">
          <n-radio-button value="user">{{ t('role.user') }}</n-radio-button>
          <n-radio-button v-if="app.isAdmin" value="manager">{{ t('role.manager') }}</n-radio-button>
          <n-radio-button v-if="app.isAdmin" value="admin">{{ t('role.admin') }}</n-radio-button>
        </n-radio-group>
      </n-form-item>
      <template v-if="f.role === 'user'">
        <!-- a manager's users always live in /users/<name>: the server sets it -->
        <div v-if="!app.isAdmin" class="muted hint">{{ t('users.homeAuto') }}</div>
        <n-form-item v-else :label="t('users.homedir')">
          <div class="home">
            <n-input v-model:value="f.homedir" :placeholder="`/users/${f.username || 'username'}`" />
            <n-button secondary @click="picker = true"><template #icon><n-icon :component="FolderOpenOutline" /></template></n-button>
          </div>
        </n-form-item>
        <n-form-item :label="t('users.quota')">
          <div class="quota">
            <n-switch v-model:value="f.limited"><template #checked>{{ t('users.limited') }}</template><template #unchecked>{{ t('users.noLimit') }}</template></n-switch>
            <template v-if="f.limited">
              <n-input-number v-model:value="f.quotaValue" :min="0.01" :precision="2" :show-button="false" placeholder="" class="qnum" :input-props="{ inputmode: 'decimal', 'aria-label': t('users.quota') }" />
              <n-select v-model:value="f.quotaUnit" :options="[{ label: 'MB', value: 'MB' }, { label: 'GB', value: 'GB' }]" class="qunit" />
            </template>
          </div>
        </n-form-item>
        <n-form-item :label="t('users.ownPerms')"><perm-select v-model="f.permissions" /></n-form-item>
        <n-form-item :label="t('users.publicPerms')"><perm-select v-model="f.publicPermissions" :allowed="publicAllowed" /></n-form-item>
        <div v-if="!app.isAdmin" class="muted hint">{{ t('users.publicLimited') }}</div>
        <div class="muted hint">{{ t('users.publicHint') }}</div>
        <div class="muted hint">{{ t('users.shareHint') }}</div>
      </template>
      <n-alert v-else type="info" :show-icon="true">{{ f.role === 'manager' ? t('users.managerRoleHint') : t('users.adminHint') }}</n-alert>
    </n-form>
    <template #footer>
      <div class="foot"><n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="!ready" @click="save">{{ t('common.save') }}</n-button></div>
    </template>
    <folder-picker v-model:show="picker" admin :initial="parentOf(f.homedir)" :title="t('users.homedir')" :confirm-text="t('users.useThisFolder')" @select="p => (f.homedir = p)" />
  </n-modal>
</template>

<script setup>
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NForm, NFormItem, NIcon, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSelect, NSwitch } from 'naive-ui'
import { FolderOpenOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { joinQuota, splitQuota } from '../account-utils'
import { parentPath } from '../utils'
import FolderPicker from './FolderPicker.vue'
import PasswordRules from './PasswordRules.vue'

// `share` (hand out links to people without an account) works only together with `download`
const PERMS = ['read', 'download', 'batchdownload', 'upload', 'write', 'zip', 'share']

const PermSelect = defineComponent({
  // `allowed`: the rights that may be ticked (null = all); one already set stays, so it can be taken away
  props: { modelValue: { type: Array, default: () => [] }, allowed: { type: Array, default: null } },
  emits: ['update:modelValue'],
  setup(p, { emit }) {
    const { t } = useI18n()
    return () => h(NCheckboxGroup, { value: p.modelValue, 'onUpdate:value': v => emit('update:modelValue', v) }, () =>
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 16px' }, PERMS.map(k => h(NCheckbox, { value: k, label: t(`perm.${k}`), disabled: !!p.allowed && !p.allowed.includes(k) && !p.modelValue.includes(k) }))))
  },
})

const props = defineProps({ show: Boolean, user: { type: Object, default: null } })
const emit = defineEmits(['update:show', 'saved'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const busy = ref(false)
const picker = ref(false)
const f = reactive({ username: '', name: '', password: '', role: 'user', homedir: '', permissions: [], publicPermissions: [], limited: false, quotaValue: null, quotaUnit: 'GB', confirmPassword: '' })
// a manager hands out public-folder rights no wider than their own (the session's user carries them)
const publicAllowed = computed(() => (app.isAdmin ? null : app.user?.publicPermissions || []))
const isEdit = computed(() => !!props.user)
const needsOwn = computed(() => !app.isAdmin && isEdit.value && !!f.password)
// visitors' uploads and activity go under the name 'guest' (any case), so the server refuses it: say so before saving
const reserved = computed(() => !isEdit.value && f.username.trim().toLowerCase() === 'guest')
// the password rules are hinted live; the server judges them (its common-password list too)
const ready = computed(() => (!f.limited || f.quotaValue > 0) && f.username.trim().length >= 3 && !reserved.value && f.name.trim() && (isEdit.value || f.password) && (!needsOwn.value || f.confirmPassword))
const parentOf = p => (p ? parentPath(p) : '/')

watch(() => props.show, v => {
  if (!v) return
  const u = props.user
  Object.assign(f, { confirmPassword: '' }, u
    ? { username: u.username, name: u.name, password: '', role: u.role, homedir: u.homedir, permissions: [...u.permissions], publicPermissions: [...u.publicPermissions], limited: !!u.quotaBytes, quotaValue: splitQuota(u.quotaBytes).value, quotaUnit: splitQuota(u.quotaBytes).unit }
    : { username: '', name: '', password: '', role: 'user', homedir: '', permissions: ['read', 'download', 'batchdownload', 'upload', 'write', 'zip'], publicPermissions: ['read', 'download', 'batchdownload'].filter(k => !publicAllowed.value || publicAllowed.value.includes(k)), limited: false, quotaValue: null, quotaUnit: 'GB' })
})

async function save() {
  if (!ready.value || busy.value) return
  busy.value = true
  try {
    const body = { name: f.name.trim(), role: f.role, permissions: f.permissions, publicPermissions: f.publicPermissions }
    if (f.role === 'user' && app.isAdmin) body.homedir = f.homedir.trim() || undefined
    body.quotaBytes = f.role === 'user' && f.limited ? joinQuota(f.quotaValue, f.quotaUnit) : 0
    if (isEdit.value) {
      if (f.password) { body.password = f.password; if (needsOwn.value) body.confirmPassword = f.confirmPassword }
      await api.updateUser(props.user.username, body)
    } else {
      await api.createUser({ ...body, username: f.username.trim(), password: f.password })
    }
    fb.ok(t('common.saved'))
    emit('saved')
    emit('update:show', false)
  } catch (e) { fb.fail(e) } finally { busy.value = false }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: 14px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.home { display: flex; gap: 8px; width: 100%; }
.field { width: 100%; min-width: 0; }
.quota { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
.qnum { width: 120px; }
.qunit { width: 90px; }
.hint { font-size: 12.5px; margin-top: -4px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } }
</style>
