<template>
  <n-modal :show="show" preset="card" :title="title || t('files.chooseDestination')" style="width: min(520px, 94vw)" @update:show="v => emit('update:show', v)">
    <div v-if="spaces.length > 1 || (spaces.length === 1 && spaces[0].value !== space)" class="spaces">
      <span class="muted">{{ t('files.destSpace') }}</span>
      <n-radio-group :value="cur" name="dest-space" @update:value="pickSpace">
        <n-radio-button v-for="s in spaces" :key="s.value" :value="s.value" :label="s.label" />
      </n-radio-group>
    </div>
    <div class="path">
      <n-button v-if="path !== '/'" quaternary circle size="small" @click="open(parentPath(path))"><template #icon><n-icon :component="ArrowBackOutline" /></template></n-button>
      <n-icon :component="FolderOpenOutline" />
      <span class="mono truncate">{{ path }}</span>
    </div>
    <n-spin :show="loading">
      <div class="list">
        <button v-for="f in folders" :key="f.path" type="button" class="folder" @click="open(f.path)">
          <n-icon :component="Folder" color="var(--folder)" size="20" /><span class="truncate">{{ f.name }}</span>
        </button>
        <div v-if="!loading && !folders.length" class="muted none">{{ t('files.noSubfolders') }}</div>
      </div>
    </n-spin>
    <template #footer>
      <div class="foot">
        <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" @click="choose">{{ confirmText || t('common.confirm') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NModal, NRadioButton, NRadioGroup, NSpin } from 'naive-ui'
import { ArrowBackOutline, Folder, FolderOpenOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { parentPath } from '../utils'

const props = defineProps({
  show: Boolean, space: { type: String, default: 'home' }, title: String, confirmText: String,
  initial: { type: String, default: '/' }, admin: Boolean,
  /** [{ value, label }]: where the folder may be in (a picker is shown when there is more than one) */
  spaces: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:show', 'select'])
const { t } = useI18n()
const fb = useFeedback()
const cur = ref(props.space)
const path = ref('/')
const folders = ref([])
const loading = ref(false)

async function open(p) {
  loading.value = true
  try {
    const res = await (props.admin ? api.adminFolders(p) : api.folders(cur.value, p))
    path.value = res.path
    folders.value = res.entries
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

// the space being looked at may not be a place to put things (copying out of a read-only space): start in the first that is
watch(() => props.show, v => {
  if (!v) return
  const here = !props.spaces.length || props.spaces.some(s => s.value === props.space)
  cur.value = here ? props.space : props.spaces[0].value
  open(here ? props.initial || '/' : '/')
})
function pickSpace(v) { cur.value = v; open('/') }

function choose() {
  emit('select', path.value, cur.value)
  emit('update:show', false)
}
</script>

<style scoped>
.spaces { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin-bottom: 10px; }
.path { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--surface-2); border-radius: 8px; margin-bottom: 10px; }
.list { max-height: 320px; overflow-y: auto; min-height: 120px; }
.folder { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border-radius: 8px; cursor: pointer; }
.folder:hover, .folder:focus-visible { background: var(--surface-2); }
.none { padding: 24px; text-align: center; font-size: 14px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
