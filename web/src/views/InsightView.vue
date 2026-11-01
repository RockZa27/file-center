<template>
  <div class="page">
    <page-header :title="t('insight.title')" :description="t('insight.subtitle')">
      <template #actions>
        <n-select v-if="scopeOptions.length > 1" v-model:value="scope" :options="scopeOptions" class="scope" :aria-label="t('insight.scope')" :consistent-menu-width="false" filterable />
        <n-button type="primary" :loading="running" :disabled="running" @click="start">
          <template #icon><n-icon :component="RefreshOutline" /></template>{{ result ? t('insight.rescan') : t('insight.scan') }}
        </n-button>
      </template>
    </page-header>

    <n-alert v-if="busy" type="warning" :show-icon="true" class="gap">{{ t('insight.busy') }}</n-alert>
    <div v-if="running" class="surface empty"><n-spin size="small" /> <span class="muted">{{ t('insight.running') }}</span></div>
    <div v-else-if="!result" class="surface empty muted">{{ t('insight.none') }}</div>

    <template v-if="result">
      <n-alert v-if="cut" type="info" :show-icon="true" class="gap">{{ cut }}</n-alert>
      <div class="cards">
        <div class="surface card"><div class="label muted">{{ t('insight.files') }}</div><div class="value">{{ result.files.toLocaleString() }}</div></div>
        <div class="surface card"><div class="label muted">{{ t('insight.size') }}</div><div class="value">{{ formatBytes(result.size) }}</div></div>
        <div class="surface card"><div class="label muted">{{ t('insight.wasted') }}</div><div class="value">{{ formatBytes(result.duplicates.wasted) }}</div></div>
      </div>
      <div class="muted small-note">{{ t('insight.scannedAt', { time: formatDate(result.scannedAt) }) }}</div>

      <section class="surface block">
        <h2>{{ t('insight.byType') }}</h2>
        <div v-if="!result.types.length" class="muted">{{ t('insight.noFiles') }}</div>
        <div v-for="ty in result.types" :key="ty.ext" class="type-row">
          <span class="type-name mono">{{ ty.ext ? `.${ty.ext}` : t('insight.noExt') }}</span>
          <span class="bar"><span class="fill" :style="{ width: Math.max(1, (ty.size / (result.types[0].size || 1)) * 100) + '%' }" /></span>
          <span class="type-size">{{ formatBytes(ty.size) }}</span>
          <span class="muted type-count">{{ t('insight.nFiles', { n: ty.files.toLocaleString() }) }}</span>
        </div>
      </section>

      <section class="surface block">
        <h2>{{ t('insight.largest') }}</h2>
        <div v-if="!result.largest.length" class="muted">{{ t('insight.noFiles') }}</div>
        <div v-for="f in result.largest" :key="f.path" class="file-row">
          <div class="file-main">
            <router-link :to="folderLink(f.path)" class="file-name wrap">{{ nameOf(f.path) }}</router-link>
            <div class="muted mono small wrap">{{ dirOf(f.path) }}</div>
          </div>
          <span class="file-size">{{ formatBytes(f.size) }}</span>
          <span class="muted file-date">{{ formatDate(f.mtime) }}</span>
        </div>
      </section>

      <section class="surface block">
        <h2>{{ t('insight.duplicates') }}</h2>
        <div class="muted lead">{{ t('insight.duplicatesHelp') }}</div>
        <div v-if="!result.duplicates.groups.length" class="muted">{{ t('insight.noDuplicates') }}</div>
        <div v-else-if="result.duplicates.totalGroups > result.duplicates.groups.length" class="muted small-note">
          {{ t('insight.groupsShown', { shown: result.duplicates.groups.length, total: result.duplicates.totalGroups }) }}
        </div>
        <div v-for="g in result.duplicates.groups" :key="g.hash + g.size" class="group">
          <div class="group-head">
            <strong>{{ t('insight.copies', { n: g.count, size: formatBytes(g.size) }) }}</strong>
            <span class="muted">{{ t('insight.groupWasted', { size: formatBytes(g.wasted) }) }}</span>
          </div>
          <label v-for="(f, i) in g.files" :key="f.path" class="dup-row">
            <n-checkbox v-if="canTrash" :checked="picked.has(f.path)" :disabled="!picked.has(f.path) && onlyOneLeft(g)" @update:checked="v => pick(g, f.path, v)" />
            <span class="file-main">
              <router-link :to="folderLink(f.path)" class="file-name wrap" @click.stop>{{ nameOf(f.path) }}</router-link>
              <span class="muted mono small wrap">{{ dirOf(f.path) }}</span>
            </span>
            <n-tag v-if="i === 0" size="small" round type="success">{{ t('insight.oldest') }}</n-tag>
            <span class="muted file-date">{{ formatDate(f.mtime) }}</span>
          </label>
          <div v-if="g.count > g.files.length" class="muted small-note">{{ t('insight.moreCopies', { n: g.count - g.files.length }) }}</div>
          <div v-if="canTrash" class="group-actions">
            <n-button size="small" type="error" secondary :disabled="!pickedIn(g).length || trashing" @click="trash(g)">
              <template #icon><n-icon :component="TrashOutline" /></template>{{ t('insight.trash', { n: pickedIn(g).length }) }}
            </n-button>
          </div>
        </div>
        <div v-if="!canTrash && result.duplicates.groups.length" class="muted small-note">{{ t('insight.readOnly') }}</div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NIcon, NSelect, NSpin, NTag } from 'naive-ui'
import { RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { api, ApiError } from '../api'
import PageHeader from '../components/PageHeader.vue'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const scope = ref('me')
const info = ref(null)
const busy = ref(false)
const trashing = ref(false)
const users = ref([])
// the copies ticked for the trash (by path); a group always keeps at least one
const picked = ref(new Set())
let timer = null

const result = computed(() => info.value?.result || null)
const running = computed(() => info.value?.state === 'running')
const canTrash = computed(() => !!info.value?.canTrash)

const scopeOptions = computed(() => {
  const o = [{ value: 'me', label: t('insight.scopeMe') }]
  if (app.isAdmin) o.push({ value: 'all', label: t('insight.scopeAll') })
  if (app.isStaff) {
    for (const u of users.value) {
      if (u.username === app.user.username || (!app.isAdmin && u.role !== 'user')) continue
      o.push({ value: `user:${u.username}`, label: u.name && u.name !== u.username ? `${u.name} (${u.username})` : u.username })
    }
  }
  return o
})

const cut = computed(() => {
  const c = result.value?.truncated
  if (!c) return ''
  const parts = []
  if (c.files) parts.push(t('insight.cutFiles'))
  if (c.time) parts.push(t('insight.cutTime'))
  if (c.hashBudget) parts.push(t('insight.cutHash'))
  return parts.join(' ')
})

const nameOf = p => p.slice(p.lastIndexOf('/') + 1)
const dirOf = p => p.slice(0, p.lastIndexOf('/')) || '/'
const fullPath = p => (info.value?.base || '') + p

/** the folder that holds the file, opened with the file marked */
function folderLink(p) {
  const full = fullPath(p)
  const query = { path: dirOf(full), select: full }
  const space = info.value?.space || 'home'
  if (space.startsWith('user:')) return { name: 'user-files', params: { username: space.slice(5) }, query: { path: dirOf(p), select: p } }
  return { name: 'files', query }
}

function preselect() {
  const s = new Set()
  // keep the oldest copy of each group, tick the rest
  for (const g of result.value?.duplicates.groups || []) for (const f of g.files.slice(1)) s.add(f.path)
  picked.value = s
}
const pickedIn = g => g.files.filter(f => picked.value.has(f.path)).map(f => f.path)
// the copies not listed (a group over the list limit) are never ticked, so they always remain: still keep one ticked-off listed
const onlyOneLeft = g => g.count - pickedIn(g).length <= 1
function pick(g, path, on) {
  const s = new Set(picked.value)
  if (on) s.add(path); else s.delete(path)
  picked.value = s
}

async function load() {
  try {
    info.value = await api.insight(scope.value)
    busy.value = false
    if (info.value.state === 'running') schedule()
    else preselect()
  } catch (e) { info.value = null; fb.fail(e) }
}
function schedule() { clearTimeout(timer); timer = setTimeout(load, 1500) }

async function start() {
  try {
    const r = await api.insightScan(scope.value)
    info.value = r
    busy.value = false
    schedule()
  } catch (e) {
    if (e instanceof ApiError && e.code === 'insight.busy') { busy.value = true; return }
    fb.fail(e)
  }
}

async function trash(g) {
  const items = pickedIn(g).map(fullPath)
  if (!items.length) return
  if (!(await fb.confirm({ title: t('insight.trashTitle'), content: t('insight.trashConfirm', { n: items.length }), positive: t('common.delete'), danger: true }))) return
  trashing.value = true
  try {
    const r = await api.remove('home', items, true)
    const failed = new Set(r.failed.map(f => f.path))
    const gone = new Set(pickedIn(g).filter(p => !failed.has(fullPath(p))))
    // the page follows what happened without a new scan: the copies leave the group, a group of one is no group
    const groups = info.value.result.duplicates.groups
    g.files = g.files.filter(f => !gone.has(f.path))
    g.count -= gone.size
    g.wasted = g.size * (g.count - 1)
    const dups = info.value.result.duplicates
    dups.groups = groups.filter(x => x.count > 1)
    dups.wasted = dups.groups.reduce((n, x) => n + x.wasted, 0)
    picked.value = new Set([...picked.value].filter(p => !gone.has(p)))
    if (r.failed.length) fb.fail(null, r.failed[0].error)
    else fb.ok(t('insight.trashed', { n: r.done }))
    app.refresh?.()
  } catch (e) { fb.fail(e) } finally { trashing.value = false }
}

watch(scope, () => { clearTimeout(timer); info.value = null; busy.value = false; load() })
onMounted(async () => {
  if (app.isStaff) { try { users.value = (await api.users()).users } catch { /* only the own space is offered */ } }
  load()
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style scoped>
.scope { min-width: 200px; max-width: 280px; }
.gap { margin-bottom: 14px; }
.empty { padding: 28px; display: flex; gap: 10px; align-items: center; justify-content: center; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 8px; }
.card { padding: 16px 18px; }
.label { font-size: 13px; }
.value { font-size: 26px; font-weight: 700; margin-top: 4px; }
.small-note { font-size: 12.5px; margin: 6px 0 14px; }
.block { padding: 18px 20px; margin-bottom: 16px; }
.block h2 { margin: 0 0 12px; font-size: 17px; }
.lead { margin-bottom: 12px; }
.type-row { display: grid; grid-template-columns: 90px minmax(60px, 1fr) 80px 110px; gap: 10px; align-items: center; padding: 4px 0; }
.type-name { overflow-wrap: anywhere; }
.bar { height: 8px; border-radius: 4px; background: var(--n-border-color, rgba(128, 128, 128, 0.2)); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--primary, #2563eb); }
.type-size { text-align: right; font-variant-numeric: tabular-nums; }
.type-count { text-align: right; font-size: 12.5px; }
.file-row, .dup-row { display: flex; gap: 12px; align-items: center; padding: 7px 0; border-top: 1px solid rgba(128, 128, 128, 0.15); }
.file-row:first-of-type { border-top: 0; }
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.file-name { font-weight: 600; color: inherit; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.file-size { font-variant-numeric: tabular-nums; white-space: nowrap; }
.file-date { white-space: nowrap; font-size: 12.5px; }
.wrap { overflow-wrap: anywhere; }
.small { font-size: 12.5px; }
.group { border: 1px solid rgba(128, 128, 128, 0.25); border-radius: 10px; padding: 10px 14px; margin-top: 12px; }
.group-head { display: flex; flex-wrap: wrap; gap: 4px 14px; justify-content: space-between; margin-bottom: 4px; }
.dup-row { cursor: pointer; }
.group-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
@media (max-width: 640px) {
  .type-row { grid-template-columns: 70px 1fr 70px; }
  .type-count { display: none; }
  .file-date { display: none; }
}
</style>
