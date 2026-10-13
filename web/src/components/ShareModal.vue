<template>
  <n-modal :show="show" preset="card" :title="t('share.title')" style="width: min(500px, 94vw)" :mask-closable="!busy" @update:show="v => emit('update:show', v)">
    <div v-if="item" class="item">
      <file-icon :item="item" :size="26" />
      <span class="item-name">{{ item.name }}</span>
    </div>

    <template v-if="!result">
      <n-form label-placement="top" :show-feedback="false" class="form" @submit.prevent="create">
        <n-form-item v-if="canDownload && canRequest" :label="t('share.kindLabel')">
          <n-radio-group v-model:value="kind" class="kinds">
            <n-radio value="download">{{ t('share.kindDownload') }}</n-radio>
            <n-radio value="upload">{{ t('share.kindUpload') }}</n-radio>
          </n-radio-group>
        </n-form-item>
        <div v-if="isUpload" class="muted small">{{ t('share.kindUploadHelp') }}</div>
        <n-form-item :label="t('share.expires')">
          <n-radio-group v-model:value="days">
            <n-radio-button v-for="d in allowedDays" :key="d" :value="d">{{ t('share.days', { n: d }) }}</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item :label="t('share.password')">
          <div class="field">
            <n-input
              v-model:value="password" type="password" show-password-on="click" :placeholder="t('share.passwordNone')"
              :status="tooShort ? 'warning' : undefined" :input-props="{ autocomplete: 'new-password', name: 'share-password' }"
            />
            <div v-if="tooShort" class="hint warn">{{ t('share.passwordShort', { n: PASSWORD_MIN }) }}</div>
          </div>
        </n-form-item>
        <n-form-item v-if="!isUpload" :label="t('share.limit')">
          <n-input-number v-model:value="limit" :min="1" :max="MAX_DOWNLOADS" :precision="0" clearable :placeholder="t('share.limitNone')" class="limit" />
        </n-form-item>
        <template v-else>
          <n-form-item :label="t('share.maxFileMb')">
            <n-input-number v-model:value="maxFileMb" :min="1" :precision="0" clearable :placeholder="t('share.limitNone')" class="limit" />
          </n-form-item>
          <n-form-item :label="t('share.maxFiles')">
            <n-input-number v-model:value="maxFiles" :min="1" :max="MAX_FILES" :precision="0" clearable :placeholder="t('share.limitNone')" class="limit" />
          </n-form-item>
          <n-form-item :label="t('share.maxTotalMb')">
            <n-input-number v-model:value="maxTotalMb" :min="1" :precision="0" clearable :placeholder="t('share.limitNone')" class="limit" />
          </n-form-item>
          <n-form-item :label="t('share.note')">
            <div class="field">
              <n-input v-model:value="note" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :placeholder="t('share.notePlaceholder')" :status="noteTooLong ? 'error' : undefined" />
              <div class="hint" :class="{ warn: noteTooLong }">{{ noteLength }} / {{ NOTE_MAX }}</div>
            </div>
          </n-form-item>
        </template>
      </n-form>
      <!-- stays in the modal: the reason belongs next to the form, not in a toast that is gone before it is read -->
      <n-alert v-if="error" type="error" class="gap">{{ error }}</n-alert>
    </template>

    <template v-else>
      <n-alert type="success" :title="result.share.kind === 'upload' ? t('share.createdUpload') : t('share.created')" class="gap">{{ t('share.onceOnly') }}</n-alert>
      <div class="link-row">
        <!-- the whole link, wrapped: a phone can not scroll inside a one-line box to check it -->
        <n-input
          ref="linkInput" :value="result.link" type="textarea" readonly :autosize="{ minRows: 1, maxRows: 4 }" class="link"
          :input-props="{ 'aria-label': t('share.created') }" @focus="selectLink"
        />
        <n-button type="primary" @click="copy">
          <template #icon><n-icon :component="copied ? CheckmarkOutline : CopyOutline" /></template>{{ copied ? t('share.copied') : t('share.copy') }}
        </n-button>
      </div>
      <div class="summary muted">
        <span>{{ t('share.expiresAt', { date: formatDate(result.share.expiresAt) }) }}</span>
        <span v-if="result.share.kind === 'upload'">{{ t('share.kindUpload') }}</span>
        <span v-if="result.share.maxFileBytes">{{ t('share.limitFile', { size: formatBytes(result.share.maxFileBytes) }) }}</span>
        <span v-if="result.share.maxFiles">{{ t('share.limitFiles', { n: result.share.maxFiles }) }}</span>
        <span v-if="result.share.maxTotalBytes">{{ t('share.limitTotal', { size: formatBytes(result.share.maxTotalBytes) }) }}</span>
        <span v-if="result.share.maxDownloads">{{ t('share.limitN', { n: result.share.maxDownloads }) }}</span>
        <span v-if="result.share.hasPassword">{{ t('share.withPassword') }}</span>
      </div>
      <n-alert v-if="copyFailed" type="warning" class="gap">{{ t('share.copyFailed') }}</n-alert>
    </template>

    <template #footer>
      <div class="foot">
        <template v-if="!result">
          <n-button :disabled="busy" @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="busy" :disabled="tooShort || noteTooLong || !kindOk" @click="create">
            <template #icon><n-icon :component="LinkOutline" /></template>{{ t('share.create') }}
          </n-button>
        </template>
        <template v-else>
          <router-link :to="{ name: 'links' }" class="all" @click="emit('update:show', false)">{{ t('share.viewAll') }}</router-link>
          <n-button @click="emit('update:show', false)">{{ t('common.close') }}</n-button>
        </template>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NIcon, NInput, NInputNumber, NModal, NRadio, NRadioButton, NRadioGroup } from 'naive-ui'
import { CheckmarkOutline, CopyOutline, LinkOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useAppStore } from '../store'
import { errorText } from '../composables'
import { formatBytes, formatDate } from '../utils'
import FileIcon from './FileIcon.vue'

// the server's limits (src/shares.ts)
const PASSWORD_MIN = 6
const MAX_DOWNLOADS = 100_000
const MAX_FILES = 100_000
const NOTE_MAX = 500
const MB = 1024 * 1024

const props = defineProps({ show: Boolean, space: { type: String, required: true }, item: { type: Object, default: null } })
const emit = defineEmits(['update:show'])
const { t } = useI18n()

// the choices the server takes (SHARE_MAX_DAYS may leave out the longer ones); if it still refuses one, its answer names
// the ones it takes and the choice shrinks to them
const store = useAppStore()
const allowedDays = ref(store.config?.shareDays?.length ? [...store.config.shareDays] : [1, 7, 30])
const days = ref(7)
const password = ref('')
const limit = ref(null)
const kind = ref('download')
const maxFileMb = ref(null)
const maxFiles = ref(null)
const maxTotalMb = ref(null)
const note = ref('')
const busy = ref(false)
const error = ref('')
// { share, link } once created: the only time the link can be shown
const result = ref(null)
const copied = ref(false)
const copyFailed = ref(false)
const linkInput = ref(null)

// a download link needs `download` here, a request link `upload` and a folder
const canDownload = computed(() => store.can(props.space, 'download'))
const canRequest = computed(() => props.item?.type === 'dir' && store.can(props.space, 'upload'))
const kindOk = computed(() => (kind.value === 'upload' ? canRequest.value : canDownload.value))
const isUpload = computed(() => kind.value === 'upload')
const noteLength = computed(() => Array.from(note.value.trim()).length)
const noteTooLong = computed(() => noteLength.value > NOTE_MAX)
const tooShort = computed(() => password.value.length > 0 && password.value.length < PASSWORD_MIN)

watch(() => props.show, v => {
  if (!v) return
  days.value = allowedDays.value.includes(7) ? 7 : allowedDays.value[allowedDays.value.length - 1]
  password.value = ''
  limit.value = null
  kind.value = canDownload.value ? 'download' : 'upload'
  maxFileMb.value = null
  maxFiles.value = null
  maxTotalMb.value = null
  note.value = ''
  error.value = ''
  result.value = null
  copied.value = false
  copyFailed.value = false
})

async function create() {
  if (busy.value || tooShort.value || noteTooLong.value || !kindOk.value || !props.item) return
  busy.value = true
  error.value = ''
  try {
    const r = await api.createShare({
      space: props.space, path: props.item.path, days: days.value,
      ...(password.value ? { password: password.value } : {}),
      ...(isUpload.value ? {
        kind: 'upload',
        ...(maxFileMb.value ? { maxFileBytes: maxFileMb.value * MB } : {}),
        ...(maxFiles.value ? { maxFiles: maxFiles.value } : {}),
        ...(maxTotalMb.value ? { maxTotalBytes: maxTotalMb.value * MB } : {}),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      } : limit.value ? { maxDownloads: limit.value } : {}),
    })
    password.value = ''
    result.value = { share: r.share, link: `${location.origin}${r.url}` }
    nextTick(selectLink)
  } catch (e) {
    if (e.code === 'share.bad-days') {
      const ok = String(e.params?.days ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)
      if (ok.length) {
        allowedDays.value = ok
        if (!ok.includes(days.value)) days.value = Math.max(...ok.filter(n => n < days.value), ok[0])
      }
    }
    error.value = errorText(e, t('common.unknownError'))
  } finally {
    busy.value = false
  }
}

function selectLink() {
  linkInput.value?.select?.()
}

async function copy() {
  const text = result.value?.link
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // no clipboard API (a plain http address that is not localhost): the selected text and the browser's own copy
    selectLink()
    let ok = false
    try { ok = document.execCommand('copy') } catch { /* not supported */ }
    if (!ok) { copyFailed.value = true; return }
  }
  copyFailed.value = false
  copied.value = true
  setTimeout(() => { copied.value = false }, 2500)
}
</script>

<style scoped>
.item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; padding: 10px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); }
.item-name { min-width: 0; font-weight: 500; overflow-wrap: anywhere; line-height: 1.5; padding-top: 2px; }
.form { display: flex; flex-direction: column; gap: 14px; }
.field { width: 100%; min-width: 0; }
.hint { font-size: 12.5px; margin-top: 4px; }
.hint.warn { color: var(--danger); }
.small { font-size: 13px; margin-top: -4px; }
.kinds { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.limit { width: 100%; max-width: 240px; }
.gap { margin-top: 14px; }
.link-row { display: flex; gap: 8px; margin-top: 14px; }
.link { flex: 1; min-width: 0; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; }
.link :deep(textarea) { word-break: break-all; }
.link-row > .n-button { flex-shrink: 0; }
.summary { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; font-size: 13px; }
.foot { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
.all { margin-right: auto; color: var(--primary); font-size: 14px; }
@media (max-width: 420px) {
  .link-row { flex-direction: column; }
}
</style>
