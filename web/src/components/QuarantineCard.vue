<template>
  <!-- files the virus scanner held back: listed for the admin only; delete, or release a false alarm to where it was going -->
  <div class="surface block">
    <div class="head">
      <h2>{{ t('quarantine.title') }}</h2>
      <n-tag v-if="items" :type="items.length ? 'warning' : 'default'" size="small" round :bordered="false">{{ items.length }}</n-tag>
    </div>
    <div class="muted lead">{{ t('quarantine.lead') }}</div>
    <n-alert v-if="loadError" type="error" class="gap">{{ loadError }}</n-alert>
    <n-spin :show="loading && !items">
      <div v-if="items && !items.length" class="muted empty">{{ t('quarantine.empty') }}</div>
      <div v-for="m in items || []" :key="m.id" class="row">
        <div class="info">
          <div class="name">{{ m.name }}</div>
          <div class="muted small">
            <span class="sig">{{ m.signature }}</span> · {{ formatBytes(m.size) }} · {{ t(`quarantine.via_${m.via}`) }} · {{ m.by }} ({{ m.ip }}) · {{ formatDate(m.at) }}
          </div>
          <div class="muted small mono dest">{{ t('quarantine.dest') }}: {{ m.dest }}</div>
        </div>
        <div class="actions">
          <n-button size="small" secondary :loading="busy === m.id" @click="release(m)">{{ t('quarantine.release') }}</n-button>
          <n-button size="small" type="error" secondary :loading="busy === m.id" @click="remove(m)">{{ t('common.delete') }}</n-button>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NSpin, NTag } from 'naive-ui'
import { api } from '../api'
import { errorText, useFeedback } from '../composables'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const items = ref(null)
const loading = ref(false)
const loadError = ref('')
const busy = ref('')

async function load() {
  loading.value = true
  try {
    items.value = (await api.quarantineList()).items
    loadError.value = ''
  } catch (e) { loadError.value = errorText(e, t('common.unknownError')) } finally { loading.value = false }
}

async function remove(m) {
  if (!(await fb.confirm({ title: t('quarantine.deleteTitle'), content: t('quarantine.deleteText'), positive: t('common.delete'), danger: true }))) return
  busy.value = m.id
  try {
    await api.quarantineDelete(m.id)
    fb.ok(t('quarantine.deleted'))
  } catch (e) { fb.fail(e) } finally { busy.value = ''; load() }
}

async function release(m) {
  if (!(await fb.confirm({ title: t('quarantine.releaseTitle'), content: t('quarantine.releaseText'), positive: t('quarantine.release'), danger: true }))) return
  busy.value = m.id
  try {
    const r = await api.quarantineRelease(m.id)
    fb.ok(t('quarantine.released', { name: r.name }))
  } catch (e) { fb.fail(e) } finally { busy.value = ''; load() }
}

onMounted(load)
defineExpose({ load })
</script>

<style scoped>
.block { padding: 22px; margin-bottom: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.lead { font-size: 13.5px; line-height: 1.6; margin-bottom: 8px; }
.gap { margin-bottom: 12px; }
.empty { padding: 12px 0; }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }
.info { min-width: 0; }
.name { font-weight: 500; overflow-wrap: anywhere; }
.sig { color: var(--danger); font-weight: 500; }
.small { font-size: 12.5px; margin-top: 2px; overflow-wrap: anywhere; }
.dest { word-break: break-all; }
.actions { display: flex; gap: 6px; flex-shrink: 0; }
@media (max-width: 560px) { .row { flex-direction: column; } }
</style>
