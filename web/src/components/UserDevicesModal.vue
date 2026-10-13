<template>
  <n-modal :show="show" preset="card" :title="t('users.devicesOf', { name: user?.name || '' })" style="width: min(520px, 95vw)" @update:show="v => emit('update:show', v)">
    <n-spin v-if="loading" size="small" />
    <device-list v-else :sessions="sessions" />
    <template #footer>
      <div class="foot">
        <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button type="error" secondary :disabled="!sessions.length" :loading="busy" @click="signOutAll">{{ t('users.signOutAll') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NModal, NSpin } from 'naive-ui'
import { api } from '../api'
import { useFeedback } from '../composables'
import DeviceList from './DeviceList.vue'

const props = defineProps({ show: Boolean, user: { type: Object, default: null } })
const emit = defineEmits(['update:show', 'changed'])
const { t } = useI18n()
const fb = useFeedback()
const sessions = ref([])
const loading = ref(false)
const busy = ref(false)

async function load() {
  loading.value = true
  sessions.value = []
  try { sessions.value = (await api.userSessions(props.user.username)).sessions } catch (e) { fb.fail(e) } finally { loading.value = false }
}
watch(() => props.show, v => { if (v && props.user) load() })

async function signOutAll() {
  if (!(await fb.confirm({ title: t('users.signOutAll'), content: t('users.signOutAllConfirm', { name: props.user.name }), positive: t('users.signOutAll'), danger: true }))) return
  busy.value = true
  try {
    const r = await api.revokeUserSessions(props.user.username)
    fb.ok(t('users.signedOutCount', { n: r.revoked ?? 0 }))
    await load()
    emit('changed')
  } catch (e) { fb.fail(e) } finally { busy.value = false }
}
</script>

<style scoped>
.foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
</style>
