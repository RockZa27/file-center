<template>
  <n-modal :show="show" preset="card" :title="t('nav.changePassword')" style="width: min(440px, 94vw)" :mask-closable="!app.user?.mustChangePassword" :closable="!app.user?.mustChangePassword" @update:show="v => emit('update:show', v)">
    <n-alert v-if="app.user?.mustChangePassword" type="warning" class="gap">{{ t('profile.mustChange') }}</n-alert>
    <n-form label-placement="top" @submit.prevent="save">
      <n-form-item :label="t('profile.current')">
        <n-input v-model:value="form.current" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" />
      </n-form-item>
      <n-form-item :label="t('profile.new')" :feedback="t('profile.hint')">
        <n-input v-model:value="form.next" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
      </n-form-item>
      <n-form-item :label="t('profile.confirm')" :validation-status="mismatch ? 'error' : undefined" :feedback="mismatch ? t('profile.mismatch') : undefined">
        <n-input v-model:value="form.again" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" @keyup.enter="save" />
      </n-form-item>
    </n-form>
    <template #footer>
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
import { NAlert, NButton, NForm, NFormItem, NInput, NModal } from 'naive-ui'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'

const props = defineProps({ show: Boolean })
const emit = defineEmits(['update:show'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const form = reactive({ current: '', next: '', again: '' })
const busy = ref(false)

const mismatch = computed(() => form.again && form.again !== form.next)
const valid = computed(() => form.current && form.next.length >= 8 && form.next === form.again)

watch(() => props.show, v => { if (v) Object.assign(form, { current: '', next: '', again: '' }) })

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
.foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
