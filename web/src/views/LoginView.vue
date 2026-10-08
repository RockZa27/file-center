<template>
  <div class="login">
    <div class="corner"><preference-controls /></div>
    <div class="card surface">
      <app-logo class="logo" />
      <h1>{{ t('login.title') }}</h1>
      <p class="muted sub">{{ t('login.subtitle') }}</p>
      <n-alert v-if="error" type="error" class="alert">{{ error }}</n-alert>
      <n-form @submit.prevent="submit">
        <n-form-item :label="t('login.username')" :show-feedback="false" class="field">
          <n-input ref="userRef" v-model:value="form.username" size="large" :input-props="{ autocomplete: 'username', name: 'username' }" @keyup.enter="submit" />
        </n-form-item>
        <n-form-item :label="t('login.password')" :show-feedback="false" class="field">
          <n-input v-model:value="form.password" type="password" size="large" show-password-on="click" :input-props="{ autocomplete: 'current-password', name: 'password' }" @keyup.enter="submit" />
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
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput } from 'naive-ui'
import AppLogo from '../components/AppLogo.vue'
import PreferenceControls from '../components/PreferenceControls.vue'
import { errorText } from '../composables'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const router = useRouter()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error = ref('')
const userRef = ref(null)

onMounted(() => userRef.value?.focus())

async function submit() {
  if (loading.value || !form.username || !form.password) return
  loading.value = true
  error.value = ''
  try {
    await app.login(form.username, form.password)
    router.replace({ name: app.isAdmin ? 'dashboard' : 'files' })
  } catch (e) {
    error.value = errorText(e, t('login.failed'))
    form.password = ''
  } finally {
    loading.value = false
  }
}
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
.back { margin-top: 18px; text-align: center; font-size: 14px; }
.back a { color: var(--muted); text-decoration: none; }
.back a:hover { color: var(--primary); }
</style>
