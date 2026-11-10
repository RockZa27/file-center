<template>
  <div class="md">
    <h3>{{ t('myData.activityTitle') }}</h3>
    <p class="muted small">{{ t('myData.activityIntro') }}</p>
    <n-spin :show="loading && !rows.length">
      <div v-if="!rows.length && !loading" class="muted small" data-testid="my-activity-none">{{ t('myData.none') }}</div>
      <div v-for="r in rows" :key="r.key" class="row" data-testid="my-activity-row">
        <div class="head">
          <span class="muted nowrap">{{ formatDate(r.ts) }}</span>
          <n-tag size="small" round :bordered="false">{{ label(r.action) }}</n-tag>
        </div>
        <div v-if="r.target" class="mono target" :title="r.target">{{ r.target }}</div>
        <div v-if="r.ip" class="mono muted small">IP {{ r.ip }}</div>
      </div>
    </n-spin>
    <div v-if="hasMore" class="more"><n-button secondary :loading="loading" @click="more">{{ t('myData.more') }}</n-button></div>

    <h3>{{ t('myData.downloadTitle') }}</h3>
    <p class="muted small">{{ t('myData.downloadIntro') }}</p>
    <input type="text" name="username" autocomplete="username" :value="app.user?.username || ''" readonly hidden>
    <n-input v-model:value="password" type="password" show-password-on="click" :placeholder="t('myData.password')" :input-props="{ autocomplete: 'current-password' }" @keyup.enter="save" />
    <div class="go">
      <n-button type="primary" :loading="busy" :disabled="!password" @click="save">{{ t('myData.download') }}</n-button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NTag } from 'naive-ui'
import { api, downloadMyData } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatDate } from '../utils'

const { t, te } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const rows = ref([])
const loading = ref(false)
const hasMore = ref(false)
const page = ref(0)
const password = ref('')
const busy = ref(false)
let seq = 0

// the labels of the activity page; an action with no label shows its code
const label = a => (te(`action.${a}`) ? t(`action.${a}`) : a)

async function more() {
  loading.value = true
  try {
    const r = await api.myActivity({ page: page.value + 1, pageSize: 25 })
    page.value++
    rows.value = rows.value.concat(r.items.map(i => ({ ...i, key: seq++ })))
    hasMore.value = r.hasMore
  } catch (e) {
    fb.fail(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!password.value || busy.value) return
  busy.value = true
  try {
    await downloadMyData(password.value)
    password.value = ''
    fb.ok(t('myData.done'))
  } catch (e) {
    fb.fail(e) // a wrong password, or "once a minute" with the seconds to wait, as the server words them
  } finally {
    busy.value = false
  }
}

onMounted(more)
</script>

<style scoped>
.md h3 { margin: 16px 0 6px; font-size: 15px; }
.md h3:first-child { margin-top: 0; }
.small { font-size: 12px; margin: 0 0 8px; }
.row { padding: 8px 0; border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.2)); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.nowrap { white-space: nowrap; }
.target { overflow-wrap: anywhere; font-size: 12px; margin-top: 2px; }
.more, .go { display: flex; justify-content: center; margin-top: 10px; }
.go { justify-content: flex-end; }
</style>
