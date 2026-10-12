<template>
  <div class="share-page">
    <header class="bar">
      <app-logo :to="app.user ? { name: 'files' } : '/'" />
      <preference-controls />
    </header>

    <main class="wrap">
      <div v-if="loading && !info && !dead" class="center-box"><n-spin size="large" /></div>

      <!-- every link that does not work answers the same: unknown, expired, revoked, used up, moved -->
      <div v-else-if="dead" class="surface panel">
        <n-result status="404" :title="t('shareView.dead')" :description="t('shareView.deadHint')" />
      </div>

      <div v-else-if="failed" class="surface panel">
        <n-result status="warning" :title="failed">
          <template #footer><n-button @click="load">{{ t('common.retry') }}</n-button></template>
        </n-result>
      </div>

      <form v-else-if="info?.needsPassword" class="surface panel lock" @submit.prevent="unlock">
        <div class="lock-icon"><n-icon :component="LockClosedOutline" size="28" /></div>
        <h1>{{ t('shareView.locked') }}</h1>
        <p class="muted">{{ t('shareView.lockedText') }}</p>
        <n-input
          v-model:value="password" type="password" show-password-on="click" :placeholder="t('shareView.password')"
          :input-props="{ autocomplete: 'off', name: 'share-password', 'aria-label': t('shareView.password') }" :disabled="unlocking"
        />
        <n-alert v-if="pwError" type="error" class="pw-error">{{ pwErrorText }}</n-alert>
        <n-button type="primary" attr-type="submit" block :loading="unlocking" :disabled="!password">{{ t('shareView.open') }}</n-button>
        <div class="muted small">{{ t('shareView.expires', { date: formatDate(info.expiresAt) }) }}</div>
      </form>

      <!-- one file -->
      <div v-else-if="info?.type === 'file'" class="surface panel file">
        <file-icon :item="{ name: info.name, type: 'file' }" :size="56" />
        <div class="muted small">{{ t('shareView.file') }}</div>
        <h1 class="name">{{ info.name }}</h1>
        <div class="muted">{{ formatBytes(info.size) }}</div>
        <n-button tag="a" type="primary" size="large" :href="api.shareDownloadUrl(token)" class="big">
          <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
        </n-button>
        <div class="muted small">{{ t('shareView.expires', { date: formatDate(info.expiresAt) }) }}</div>
      </div>

      <!-- a folder: look inside, download a file, a sub folder or the whole folder as zip -->
      <template v-else-if="info?.type === 'dir'">
        <div class="surface head">
          <div class="head-text">
            <div class="muted small">{{ t('shareView.folder') }}</div>
            <h1 class="name">{{ info.name }}</h1>
            <div class="muted small">{{ t('shareView.total', { size: formatBytes(info.size) }) }} · {{ t('shareView.expires', { date: formatDate(info.expiresAt) }) }}</div>
          </div>
          <n-button tag="a" type="primary" :href="api.shareDownloadUrl(token, here)" class="zip">
            <template #icon><n-icon :component="DownloadOutline" /></template>{{ here === '/' ? t('shareView.downloadAll') : t('shareView.downloadHere') }}
          </n-button>
        </div>

        <div class="crumbs">
          <n-button v-if="here !== '/'" quaternary circle size="small" :title="t('common.back')" :aria-label="t('common.back')" @click="go(parentPath(here))">
            <template #icon><n-icon :component="ArrowBackOutline" /></template>
          </n-button>
          <n-breadcrumb>
            <n-breadcrumb-item v-for="c in crumbs" :key="c.path" @click="go(c.path)">
              <span class="crumb"><n-icon v-if="c.path === '/'" :component="FolderOpenOutline" />{{ c.name }}</span>
            </n-breadcrumb-item>
          </n-breadcrumb>
        </div>

        <div class="surface list">
          <n-spin :show="loading">
            <n-empty v-if="!info.entries.length" :description="t('shareView.empty')" class="empty" />
            <div v-for="e in info.entries" :key="e.path" class="entry">
              <file-icon :item="e" :size="24" />
              <div class="entry-text">
                <router-link v-if="e.type === 'dir'" :to="{ query: { path: e.path } }" class="entry-name">{{ e.name }}</router-link>
                <a v-else :href="api.shareDownloadUrl(token, e.path)" class="entry-name">{{ e.name }}</a>
                <div class="muted small">{{ e.type === 'dir' ? t('common.folder') : formatBytes(e.size) }} · {{ formatDate(e.mtime) }}</div>
              </div>
              <n-button
                tag="a" :href="api.shareDownloadUrl(token, e.path)" quaternary circle
                :title="e.type === 'dir' ? t('shareView.downloadZip') : t('common.download')" :aria-label="e.type === 'dir' ? t('shareView.downloadZip') : t('common.download')"
              >
                <template #icon><n-icon :component="DownloadOutline" /></template>
              </n-button>
            </div>
          </n-spin>
        </div>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NBreadcrumb, NBreadcrumbItem, NButton, NEmpty, NIcon, NInput, NResult, NSpin } from 'naive-ui'
import { ArrowBackOutline, DownloadOutline, FolderOpenOutline, LockClosedOutline } from '@vicons/ionicons5'
import { api } from '../api'
import AppLogo from '../components/AppLogo.vue'
import FileIcon from '../components/FileIcon.vue'
import PreferenceControls from '../components/PreferenceControls.vue'
import { errorText, useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDate, parentPath } from '../utils'

const { t, locale } = useI18n()
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const fb = useFeedback()

const token = computed(() => String(route.params.token || ''))
const here = computed(() => {
  const q = route.query.path
  return typeof q === 'string' && q.startsWith('/') ? q : '/'
})

const info = ref(null)
const loading = ref(false)
const dead = ref(false)
// anything but a dead link (no connection, server error): worth another try
const failed = ref('')
const password = ref('')
const unlocking = ref(false)
// { code, params, message } of the last refused password, written in the page's language when shown
const pwError = ref(null)

const pwErrorText = computed(() => {
  const e = pwError.value
  if (!e) return ''
  if (e.code === 'auth.wrong-password') return t('shareView.wrongPassword')
  if (e.code === 'auth.confirm-locked') return t('shareView.tooMany', { minutes: Math.max(1, Math.ceil(Number(e.params?.seconds || 60) / 60)) })
  return e.message
})

const crumbs = computed(() => {
  const out = [{ name: info.value?.name || '/', path: '/' }]
  let acc = ''
  for (const part of here.value.split('/').filter(Boolean)) { acc += `/${part}`; out.push({ name: part, path: acc }) }
  return out
})

async function load() {
  loading.value = true
  failed.value = ''
  try {
    info.value = await api.shareInfo(token.value, here.value)
    dead.value = false
  } catch (e) {
    if (e.code === 'share.not-found') {
      dead.value = true
      info.value = null
    } else if (e.status === 404 && here.value !== '/') {
      // a sub folder that is gone (or a typed path): the top of the link still works
      fb.warn(t('shareView.folderNotFound'))
      go('/', true)
    } else {
      failed.value = errorText(e, t('common.unknownError'))
    }
  } finally {
    loading.value = false
  }
}

function go(path, replace = false) {
  const target = { query: path === '/' ? {} : { path } }
  return replace ? router.replace(target) : router.push(target)
}

async function unlock() {
  if (!password.value || unlocking.value) return
  unlocking.value = true
  pwError.value = null
  try {
    await api.shareUnlock(token.value, password.value)
    password.value = ''
    await load()
  } catch (e) {
    if (e.code === 'share.not-found') { dead.value = true; info.value = null } else pwError.value = { code: e.code, params: e.params, message: errorText(e, t('common.unknownError')) }
  } finally {
    unlocking.value = false
  }
}

watch(() => [token.value, here.value], load, { immediate: true })
// a text that came from the server (not one of ours) is in the old language: ask again
watch(locale, () => { if (failed.value) load() })
</script>

<style scoped>
.share-page { min-height: 100vh; }
.bar { height: var(--header-h); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 24px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 30; }
.wrap { max-width: 880px; margin: 0 auto; padding: 32px 24px 48px; }
.center-box { display: grid; place-items: center; padding: 80px 0; }
.panel { padding: 32px 24px; }
.small { font-size: 13px; }
h1 { margin: 0; font-weight: 600; }
.name { font-size: 20px; overflow-wrap: anywhere; line-height: 1.45; }

.lock { max-width: 420px; margin: 0 auto; display: flex; flex-direction: column; align-items: stretch; gap: 12px; text-align: center; }
.lock h1 { font-size: 19px; }
.lock p { margin: 0; }
.lock-icon { width: 56px; height: 56px; margin: 0 auto 4px; border-radius: 50%; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.pw-error { text-align: left; }

.file { max-width: 520px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.file .name { margin-top: 2px; }
.big { margin: 12px 0 6px; }

.head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 22px; margin-bottom: 14px; }
.head-text { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.zip { flex-shrink: 0; }
.crumbs { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; min-height: 28px; flex-wrap: wrap; }
.crumbs .n-breadcrumb { min-width: 0; flex: 1; }
/* a long Thai folder name has no spaces: let the trail wrap inside the screen instead of running off it */
.crumbs :deep(.n-breadcrumb ul) { display: flex; flex-wrap: wrap; row-gap: 2px; }
.crumbs :deep(.n-breadcrumb-item) { min-width: 0; white-space: normal; }
.crumbs :deep(.n-breadcrumb-item__link) { overflow-wrap: anywhere; }
.crumb { display: inline; cursor: pointer; overflow-wrap: anywhere; }
.crumb .n-icon { vertical-align: -2px; margin-right: 4px; }
.list { overflow: hidden; }
.empty { padding: 48px 16px; }
.entry { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--border); }
.entry:first-child { border-top: 0; }
.entry-text { flex: 1; min-width: 0; }
.entry-name { color: var(--text); text-decoration: none; font-weight: 500; overflow-wrap: anywhere; }
.entry-name:hover { color: var(--primary); text-decoration: underline; }

@media (max-width: 640px) {
  .bar { padding: 0 12px; }
  .wrap { padding: 16px 12px 32px; }
  .panel { padding: 24px 16px; }
  .head { flex-direction: column; align-items: stretch; padding: 16px; }
  .entry { padding: 10px 12px; }
}
</style>
