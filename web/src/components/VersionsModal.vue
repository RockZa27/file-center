<template>
  <n-modal :show="show" preset="card" :title="t('versions.title', { name: item?.name || '' })" :bordered="false" class="versions-modal" style="width: min(660px, 94vw)" @update:show="v => emit('update:show', v)">
    <n-spin :show="loading">
      <div v-if="data" class="now muted">{{ t('versions.current', { size: formatBytes(data.current.size), date: formatDate(data.current.mtime) }) }}</div>
      <div v-if="loadError" class="muted none">{{ loadError }}</div>
      <div v-else-if="data && !data.items.length" class="muted none">{{ t('versions.empty') }}</div>
      <ul v-else-if="data" class="list">
        <li v-for="v in data.items" :key="v.id" class="row">
          <div class="info">
            <div class="when" :title="formatDate(v.savedAt)">{{ ago(v.savedAt) }}</div>
            <div class="muted small">{{ formatDate(v.savedAt) }}</div>
            <div class="muted small meta">
              <span>{{ formatBytes(v.size) }}</span>
              <span>{{ t('versions.by', { user: v.savedBy }) }}</span>
              <n-tag size="small" round :bordered="false">{{ t(`versions.reason.${v.reason}`) }}</n-tag>
            </div>
          </div>
          <div class="acts">
            <n-button v-if="canDownload" size="small" secondary tag="a" :href="api.versionUrl(space, item.path, v.id)">
              <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
            </n-button>
            <n-button v-if="canWrite" size="small" secondary type="primary" :disabled="busy" @click="restore(v)">
              <template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('versions.restore') }}
            </n-button>
            <n-button v-if="canWrite" size="small" secondary type="error" :disabled="busy" @click="remove(v)">
              <template #icon><n-icon :component="TrashOutline" /></template>{{ t('versions.delete') }}
            </n-button>
          </div>
        </li>
      </ul>
    </n-spin>
  </n-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NModal, NSpin, NTag } from 'naive-ui'
import { ArrowUndoOutline, DownloadOutline, TrashOutline } from '@vicons/ionicons5'
import { relativeTime } from '../account-utils'
import { api } from '../api'
import { useFeedback } from '../composables'
import { formatBytes, formatDate } from '../utils'

/** Earlier versions of one file: download, restore and delete (the last two need write). */
const props = defineProps({ show: Boolean, space: String, item: Object, canWrite: Boolean, canDownload: Boolean })
const emit = defineEmits(['update:show', 'restored'])
const { t, locale } = useI18n()
const fb = useFeedback()

const data = ref(null)
const loading = ref(false)
const loadError = ref('')
const busy = ref(false)
const ago = iso => relativeTime(Date.parse(iso), Date.now(), locale.value)

async function load() {
  loading.value = true
  loadError.value = ''
  try { data.value = await api.versions(props.space, props.item.path) } catch (e) { data.value = null; loadError.value = e.message } finally { loading.value = false }
}
watch(() => [props.show, props.item?.path], () => { if (props.show && props.item) { data.value = null; load() } })

async function restore(v) {
  if (!(await fb.confirm({ title: t('versions.restoreTitle'), content: `${t('versions.restoreText')} (${formatDate(v.savedAt)})`, positive: t('versions.restore') }))) return
  busy.value = true
  try {
    await api.restoreVersion(props.space, props.item.path, v.id, data.value.current.mtime)
    fb.ok(t('versions.restored'))
    emit('restored', props.item)
    await load()
  } catch (e) {
    if (e.status === 409 && e.code === 'files.changed-elsewhere') {
      if (await fb.confirm({ title: t('versions.changedTitle'), content: t('versions.changedText'), positive: t('versions.reload') })) await load()
    } else fb.fail(e)
  } finally { busy.value = false }
}

async function remove(v) {
  if (!(await fb.confirm({ title: t('versions.deleteTitle'), content: `${t('versions.deleteText')} (${formatDate(v.savedAt)})`, positive: t('versions.delete'), danger: true }))) return
  busy.value = true
  try {
    await api.deleteVersion(props.space, props.item.path, v.id)
    fb.ok(t('versions.deleted'))
    await load()
  } catch (e) { fb.fail(e) } finally { busy.value = false }
}
</script>

<style scoped>
.now { font-size: 13px; margin-bottom: 8px; overflow-wrap: anywhere; }
.none { padding: 32px 8px; text-align: center; font-size: 14px; }
.list { list-style: none; margin: 0; padding: 0; max-height: 60vh; overflow-y: auto; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--border); }
.info { min-width: 0; flex: 1 1 220px; }
.when { font-weight: 600; }
.small { font-size: 12.5px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; overflow-wrap: anywhere; }
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
