<template>
  <n-modal :show="show" preset="card" :title="isEdit ? t('users.edit') : t('users.add')" style="width: min(560px, 95vw)" @update:show="v => emit('update:show', v)">
    <n-form label-placement="top" :show-feedback="false" class="form" @submit.prevent="save">
      <div class="two">
        <n-form-item :label="t('login.username')"><n-input v-model:value="f.username" :disabled="isEdit" :input-props="{ autocomplete: 'off' }" /></n-form-item>
        <n-form-item :label="t('users.name')"><n-input v-model:value="f.name" /></n-form-item>
      </div>
      <n-form-item :label="isEdit ? t('users.newPassword') : t('login.password')">
        <n-input v-model:value="f.password" type="password" show-password-on="click" :placeholder="isEdit ? t('users.keepPassword') : t('profile.hint')" :input-props="{ autocomplete: 'new-password' }" />
      </n-form-item>
      <n-form-item :label="t('users.role')">
        <n-radio-group v-model:value="f.role" :disabled="isEdit && user.username === app.user.username">
          <n-radio-button value="user">{{ t('users.regular') }}</n-radio-button>
          <n-radio-button value="admin">{{ t('nav.admin') }}</n-radio-button>
        </n-radio-group>
      </n-form-item>
      <template v-if="f.role === 'user'">
        <n-form-item :label="t('users.homedir')">
          <div class="home">
            <n-input v-model:value="f.homedir" :placeholder="`/users/${f.username || 'username'}`" />
            <n-button secondary @click="picker = true"><template #icon><n-icon :component="FolderOpenOutline" /></template></n-button>
          </div>
        </n-form-item>
        <n-form-item :label="t('users.ownPerms')"><perm-select v-model="f.permissions" /></n-form-item>
        <n-form-item :label="t('users.publicPerms')"><perm-select v-model="f.publicPermissions" /></n-form-item>
        <div class="muted hint">{{ t('users.publicHint') }}</div>
      </template>
      <n-alert v-else type="info" :show-icon="true">{{ t('users.adminHint') }}</n-alert>
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
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NForm, NFormItem, NIcon, NInput, NModal, NRadioButton, NRadioGroup } from 'naive-ui'
import { FolderOpenOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { parentPath } from '../utils'
import FolderPicker from './FolderPicker.vue'

const PERMS = ['read', 'download', 'batchdownload', 'upload', 'write', 'zip']

const PermSelect = defineComponent({
  props: { modelValue: { type: Array, default: () => [] } },
  emits: ['update:modelValue'],
  setup(p, { emit }) {
    const { t } = useI18n()
    return () => h(NCheckboxGroup, { value: p.modelValue, 'onUpdate:value': v => emit('update:modelValue', v) }, () =>
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 16px' }, PERMS.map(k => h(NCheckbox, { value: k, label: t(`perm.${k}`) }))))
  },
})

const props = defineProps({ show: Boolean, user: { type: Object, default: null } })
const emit = defineEmits(['update:show', 'saved'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const busy = ref(false)
const picker = ref(false)
const f = reactive({ username: '', name: '', password: '', role: 'user', homedir: '', permissions: [], publicPermissions: [] })
const isEdit = computed(() => !!props.user)
const ready = computed(() => f.username.trim().length >= 3 && f.name.trim() && (isEdit.value || f.password.length >= 8))
const parentOf = p => (p ? parentPath(p) : '/')

watch(() => props.show, v => {
  if (!v) return
  const u = props.user
  Object.assign(f, u
    ? { username: u.username, name: u.name, password: '', role: u.role, homedir: u.homedir, permissions: [...u.permissions], publicPermissions: [...u.publicPermissions] }
    : { username: '', name: '', password: '', role: 'user', homedir: '', permissions: ['read', 'download', 'batchdownload', 'upload', 'write', 'zip'], publicPermissions: ['read', 'download', 'batchdownload'] })
})

async function save() {
  if (!ready.value || busy.value) return
  busy.value = true
  try {
    const body = { name: f.name.trim(), role: f.role, permissions: f.permissions, publicPermissions: f.publicPermissions }
    if (f.role === 'user') body.homedir = f.homedir.trim() || undefined
    if (isEdit.value) {
      if (f.password) body.password = f.password
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
.hint { font-size: 12.5px; margin-top: -4px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } }
</style>
