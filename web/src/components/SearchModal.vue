<template>
  <n-modal :show="show" preset="card" :title="t('search.title')" style="width: min(620px, 94vw)" @update:show="v => emit('update:show', v)" @after-enter="input?.focus()">
    <n-input ref="input" v-model:value="q" clearable :placeholder="t('search.placeholder')" @update:value="onType">
      <template #prefix><n-icon :component="SearchOutline" /></template>
    </n-input>
    <n-spin :show="loading">
      <div class="results">
        <button v-for="r in results" :key="r.path" type="button" class="row-btn" @click="pick(r)">
          <file-icon :item="r" :size="22" />
          <div class="grow"><div class="truncate nm">{{ r.name }}</div><div class="truncate muted p">{{ parentPath(r.path) }}</div></div>
          <span v-if="r.type === 'file'" class="muted sz">{{ formatBytes(r.size) }}</span>
        </button>
        <div v-if="searched && !loading && !results.length" class="muted none">{{ t('search.noResults') }}</div>
        <div v-if="!searched" class="muted none">{{ t('search.hint') }}</div>
        <div v-if="truncated" class="muted none">{{ t('search.truncated') }}</div>
      </div>
    </n-spin>
  </n-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NIcon, NInput, NModal, NSpin } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { formatBytes, parentPath } from '../utils'
import FileIcon from './FileIcon.vue'

const props = defineProps({ show: Boolean, space: { type: String, required: true } })
const emit = defineEmits(['update:show', 'select'])
const { t } = useI18n()
const fb = useFeedback()
const input = ref(null)
const q = ref('')
const results = ref([])
const loading = ref(false)
const searched = ref(false)
const truncated = ref(false)
let timer = null
let ticket = 0

watch(() => props.show, v => { if (v) { q.value = ''; results.value = []; searched.value = false; truncated.value = false } })

function onType(v) {
  clearTimeout(timer)
  if (!v.trim()) { results.value = []; searched.value = false; return }
  timer = setTimeout(async () => {
    const mine = ++ticket
    loading.value = true
    try {
      const res = await api.search(props.space, v.trim(), '/')
      if (mine !== ticket) return
      results.value = res.results
      truncated.value = res.truncated
      searched.value = true
    } catch (e) { fb.fail(e) } finally { if (mine === ticket) loading.value = false }
  }, 300)
}

function pick(r) {
  emit('select', r)
  emit('update:show', false)
}
</script>

<style scoped>
.results { margin-top: 12px; max-height: 380px; overflow-y: auto; min-height: 100px; }
.row-btn { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.row-btn:hover, .row-btn:focus-visible { background: var(--surface-2); }
.nm { font-size: 14px; font-weight: 500; }
.p { font-size: 12px; }
.sz { font-size: 12px; flex: none; }
.none { padding: 20px; text-align: center; font-size: 14px; }
</style>
