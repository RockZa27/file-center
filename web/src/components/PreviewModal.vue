<template>
  <n-modal :show="show" preset="card" style="width: min(980px, 96vw)" :title="item?.name" :bordered="false" @update:show="close">
    <template #header-extra>
      <n-button v-if="canDownload && item" quaternary size="small" tag="a" :href="api.downloadUrl(space, item.path)">
        <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
      </n-button>
    </template>
    <div v-if="item" class="stage">
      <img v-if="kind === 'image'" :src="inlineUrl" :alt="item.name" class="media">
      <video v-else-if="kind === 'video'" :src="inlineUrl" controls class="media" />
      <audio v-else-if="kind === 'audio'" :src="inlineUrl" controls class="audio" />
      <iframe v-else-if="kind === 'pdf'" :src="inlineUrl" class="pdf" :title="item.name" />
      <template v-else-if="kind === 'text'">
        <n-spin :show="loading" style="width: 100%">
          <n-alert v-if="loadError" type="warning">{{ loadError }}</n-alert>
          <textarea v-else v-model="text" class="editor mono" :readonly="!canEdit" spellcheck="false" />
        </n-spin>
      </template>
      <div v-else class="muted">{{ t('files.noPreview') }}</div>
    </div>
    <template #footer>
      <div class="foot">
        <div class="nav">
          <n-button quaternary circle :disabled="!prev" @click="go(prev)"><template #icon><n-icon :component="ChevronBackOutline" /></template></n-button>
          <span class="muted pos">{{ position }}</span>
          <n-button quaternary circle :disabled="!next" @click="go(next)"><template #icon><n-icon :component="ChevronForwardOutline" /></template></n-button>
        </div>
        <n-button v-if="kind === 'text' && canEdit && !loadError" type="primary" :loading="saving" :disabled="text === original" @click="save">
          <template #icon><n-icon :component="SaveOutline" /></template>{{ t('common.save') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { ChevronBackOutline, ChevronForwardOutline, DownloadOutline, SaveOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { kindOf } from '../utils'

const props = defineProps({
  show: Boolean, space: String, item: Object, siblings: { type: Array, default: () => [] },
  canEdit: Boolean, canDownload: Boolean,
})
const emit = defineEmits(['update:show', 'saved'])
const { t } = useI18n()
const fb = useFeedback()

const current = ref(null)
const text = ref('')
const original = ref('')
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')

const item = computed(() => current.value)
const kind = computed(() => (item.value ? kindOf(item.value.name) : 'other'))
const inlineUrl = computed(() => api.downloadUrl(props.space, item.value.path, true))
const list = computed(() => props.siblings.filter(s => s.type === 'file' && kindOf(s.name) !== 'other'))
const index = computed(() => list.value.findIndex(s => s.path === item.value?.path))
const prev = computed(() => (index.value > 0 ? list.value[index.value - 1] : null))
const next = computed(() => (index.value >= 0 && index.value < list.value.length - 1 ? list.value[index.value + 1] : null))
const position = computed(() => (index.value >= 0 ? `${index.value + 1} / ${list.value.length}` : ''))

async function loadText() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.getContent(props.space, item.value.path)
    text.value = original.value = res.content
  } catch (e) {
    loadError.value = e.message
  } finally { loading.value = false }
}

watch(() => [props.show, props.item], () => {
  if (!props.show || !props.item) return
  // reopening the same file does not change `current`: load it again so discarded edits are gone
  if (current.value === props.item && kind.value === 'text') loadText()
  current.value = props.item
}, { immediate: true })

watch(current, c => { if (c && kindOf(c.name) === 'text') loadText() })

async function go(it) {
  if (!it) return
  if (!(await leave())) return
  current.value = it
}

async function leave() {
  if (kind.value !== 'text' || text.value === original.value || !props.canEdit) return true
  return fb.confirm({ title: t('files.unsaved'), content: t('files.unsavedText'), positive: t('files.discard'), danger: true })
}

async function close(v) {
  if (!v && !(await leave())) return
  emit('update:show', v)
}

async function save() {
  saving.value = true
  try {
    await api.putContent(props.space, item.value.path, text.value)
    original.value = text.value
    fb.ok(t('common.saved'))
    emit('saved')
  } catch (e) { fb.fail(e) } finally { saving.value = false }
}
</script>

<style scoped>
.stage { display: grid; place-items: center; min-height: 240px; }
.media { max-width: 100%; max-height: 70vh; border-radius: 8px; }
.audio { width: 100%; }
.pdf { width: 100%; height: 70vh; border: 0; border-radius: 8px; background: var(--surface-2); }
.editor { width: 100%; min-height: 50vh; resize: vertical; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); line-height: 1.55; tab-size: 2; }
.foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.nav { display: flex; align-items: center; gap: 4px; }
.pos { font-size: 13px; min-width: 56px; text-align: center; }
</style>
