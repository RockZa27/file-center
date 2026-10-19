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

      <!-- a request link: the visitor only sends files in. Nothing of the folder is shown, only their own uploads. -->
      <template v-else-if="info?.kind === 'upload'">
        <div class="surface head up-head">
          <div class="head-text">
            <div class="muted small">{{ t('shareView.sendTo') }}</div>
            <h1 class="name">{{ info.name }}</h1>
            <div class="muted small">{{ t('shareView.expires', { date: formatDate(info.expiresAt) }) }}</div>
          </div>
        </div>

        <!-- the owner's note: plain text, never HTML -->
        <div v-if="info.note" class="surface note">
          <div class="muted small">{{ t('shareView.note') }}</div>
          <div class="note-text">{{ info.note }}</div>
        </div>

        <div class="surface rules">
          <span v-if="info.maxFileBytes">{{ t('share.limitFile', { size: formatBytes(info.maxFileBytes) }) }}</span>
          <span v-if="info.maxFiles">{{ t('shareView.filesLeft', { left: Math.max(0, info.maxFiles - info.uploadedFiles), max: info.maxFiles }) }}</span>
          <span v-if="info.maxTotalBytes">{{ t('shareView.bytesLeft', { left: formatBytes(Math.max(0, info.maxTotalBytes - info.uploadedBytes)), max: formatBytes(info.maxTotalBytes) }) }}</span>
          <span v-if="!info.maxFileBytes && !info.maxFiles && !info.maxTotalBytes" class="muted">{{ t('shareView.noLimits') }}</span>
        </div>

        <n-alert v-if="info.full" type="warning" class="up-gap">{{ t('shareView.errFull') }}</n-alert>

        <div
          v-else class="drop" :class="{ over: dropOver }" role="button" tabindex="0" :aria-label="t('shareView.choose')"
          @click="pickInput?.click()" @keydown.enter.prevent="pickInput?.click()" @keydown.space.prevent="pickInput?.click()"
          @dragover.prevent="dropOver = true" @dragleave="dropOver = false" @drop.prevent="onDrop"
        >
          <n-icon :component="CloudUploadOutline" size="40" class="drop-icon" />
          <div class="drop-text">{{ t('shareView.dropHere') }}</div>
          <div class="muted small drop-or">{{ t('shareView.or') }}</div>
          <n-button type="primary" size="large" class="drop-btn" @click.stop="pickInput?.click()">
            <template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t('shareView.choose') }}
          </n-button>
        </div>
        <input ref="pickInput" type="file" multiple hidden @change="onPick">

        <div v-if="queue.length" class="surface up-list">
          <div v-for="it in queue" :key="it.key" class="up-item">
            <div class="up-line">
              <span class="up-name">{{ it.file.name }}</span>
              <span class="muted small up-size">{{ formatBytes(it.file.size) }}</span>
            </div>
            <n-progress type="line" :percentage="percent(it)" :status="it.status === 'error' ? 'error' : it.status === 'done' ? 'success' : 'default'" :show-indicator="false" :height="6" :processing="it.status === 'uploading'" />
            <div class="up-line up-meta">
              <span :class="{ err: it.status === 'error' }" class="muted">{{ statusText(it) }}</span>
              <span class="up-actions">
                <n-button v-if="it.status === 'error' && it.retryable" text type="primary" size="small" @click="retry(it)">{{ t('common.retry') }}</n-button>
                <n-button v-if="['queued', 'uploading', 'error'].includes(it.status)" text type="error" size="small" @click="cancel(it)">{{ t('common.cancel') }}</n-button>
              </span>
            </div>
          </div>
        </div>

        <div class="surface mine">
          <h2>{{ t('shareView.mine') }}</h2>
          <div v-if="!info.mine?.length" class="muted small">{{ t('shareView.mineNone') }}</div>
          <div v-for="(m, i) in info.mine" :key="i" class="mine-row">
            <n-icon :component="CheckmarkCircleOutline" class="ok" />
            <div class="mine-text">
              <div class="mine-name">{{ m.name }}</div>
              <div class="muted small">{{ formatBytes(m.size) }} · {{ formatDate(m.at) }}</div>
            </div>
          </div>
        </div>
      </template>

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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NBreadcrumb, NBreadcrumbItem, NButton, NEmpty, NIcon, NInput, NProgress, NResult, NSpin } from 'naive-ui'
import { ArrowBackOutline, CheckmarkCircleOutline, CloudUploadOutline, DownloadOutline, FolderOpenOutline, LockClosedOutline } from '@vicons/ionicons5'
import { api, ApiError, putChunk } from '../api'
import AppLogo from '../components/AppLogo.vue'
import FileIcon from '../components/FileIcon.vue'
import PreferenceControls from '../components/PreferenceControls.vue'
import { errorText, useFeedback } from '../composables'
import { useAppStore } from '../store'
import { createPool } from '../uploadPool'
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

// ───── request link: send files in ─────
const pickInput = ref(null)
const dropOver = ref(false)
const queue = ref([])
let seq = 0
let runners = 0
const FILES_AT_ONCE = 3
// one limit of chunk requests in flight for all files together
const pool = createPool(() => app.config.uploadSimultaneous || 3)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const percent = it => (it.file.size ? Math.min(100, Math.round((it.loaded / it.file.size) * 100)) : it.status === 'done' ? 100 : 0)

/** the reason in the page's language, written by us for the cases a visitor meets; the server's text for the rest */
function uploadError(e) {
  if (e.code === 'share.upload-too-big') return t('shareView.errTooBig', { max: formatBytes(Number(e.params?.max) || 0) })
  if (e.code === 'share.upload-full') return t('shareView.errFull')
  if (e.code === 'share.upload-busy') return t('shareView.errBusy')
  if (e.code === 'quota.exceeded') return t('shareView.errOwnerFull')
  if (e.code === 'share.not-found') return t('shareView.errGone')
  if (e.code === 'share.password-required') return t('shareView.errLocked')
  return errorText(e, t('common.unknownError'))
}

function statusText(it) {
  if (it.status === 'queued') return t('upload.queued')
  if (it.status === 'done') return it.savedAs && it.savedAs !== it.file.name ? t('shareView.savedAs', { name: it.savedAs }) : t('upload.done')
  if (it.status === 'canceled') return t('upload.canceled')
  if (it.status === 'error') return it.error
  return `${percent(it)}%`
}

function addFiles(files) {
  const max = info.value?.maxFileBytes
  for (const file of files) {
    const it = reactive({ key: ++seq, file, loaded: 0, status: 'queued', error: '', retryable: false, id: null, canceled: false, aborts: new Set(), savedAs: '' })
    if (max && file.size > max) {
      it.status = 'error'
      it.error = t('shareView.errTooBig', { max: formatBytes(max) })
    }
    queue.value.push(it)
  }
  pump()
}

function onPick(e) {
  addFiles([...e.target.files])
  e.target.value = ''
}

function onDrop(e) {
  dropOver.value = false
  // read the entries now (the event data is gone after the first await); a folder is not taken
  const items = [...(e.dataTransfer.items || [])]
  const files = [...(e.dataTransfer.files || [])]
  const isDir = i => !!items[i]?.webkitGetAsEntry?.()?.isDirectory
  const dirs = files.filter((f, i) => isDir(i)).length
  if (dirs) fb.warn(t('shareView.noFolders'))
  const ok = files.filter((f, i) => !isDir(i))
  if (ok.length) addFiles(ok)
}

function pump() {
  while (runners < FILES_AT_ONCE && queue.value.some(i => i.status === 'queued')) {
    runners++
    runner().finally(() => { runners-- })
  }
}

async function runner() {
  for (let next = queue.value.find(i => i.status === 'queued'); next; next = queue.value.find(i => i.status === 'queued')) await sendOne(next)
}

// The first announcement sets the visitor's cookie. Files announced before it arrives would each get their own
// identity and the later chunks would be refused, so until one announcement has worked the others wait for it.
let cookieSet = false
let announcing = Promise.resolve()

/** tells the server about a file; waits and asks again while the link is busy with this visitor's other files */
async function announce(it) {
  const ask = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const init = await api.shareUploadInit(token.value, it.file.name, it.file.size)
        cookieSet = true
        return init
      } catch (e) {
        if (e.code !== 'share.upload-busy' || it.canceled || attempt >= 8) throw e
        await sleep(1000)
      }
    }
  }
  if (cookieSet) return ask()
  const turn = announcing.then(() => ask())
  announcing = turn.catch(() => {})
  return turn
}

async function sendOne(it) {
  it.status = 'uploading'
  it.loaded = 0
  it.error = ''
  it.retryable = false
  try {
    // the link already holds all it takes (counts as of the last answer): say so without asking the server
    const i = info.value
    if (i && ((i.maxFiles && i.uploadedFiles >= i.maxFiles) || (i.maxTotalBytes && i.uploadedBytes + it.file.size > i.maxTotalBytes))) {
      throw new ApiError(403, '', 'share.upload-full')
    }
    const init = await announce(it)
    it.id = init.id
    const { chunkSize, total } = init
    const base = api.shareUploadChunkUrl(token.value, it.id)
    const sent = new Array(total).fill(0)
    const pending = [...Array(total).keys()]
    let failure = null
    const sync = () => { it.loaded = sent.reduce((a, b) => a + b, 0) }
    const worker = async () => {
      while (!it.canceled && !failure) {
        await pool.acquire()
        let held = true
        try {
          // things may have changed while waiting for a slot
          if (it.canceled || failure) return
          const idx = pending.shift()
          if (idx === undefined) return
          const blob = it.file.slice(idx * chunkSize, Math.min(it.file.size, (idx + 1) * chunkSize))
          for (let attempt = 0; ; attempt++) {
            if (!held) { await pool.acquire(); held = true; if (it.canceled) return }
            try {
              await putChunk(it.id, idx, blob, loaded => { sent[idx] = loaded; sync() }, abort => it.aborts.add(abort), base)
              sent[idx] = blob.size
              sync()
              break
            } catch (e) {
              if (it.canceled) return
              const retryable = e.status === 0 || (e.status >= 500 && e.status !== 507)
              if (!retryable || attempt >= 3) { failure = e; return }
              sent[idx] = 0
              sync()
              // do not keep a slot while waiting
              pool.release(); held = false
              await sleep(1000 * (attempt + 1))
            }
          }
        } finally {
          if (held) pool.release()
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, app.config.uploadSimultaneous || 3), total) }, worker))
    if (it.canceled) return
    if (failure) throw failure
    const done = await api.shareUploadComplete(token.value, it.id)
    it.loaded = it.file.size
    it.savedAs = done?.name || ''
    it.status = 'done'
    await refreshInfo()
  } catch (e) {
    if (it.canceled) return
    it.status = 'error'
    it.error = uploadError(e)
    // a file that is too big or a link that is full will not work on a second try; a busy link or a lost connection may
    it.retryable = !['share.upload-too-big', 'share.upload-full', 'share.not-found', 'quota.exceeded'].includes(e.code)
    if (e.code === 'share.upload-full') refreshInfo()
  }
}

/** the counts and "files you sent" after a file arrived, without the page flickering */
async function refreshInfo() {
  try { info.value = await api.shareInfo(token.value, '/') } catch { /* the next load tells */ }
}

function cancel(it) {
  it.canceled = true
  it.status = 'canceled'
  it.aborts.forEach(a => a())
  if (it.id) api.shareUploadCancel(token.value, it.id).catch(() => {})
}

function retry(it) {
  it.status = 'queued'
  it.canceled = false
  pump()
}

const beforeUnload = e => { if (queue.value.some(i => ['queued', 'uploading'].includes(i.status))) { e.preventDefault(); e.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

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
/* request link */
.up-head { margin-bottom: 12px; }
.note { padding: 14px 22px; margin-bottom: 12px; }
.note-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; margin-top: 4px; }
.rules { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 12px 22px; margin-bottom: 12px; font-size: 13.5px; }
.up-gap { margin-bottom: 12px; }
.drop { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 20px; margin-bottom: 14px; border: 2px dashed var(--border); border-radius: 12px; background: var(--surface); cursor: pointer; text-align: center; transition: border-color 0.15s, background 0.15s; }
.drop:hover, .drop:focus-visible, .drop.over { border-color: var(--primary); background: var(--primary-soft); outline: none; }
.drop-icon { color: var(--primary); }
.drop-text { font-size: 16px; font-weight: 500; }
.up-list, .mine { margin-bottom: 14px; }
.up-item { padding: 12px 16px; border-top: 1px solid var(--border); }
.up-item:first-child { border-top: 0; }
.up-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; }
.up-meta { margin: 6px 0 0; font-size: 12.5px; }
.up-name { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.up-size { flex: none; }
.up-meta .err { color: var(--danger); overflow-wrap: anywhere; min-width: 0; }
.up-actions { display: flex; gap: 12px; flex: none; }
.mine { padding: 16px 22px; }
.mine h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
.mine-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.mine-text { min-width: 0; }
.mine-name { overflow-wrap: anywhere; font-weight: 500; }
.ok { color: #18a058; margin-top: 3px; flex: none; }

@media (max-width: 640px) {
  .note, .rules, .mine { padding-left: 16px; padding-right: 16px; }
  /* on a phone nobody drags: the whole zone is one big button */
  .drop { padding: 28px 16px; gap: 10px; }
  .drop-text, .drop-or { display: none; }
  .drop-btn { width: 100%; min-height: 56px; font-size: 17px; }
}
</style>
