<template>
  <div class="page narrow">
    <page-header :title="t('nav.backup')" :description="t('backup.subtitle')">
      <template #actions>
      <div class="head-actions">
        <n-button :loading="loading" :disabled="restoring" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
        <n-button type="primary" :loading="creating" :disabled="restoring || working" @click="backupNow"><template #icon><n-icon :component="ArchiveOutline" /></template>{{ t('backup.now') }}</n-button>
      </div>
      </template>
    </page-header>

    <!-- restarting after a restore -->
    <div v-if="restoring" class="surface block center">
      <n-spin size="large" />
      <h2>{{ t('backup.restoring') }}</h2>
      <p class="muted">{{ t('backup.waiting') }}</p>
    </div>

    <div v-else-if="loading && !data" class="surface"><list-skeleton :rows="4" /></div>
    <div v-else>
      <template v-if="data">
        <n-alert v-if="settings.sameDisk" type="warning" :title="t('backup.sameDiskTitle')" class="gap">{{ t('backup.sameDisk') }}</n-alert>

        <!-- the disk was too full: a backup was refused or stopped -->
        <n-alert v-if="noSpace" type="error" :title="t('backupSet.noSpaceTitle')" class="gap" data-testid="no-space">
          <div>{{ status.message }}</div>
          <div v-if="status.params?.needed != null" class="strong">{{ t('backupSet.noSpaceNeeds', { needed: formatBytes(Number(status.params.needed)), free: status.params.free == null ? t('backupSet.unknownFree') : formatBytes(Number(status.params.free)) }) }}</div>
          <div class="todo-title">{{ t('backupSet.noSpaceTodo') }}</div>
          <ul class="todo"><li>{{ t('backupSet.todoKeep') }}</li><li>{{ t('backupSet.todoFiles') }}</li><li>{{ t('backupSet.todoDir') }}</li></ul>
        </n-alert>

        <div class="surface block">
          <h2>{{ t('backup.status') }}</h2>
          <div class="kv">
            <span class="muted">{{ t('backup.lastSuccess') }}</span>
            <span class="strong">{{ status?.lastSuccess ? formatDate(status.lastSuccess) : t('common.never') }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.lastAttempt') }}</span>
            <span v-if="status" class="val">
              <n-tag :type="status.status === 'failed' ? 'error' : 'success'" size="small" round :bordered="false">{{ status.status === 'failed' ? t('backup.failed') : t('backup.ok') }}</n-tag>
              <span class="muted">{{ formatDate(status.lastAttempt) }}</span>
            </span>
            <span v-else>{{ t('common.never') }}</span>
          </div>
          <n-alert v-if="status?.status === 'failed' && !noSpace" type="error" class="gap top">{{ status.message }}</n-alert>
          <div class="kv">
            <span class="muted">{{ t('backupSet.scheduleNow') }}</span>
            <span class="val">{{ scheduleText(settings.schedule) }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.dir') }}</span>
            <span class="mono path">{{ settings.dir }}</span>
          </div>
        </div>

        <div class="surface block" data-testid="backup-settings">
          <h2>{{ t('backupSet.title') }}</h2>
          <n-alert v-if="settings.sameDisk" type="warning" :show-icon="false" class="gap" data-testid="same-disk">{{ t('backupSet.sameDiskHint') }}</n-alert>

          <div class="field">
            <div class="label">
              <span class="strong">{{ t('backupSet.compression') }}</span>
              <n-tag v-if="isDefault('compression')" size="small" round :bordered="false">{{ t('backupSet.isDefault') }}</n-tag>
              <n-button v-else text size="tiny" type="primary" @click="reset('compression')">{{ t('backupSet.useDefault') }}</n-button>
            </div>
            <n-radio-group v-model:value="draft.compression" name="compression">
              <n-radio-button v-for="c in ['fast', 'balanced', 'smallest']" :key="c" :value="c" :label="t(`backupSet.${c}`)" />
            </n-radio-group>
            <div class="hint muted">{{ t('backupSet.compressionHint') }}</div>
          </div>

          <div class="field">
            <div class="label">
              <span class="strong">{{ t('backupSet.schedule') }}</span>
              <n-tag v-if="isDefault('schedule')" size="small" round :bordered="false">{{ t('backupSet.isDefault') }}</n-tag>
              <n-button v-else text size="tiny" type="primary" @click="reset('schedule')">{{ t('backupSet.useDefault') }}</n-button>
            </div>
            <n-radio-group v-model:value="draft.mode" name="mode" class="modes">
              <n-radio v-for="m in ['off', 'daily', 'weekly', 'interval']" :key="m" :value="m" >{{ t(`backupSet.mode${m[0].toUpperCase()}${m.slice(1)}`) }}</n-radio>
            </n-radio-group>
            <div v-if="draft.mode === 'weekly'" class="days" role="group" :aria-label="t('backupSet.days')">
              <n-button v-for="(name, i) in dayNames" :key="i" size="small" :type="draft.days.includes(i) ? 'primary' : 'default'" :secondary="!draft.days.includes(i)" :aria-pressed="draft.days.includes(i)" @click="toggleDay(i)">{{ name }}</n-button>
            </div>
            <div v-if="draft.mode === 'daily' || draft.mode === 'weekly'" class="row">
              <span class="muted">{{ t('backupSet.time') }}</span>
              <n-time-picker v-model:formatted-value="draft.time" value-format="HH:mm" format="HH:mm" :actions="['confirm']" :clearable="false" style="width: 130px" />
            </div>
            <div v-if="draft.mode === 'interval'" class="row">
              <span class="muted">{{ t('backupSet.hours') }}</span>
              <n-input-number v-model:value="draft.hours" :min="1" :max="168" :precision="0" style="width: 150px"><template #suffix>{{ t('backupSet.hoursUnit') }}</template></n-input-number>
            </div>
            <div class="hint muted">{{ t('backupSet.tz', { name: settings.timezone?.name, offset: offsetText, now: serverStamp(settings.serverTime) }) }}</div>
            <div class="hint"><span class="muted">{{ t('backupSet.nextRun') }}:</span> <span class="strong" data-testid="next-run">{{ settings.nextRun ? serverStamp(settings.nextRun) : t('backupSet.noNext') }}</span></div>
          </div>

          <div class="field">
            <div class="label">
              <span class="strong">{{ t('backupSet.keep') }}</span>
              <n-tag v-if="isDefault('keep')" size="small" round :bordered="false">{{ t('backupSet.isDefault') }}</n-tag>
              <n-button v-else text size="tiny" type="primary" @click="reset('keep')">{{ t('backupSet.useDefault') }}</n-button>
            </div>
            <n-input-number v-model:value="draft.keep" :min="1" :max="30" :precision="0" style="width: 140px" />
            <div class="hint muted">{{ t('backupSet.keepHint', { n: draft.keep ?? settings.keep }) }}</div>
          </div>

          <div class="field">
            <div class="label">
              <span class="strong">{{ t('backupSet.includeFiles') }}</span>
              <n-tag v-if="isDefault('includeFiles')" size="small" round :bordered="false">{{ t('backupSet.isDefault') }}</n-tag>
              <n-button v-else text size="tiny" type="primary" @click="reset('includeFiles')">{{ t('backupSet.useDefault') }}</n-button>
            </div>
            <n-switch :value="!!settings.includeFiles" :loading="filesBusy" :aria-label="t('backupSet.includeFiles')" data-testid="include-files" @update:value="switchFiles" />
            <div class="hint muted">{{ t('backupSet.includeFilesHint') }}</div>
          </div>

          <div class="foot-actions">
            <n-button type="primary" :loading="savingSettings" data-testid="save-settings" @click="saveSettings">{{ t('common.save') }}</n-button>
          </div>
        </div>

        <div class="surface block">
          <h2>{{ t('backup.list') }}</h2>
          <n-empty v-if="!items.length" :description="t('backup.none')" class="empty" />
          <div v-for="b in items" :key="b.name" class="item">
            <div class="info">
              <div class="strong">{{ formatDate(b.createdAt) }}</div>
              <div class="muted small"><span class="mono name">{{ b.name }}</span> · {{ formatBytes(b.size) }}</div>
              <div v-if="b.parts" class="parts small muted" data-testid="parts">
                <span v-for="k in ['data', 'logs', 'storage']" v-show="b.parts[k]" :key="k" class="part">
                  <span class="strong">{{ t(`backupSet.parts.${k}`) }}</span>
                  {{ formatBytes(b.parts[k]?.size) }} → {{ formatBytes(b.parts[k]?.compressed) }}<template v-if="k === 'storage'"> ({{ t('backupSet.partFiles', { n: b.parts[k]?.files }) }})</template>
                </span>
              </div>
            </div>
            <div class="item-actions">
              <n-button
                tag="a" :href="api.backupUrl(b.name)" :download="b.name" size="small" secondary :loading="saving === b.name"
                @click="e => follow(e, api.backupUrl(b.name), { key: b.name, name: b.name, admin: true })"
              >
                <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
              </n-button>
              <n-button size="small" secondary :disabled="working || creating" @click="askRestore(b)">
                <template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('backup.restore') }}
              </n-button>
              <n-button size="small" quaternary type="error" :disabled="working || creating" :aria-label="t('common.delete')" @click="remove(b)">
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- turning on "include files": the size first, then the password -->
    <n-modal v-model:show="filesOpen" preset="card" :title="t('backupSet.filesOnTitle')" style="width: calc(100vw - 32px); max-width: 480px" :mask-closable="!filesBusy" :closable="!filesBusy">
      <n-alert type="warning" class="gap">{{ t('backupSet.filesOnWarn') }}</n-alert>
      <div v-if="estimate" class="est" data-testid="estimate">
        <div class="kv"><span class="muted">{{ t('backupSet.estimate') }}</span><span class="val strong">{{ formatBytes(estimate.estimate) }}</span></div>
        <div class="kv"><span class="muted">{{ t('backupSet.free') }}</span><span class="val strong">{{ estimate.free == null ? t('backupSet.unknownFree') : formatBytes(estimate.free) }}</span></div>
        <div class="kv"><span class="muted">{{ t('backupSet.needed') }}</span><span class="val strong">{{ formatBytes(estimate.needed) }}</span></div>
        <div class="kv"><span class="muted">&nbsp;</span><n-tag :type="estimate.ok ? 'success' : 'error'" round :bordered="false" data-testid="estimate-ok">{{ estimate.ok ? t('backupSet.enough') : t('backupSet.notEnough') }}</n-tag></div>
        <n-alert v-if="!estimate.ok" type="error" class="gap top">{{ t('backupSet.notEnoughWarn') }}</n-alert>
      </div>
      <div v-else class="est muted">{{ t('backupSet.estimating') }}</div>
      <n-form label-placement="top" @submit.prevent="turnFilesOn">
        <n-form-item :label="t('backup.password')">
          <n-input :placeholder="t('backup.password')" v-model:value="filesPassword" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="turnFilesOn" />
        </n-form-item>
      </n-form>
      <div class="actions">
        <n-button :disabled="filesBusy" @click="filesOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="!filesPassword" :loading="filesBusy" @click="turnFilesOn">{{ t('backupSet.turnOn') }}</n-button>
      </div>
    </n-modal>

    <n-modal v-model:show="restoreOpen" preset="card" :title="t('backup.restoreTitle', { date: target ? formatDate(target.createdAt) : '' })" style="width: calc(100vw - 32px); max-width: 480px" :mask-closable="!working" :closable="!working">
      <p class="intro">{{ t('backup.restoreIntro') }}</p>
      <ul class="replaced">
        <li>{{ t('backup.restoreUsers') }}</li>
        <li>{{ t('backup.restoreSettings') }}</li>
        <li>{{ t('backup.restoreLogo') }}</li>
      </ul>
      <n-alert type="success" class="gap">{{ t('backup.restoreNotFiles') }}</n-alert>
      <n-alert type="info" class="gap">{{ t('backup.restoreSafety') }}</n-alert>
      <n-alert type="warning" class="gap">{{ t('backup.restoreRestart') }}</n-alert>
      <n-form label-placement="top" @submit.prevent="restore">
        <n-form-item :label="t('backup.password')">
          <n-input :placeholder="t('backup.password')" v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="restore" />
        </n-form-item>
      </n-form>
      <div class="actions">
        <n-button :disabled="working" @click="restoreOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="error" :disabled="!password" :loading="working" @click="restore"><template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('backup.restoreGo') }}</n-button>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import ListSkeleton from '../components/ListSkeleton.vue'
import PageHeader from '../components/PageHeader.vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NIcon, NInput, NInputNumber, NModal, NRadio, NRadioButton, NRadioGroup, NSpin, NSwitch, NTag, NTimePicker } from 'naive-ui'
import { ArchiveOutline, ArrowUndoOutline, DownloadOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useDownload, useFeedback } from '../composables'
import { bootId, sleep, waitForRestart } from '../restart'
import { formatBytes, formatDate } from '../utils'

const { t, tm, rt } = useI18n()
const fb = useFeedback()
const { busy: saving, follow } = useDownload()
const data = ref(null)
const loading = ref(false)
const creating = ref(false)
const working = ref(false)
const restoring = ref(false)
const restoreOpen = ref(false)
const target = ref(null)
const password = ref('')

const items = computed(() => data.value?.items ?? [])
const status = computed(() => data.value?.status ?? null)
const settings = computed(() => data.value?.settings ?? {})
const noSpace = computed(() => status.value?.code === 'backup.no-space' || status.value?.code === 'backup.aborted-no-space')

// ── the form: what the page shows, until Save sends the changed keys ──
const draft = reactive({ compression: 'smallest', mode: 'off', time: '02:00', days: [], hours: 24, keep: 7 })
const savingSettings = ref(false)
const dayNames = computed(() => tm('backupSet.dayNames').map(n => rt(n)))

const isDefault = key => !(key in (settings.value.saved ?? {}))

function fillDraft(s) {
  draft.compression = s.compression
  draft.keep = s.keep
  const sch = s.schedule ?? { mode: 'off' }
  draft.mode = sch.mode
  draft.time = sch.time ?? '02:00'
  draft.days = [...(sch.days ?? [])].sort()
  draft.hours = sch.hours ?? 24
}

/** the schedule object the server takes, from the form */
function scheduleOf(d) {
  if (d.mode === 'daily') return { mode: 'daily', time: d.time }
  if (d.mode === 'weekly') return { mode: 'weekly', days: [...d.days].sort(), time: d.time }
  if (d.mode === 'interval') return { mode: 'interval', hours: d.hours }
  return { mode: 'off' }
}
const normal = sch => JSON.stringify(sch.mode === 'weekly' ? { ...sch, days: [...sch.days].sort() } : sch)

function toggleDay(i) {
  const at = draft.days.indexOf(i)
  if (at >= 0) draft.days.splice(at, 1)
  else draft.days.push(i)
  draft.days.sort()
}

function scheduleText(sch) {
  if (!sch || sch.mode === 'off') return t('backupSet.modeOff')
  if (sch.mode === 'daily') return t('backupSet.everyDay', { time: sch.time })
  if (sch.mode === 'weekly') return t('backupSet.everyWeek', { days: sch.days.map(d => dayNames.value[d]).join(' '), time: sch.time })
  return t('backupSet.everyHours', { n: sch.hours })
}

const offsetText = computed(() => {
  const m = settings.value.timezone?.offsetMinutes ?? 0
  const a = Math.abs(m)
  return `${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
})

/** a moment as the server's clock shows it (the server's time zone, not the browser's) */
function serverStamp(iso) {
  const d = new Date(new Date(iso).getTime() + (settings.value.timezone?.offsetMinutes ?? 0) * 60000)
  if (Number.isNaN(d.getTime())) return '-'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

async function saveSettings() {
  const s = settings.value
  const body = {}
  if (draft.compression !== s.compression) body.compression = draft.compression
  if (draft.keep !== s.keep) body.keep = draft.keep
  const sch = scheduleOf(draft)
  if (normal(sch) !== normal(s.schedule ?? { mode: 'off' })) body.schedule = sch
  if (!Object.keys(body).length) return fb.warn(t('backupSet.nothingToSave'))
  await send(body, t('backupSet.savedOk'))
}

/** null puts the key back to the default */
const reset = key => send({ [key]: null }, t('backupSet.savedOk'))

async function send(body, okText, extra = {}) {
  savingSettings.value = true
  try {
    const next = await api.backupSettings({ ...body, ...extra })
    data.value = { ...data.value, settings: next }
    fillDraft(next)
    fb.ok(okText)
    return true
  } catch (e) {
    fb.fail(e)
    return false
  } finally { savingSettings.value = false }
}

// ── including the uploaded files: the size and the password first ──
const filesOpen = ref(false)
const filesBusy = ref(false)
const filesPassword = ref('')
const estimate = ref(null)

async function switchFiles(on) {
  if (!on) {
    filesBusy.value = true
    const ok = await send({ includeFiles: false }, t('backupSet.turnedOff'))
    filesBusy.value = false
    return ok
  }
  filesPassword.value = ''
  estimate.value = null
  filesOpen.value = true
  try { estimate.value = await api.backupEstimate() } catch (e) { fb.fail(e) }
}

async function turnFilesOn() {
  if (!filesPassword.value || filesBusy.value) return
  filesBusy.value = true
  const ok = await send({ includeFiles: true }, t('backupSet.turnedOn'), { password: filesPassword.value })
  filesBusy.value = false
  if (ok) { filesOpen.value = false; filesPassword.value = '' }
}

async function load() {
  loading.value = true
  try {
    data.value = await api.backups()
    fillDraft(data.value.settings)
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function backupNow() {
  creating.value = true
  try {
    const item = await api.backupNow()
    fb.ok(t('backup.created', { size: formatBytes(item.size) }))
  } catch (e) { fb.fail(e) } finally {
    creating.value = false
    // a failed attempt is recorded in the status too
    await refreshStatus()
  }
}

/** the list and the status again, without throwing away what is typed in the form */
async function refreshStatus() {
  try { data.value = await api.backups() } catch (e) { fb.fail(e) }
}

async function remove(b) {
  const yes = await fb.confirm({ title: t('backup.deleteTitle'), content: t('backup.deleteBody', { name: b.name }), positive: t('common.delete'), danger: true })
  if (!yes) return
  try {
    await api.backupDelete(b.name)
    fb.ok(t('backup.deleted'))
  } catch (e) { fb.fail(e) }
  await refreshStatus()
}

function askRestore(b) {
  target.value = b
  password.value = ''
  restoreOpen.value = true
}

async function restore() {
  if (!password.value || working.value) return
  working.value = true
  try {
    const before = await bootId()
    await api.backupRestore(target.value.name, password.value)
    password.value = ''
    restoreOpen.value = false
    working.value = false
    restoring.value = true
    const h = await waitForRestart(before)
    if (h) {
      fb.ok(t('backup.done'))
      await sleep(800)
      location.reload()
    } else {
      restoring.value = false
      fb.warn(t('backup.timeout'))
      await load()
    }
  } catch (e) { fb.fail(e) } finally { working.value = false }
}

onMounted(load)
</script>

<style scoped>
.narrow { max-width: 760px; }
.head-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.gap { margin-bottom: 12px; }
.gap.top { margin-top: 4px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
.kv > .muted { flex-shrink: 0; }
.val { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; text-align: right; min-width: 0; }
.path { text-align: right; overflow-wrap: anywhere; min-width: 0; }
.strong { font-weight: 600; }
.small { font-size: 12.5px; }
.center { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 22px; }
.center h2 { margin-top: 18px; }
.empty { padding: 18px 0; }
.item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }
.item:first-of-type { border-top: 0; }
.info { min-width: 0; }
.name { overflow-wrap: anywhere; }
.parts { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 2px; }
.part { overflow-wrap: anywhere; }
.item-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.intro { margin: 0 0 6px; }
.replaced { margin: 0 0 14px; padding-left: 20px; line-height: 1.7; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.field { padding: 14px 0; border-top: 1px solid var(--border); }
.field:first-of-type { border-top: 0; padding-top: 0; }
.label { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.hint { font-size: 12.5px; margin-top: 8px; line-height: 1.55; overflow-wrap: anywhere; }
.modes { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.days { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.foot-actions { display: flex; justify-content: flex-end; padding-top: 14px; border-top: 1px solid var(--border); }
.est { margin-bottom: 8px; }
.todo-title { margin-top: 8px; font-weight: 600; }
.todo { margin: 4px 0 0; padding-left: 20px; line-height: 1.6; }
@media (max-width: 600px) {
  .block { padding: 16px; }
  .kv { flex-wrap: wrap; gap: 4px 16px; }
  .path, .val { text-align: left; justify-content: flex-start; }
  .item { flex-wrap: wrap; }
  .item-actions { width: 100%; }
}
</style>
