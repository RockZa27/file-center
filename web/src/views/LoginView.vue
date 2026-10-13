<template>
  <div class="login">
    <div class="corner"><preference-controls /></div>
    <div class="card surface">
      <app-logo class="logo" />
      <h1>{{ t('login.title') }}</h1>
      <p class="muted sub">{{ ticket ? (useBackup ? t('login.backupHelp') : t('login.codeHelp')) : t('login.subtitle') }}</p>
      <n-alert v-if="failure" type="error" class="alert">{{ errorMessage }}</n-alert>
      <n-form v-if="ticket" @submit.prevent="submitCode">
        <n-form-item :label="useBackup ? t('login.backupCode') : t('login.code')" :show-feedback="false" class="field">
          <n-input
            ref="codeRef" :key="useBackup ? 'b' : 'c'" v-model:value="code" size="large" :maxlength="useBackup ? 20 : 6" :placeholder="useBackup ? 'xxxx-xxxx' : '123456'"
            :input-props="useBackup ? { autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: false, name: 'backup-code' } : { autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]*', name: 'otp' }"
            @keyup.enter="submitCode"
          />
        </n-form-item>
        <n-button type="primary" size="large" block :loading="loading" :disabled="!code" @click="submitCode">{{ t('login.verify') }}</n-button>
        <div class="two-links">
          <n-button text size="small" @click="toggleBackup">{{ useBackup ? t('login.useAppCode') : t('login.useBackup') }}</n-button>
          <n-button text size="small" @click="backToPassword">← {{ t('login.back') }}</n-button>
        </div>
      </n-form>
      <n-form v-else @submit.prevent="submit">
        <n-form-item :label="t('login.username')" :show-feedback="false" class="field">
          <n-input :placeholder="t('login.username')" ref="userRef" v-model:value="form.username" size="large" :input-props="{ autocomplete: 'username', name: 'username' }" @keyup.enter="submit" />
        </n-form-item>
        <n-form-item :label="t('login.password')" :show-feedback="false" class="field">
          <n-input :placeholder="t('login.password')" v-model:value="form.password" type="password" size="large" show-password-on="click" :input-props="{ autocomplete: 'current-password', name: 'password' }" @keyup.enter="submit" />
        </n-form-item>
        <n-button type="primary" size="large" block :loading="loading" :disabled="!form.username || !form.password" @click="submit">
          {{ t('login.submit') }}
        </n-button>
      </n-form>
      <div v-if="app.publicAvailable" class="back">
        <router-link :to="{ name: 'public' }">← {{ t('login.backToPublic') }}</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput } from 'naive-ui'
import AppLogo from '../components/AppLogo.vue'
import PreferenceControls from '../components/PreferenceControls.vue'
import { errorText } from '../composables'
import { useAppStore } from '../store'

const { t, locale } = useI18n()
const app = useAppStore()
const router = useRouter()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const failure = ref(null)
const userRef = ref(null)
const codeRef = ref(null)
// set when the password was right but the account also needs a code: the second step
const ticket = ref('')
const code = ref('')
const useBackup = ref(false)

// the cases a visitor meets most are written here, so they follow the language switch; any other text came from
// the server in the old language and is dropped when the language changes
const errorMessage = computed(() => {
  const e = failure.value
  if (e?.code === 'auth.bad-credentials') return t('login.failed')
  if (e?.code === 'auth.locked') return t('login.locked', { seconds: e.params?.seconds ?? '' })
  if (e?.code === 'auth.two-factor-bad-code') return t('login.badCode')
  if (e?.code === 'auth.two-factor-bad-ticket') return t('login.badTicket')
  if (e?.code === 'auth.two-factor-locked') return t('login.codeLocked', { seconds: e.params?.seconds ?? '' })
  return errorText(e, t('login.failed'))
})
watch(locale, () => {
  if (!['auth.bad-credentials', 'auth.locked', 'auth.two-factor-bad-ticket', 'auth.two-factor-bad-code'].includes(failure.value?.code)) failure.value = null
})

onMounted(() => userRef.value?.focus())

async function submit() {
  if (loading.value || !form.username || !form.password) return
  loading.value = true
  failure.value = null
  try {
    const next = await app.login(form.username, form.password)
    if (next) {
      ticket.value = next
      form.password = ''
      await nextTick()
      codeRef.value?.focus()
    } else {
      done()
    }
  } catch (e) {
    failure.value = e
    form.password = ''
  } finally {
    loading.value = false
  }
}

// mustChangePassword is handled by the app shell after this, same as without a second step
const done = () => router.replace({ name: app.isAdmin ? 'dashboard' : 'files' })

async function submitCode() {
  const c = code.value.trim()
  if (loading.value || !c) return
  loading.value = true
  failure.value = null
  try {
    await app.login2fa(ticket.value, c)
    done()
  } catch (e) {
    failure.value = e
    code.value = ''
    // an expired or unknown step cannot be retried with another code: start again from the password
    if (e?.code === 'auth.two-factor-bad-ticket') backToPassword(e)
    else { await nextTick(); codeRef.value?.focus() }
  } finally {
    loading.value = false
  }
}

function backToPassword(keep) {
  ticket.value = ''
  code.value = ''
  useBackup.value = false
  failure.value = keep?.code ? keep : null
  nextTick(() => userRef.value?.focus())
}

function toggleBackup() {
  useBackup.value = !useBackup.value
  code.value = ''
  failure.value = null
  nextTick(() => codeRef.value?.focus())
}

// the 6 digits of the app are sent as soon as the sixth is typed
watch(code, v => { if (ticket.value && !useBackup.value && /^\d{6}$/.test(v)) submitCode() })
</script>

<style scoped>
.login { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: radial-gradient(900px 400px at 0% 0%, var(--primary-soft), transparent 70%), var(--bg); }
.corner { position: fixed; top: 12px; right: 12px; }
.card { width: min(400px, 100%); padding: 32px 28px 24px; }
.logo { margin-bottom: 20px; }
h1 { margin: 0; font-size: 22px; font-weight: 600; }
.sub { margin: 6px 0 20px; font-size: 14px; }
.alert { margin-bottom: 16px; }
.field { margin-bottom: 14px; }
.two-links { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.back { margin-top: 18px; text-align: center; font-size: 14px; }
.back a { color: var(--muted); text-decoration: none; }
.back a:hover { color: var(--primary); }
</style>
