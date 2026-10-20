<template>
  <n-modal :show="show" preset="card" :title="t('nav.account')" style="width: min(480px, 94vw)" :mask-closable="!pinned" :closable="!pinned" :close-on-esc="!pinned" @update:show="v => emit('update:show', v)">
    <n-alert v-if="app.user?.mustChangePassword" type="warning" class="gap">{{ t('profile.mustChange') }}</n-alert>
    <div class="who muted">{{ app.user?.name }} · {{ t('users.role') }}: {{ roleLabel(app.user?.role) }}</div>
    <n-tabs v-model:value="tab" type="line" animated :class="{ 'no-tabs': app.user?.mustChangePassword }">
      <n-tab-pane name="password" :tab="t('profile.passwordTab')" display-directive="show">
    <n-form label-placement="top" @submit.prevent="save">
      <!-- tells password managers which account the new password belongs to -->
      <input type="text" name="username" autocomplete="username" :value="app.user?.username || ''" readonly hidden>
      <n-form-item :label="t('profile.current')">
        <n-input :placeholder="t('profile.current')" v-model:value="form.current" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" />
      </n-form-item>
      <n-form-item :label="t('profile.new')" :show-feedback="false" class="gap">
        <div class="field">
          <n-input :placeholder="t('profile.new')" v-model:value="form.next" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
          <password-rules :password="form.next" :username="app.user?.username || ''" />
        </div>
      </n-form-item>
      <n-form-item :label="t('profile.confirm')" :validation-status="mismatch ? 'error' : undefined" :feedback="mismatch ? t('profile.mismatch') : undefined">
        <n-input :placeholder="t('profile.confirm')" v-model:value="form.again" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" @keyup.enter="save" />
      </n-form-item>
    </n-form>
      </n-tab-pane>
      <n-tab-pane v-if="!app.user?.mustChangePassword" name="security" :tab="t('profile.securityTab')">
        <!-- made when the tab opens (not before), so the lists are fresh each time -->
        <security-panel v-if="show" @lock="v => (locked = v)" @signedout="signedOut" />
      </n-tab-pane>
      <n-tab-pane v-if="!app.user?.mustChangePassword" name="notify" :tab="t('profile.notifyTab')">
        <notify-panel v-if="show && tab === 'notify'" />
      </n-tab-pane>
    </n-tabs>
    <template v-if="tab === 'password'" #footer>
      <div class="foot">
        <n-button v-if="!app.user?.mustChangePassword" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="busy" :disabled="!valid" @click="save">{{ t('common.save') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NTabPane, NTabs } from 'naive-ui'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { useFeedback, useRoleLabel } from '../composables'
import { useAppStore } from '../store'
import PasswordRules from './PasswordRules.vue'
import NotifyPanel from './NotifyPanel.vue'
import SecurityPanel from './SecurityPanel.vue'

const props = defineProps({ show: Boolean, /** the tab to open on: 'password' (default), 'security' or 'notify' */ openTab: { type: String, default: 'password' } })
const emit = defineEmits(['update:show'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const roleLabel = useRoleLabel()
const form = reactive({ current: '', next: '', again: '' })
const busy = ref(false)
const router = useRouter()
const tab = ref('password')
// the backup codes are on screen: nothing may close the dialog until they are marked as saved
const locked = ref(false)
const pinned = computed(() => !!app.user?.mustChangePassword || locked.value)

function signedOut() {
  emit('update:show', false)
  router.push({ name: app.publicAvailable ? 'public' : 'login' })
}

const mismatch = computed(() => form.again && form.again !== form.next)
// the length and username hints are shown live, but the server judges the password (its common-password list too)
const valid = computed(() => form.current && form.next && form.next === form.again)

watch(() => props.show, v => { if (v) { Object.assign(form, { current: '', next: '', again: '' }); tab.value = app.user?.mustChangePassword ? 'password' : props.openTab; locked.value = false } })

async function save() {
  if (!valid.value || busy.value) return
  busy.value = true
  try {
    await api.changePassword(form.current, form.next)
    await app.refresh()
    fb.ok(t('profile.done'))
    emit('update:show', false)
  } catch (e) {
    fb.fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.gap { margin-bottom: 16px; }
.who { font-size: 13px; margin-bottom: 8px; overflow-wrap: anywhere; }
.field { width: 100%; min-width: 0; }
.no-tabs :deep(.n-tabs-nav) { display: none; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
