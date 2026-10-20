<template>
  <n-spin :show="loading && !prefs">
    <div v-if="prefs" class="np">
      <!-- e-mail: only when the server can send mail -->
      <section v-if="prefs.email.enabled" class="block">
        <h3>{{ t('notify.email') }}</h3>
        <template v-if="prefs.email.address && !changing">
          <div class="addr">
            <span class="mono addr-text">{{ prefs.email.address }}</span>
            <n-tag :type="prefs.email.verified ? 'success' : 'warning'" size="small" round :bordered="false">{{ prefs.email.verified ? t('notify.verified') : t('notify.notVerified') }}</n-tag>
          </div>
          <div class="actions">
            <n-button v-if="!prefs.email.verified" secondary size="small" :loading="busy === 'email'" :disabled="cooldown > 0" @click="sendEmail(prefs.email.address)">
              {{ cooldown > 0 ? t('notify.waitSeconds', { seconds: cooldown }) : t('notify.emailResend') }}
            </n-button>
            <n-button secondary size="small" @click="startChange">{{ t('notify.emailChange') }}</n-button>
            <n-button quaternary size="small" type="error" :loading="busy === 'rm'" @click="removeEmail">{{ t('notify.emailRemove') }}</n-button>
          </div>
        </template>
        <template v-else>
          <p class="small muted">{{ t('notify.emailHelp') }}</p>
          <n-input v-model:value="address" type="text" placeholder="name@example.com" :input-props="{ type: 'email', autocomplete: 'email', inputmode: 'email', 'aria-label': t('notify.email') }" @keyup.enter="sendEmail(address)" />
          <div class="actions">
            <n-button v-if="changing" size="small" @click="changing = false">{{ t('common.cancel') }}</n-button>
            <n-button type="primary" size="small" :loading="busy === 'email'" :disabled="!address.trim() || cooldown > 0" @click="sendEmail(address)">
              {{ cooldown > 0 ? t('notify.waitSeconds', { seconds: cooldown }) : t('notify.emailSend') }}
            </n-button>
          </div>
        </template>
      </section>

      <!-- LINE: only when the server has the bot set up -->
      <section v-if="prefs.line.enabled" class="block">
        <h3>{{ t('notify.line') }}</h3>
        <template v-if="prefs.line.linked">
          <div class="addr"><n-tag type="success" size="small" round :bordered="false">{{ t('notify.lineLinked') }}</n-tag></div>
          <div class="actions"><n-button quaternary size="small" type="error" :loading="busy === 'unlink'" @click="unlink">{{ t('notify.lineUnlink') }}</n-button></div>
        </template>
        <template v-else-if="link">
          <p class="small">{{ t('notify.lineSteps') }}</p>
          <div class="code mono" data-testid="line-code" :aria-label="t('notify.lineCode')">{{ link.code }}</div>
          <div class="small center" :class="{ muted: left > 0 }">{{ left > 0 ? t('notify.lineExpires', { time: clock }) : t('notify.lineExpired') }}</div>
          <div v-if="left > 0" class="small muted center">{{ t('notify.lineWaiting') }}</div>
          <div class="actions">
            <n-button size="small" @click="stopLink">{{ t('notify.lineCancel') }}</n-button>
            <n-button v-if="left <= 0" type="primary" size="small" :loading="busy === 'link'" @click="startLink">{{ t('notify.lineNew') }}</n-button>
          </div>
        </template>
        <template v-else>
          <p class="small muted">{{ t('notify.lineHelp') }}</p>
          <n-button type="primary" size="small" :loading="busy === 'link'" @click="startLink">{{ t('notify.lineLink') }}</n-button>
        </template>
      </section>

      <!-- which events go where -->
      <section class="block">
        <h3>{{ t('notify.events') }}</h3>
        <div class="grid" :style="{ '--cols': channels.length }">
          <div class="cell head muted">{{ t('notify.event') }}</div>
          <div v-for="c in channels" :key="c" class="cell head muted ch">{{ channelLabel(c) }}</div>
          <template v-for="k in kinds" :key="k">
            <div class="cell kind">{{ t(`notify.kinds.${k}`) }}</div>
            <div v-for="c in channels" :key="c" class="cell ch">
              <n-switch size="small" :value="!!prefs.events[k][c]" :disabled="saving === `${k}.${c}`" :aria-label="`${t(`notify.kinds.${k}`)}: ${channelLabel(c)}`" :data-testid="`ev-${k}-${c}`" @update:value="v => toggle(k, c, v)" />
            </div>
          </template>
        </div>
      </section>
    </div>
  </n-spin>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NSwitch, NTag } from 'naive-ui'
import { api } from '../api'
import { useFeedback } from '../composables'

const { t } = useI18n()
const fb = useFeedback()
const prefs = ref(null)
const loading = ref(false)
const busy = ref('')
const saving = ref('')
const address = ref('')
const changing = ref(false)
const cooldown = ref(0)
const link = ref(null)
const now = ref(Date.now())
let ticker = null
let poller = null

const kinds = computed(() => Object.keys(prefs.value?.events ?? {}))
const channels = computed(() => ['web', ...(prefs.value?.email.enabled ? ['email'] : []), ...(prefs.value?.line.enabled ? ['line'] : [])])
const channelLabel = c => (c === 'web' ? t('notify.web') : c === 'email' ? t('notify.email') : t('notify.line'))

const left = computed(() => (link.value ? Math.max(0, Math.round((link.value.until - now.value) / 1000)) : 0))
const clock = computed(() => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, '0')}`)

async function load() {
  loading.value = true
  try { prefs.value = await api.notifyPrefs() } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function toggle(kind, channel, value) {
  const key = `${kind}.${channel}`
  const before = prefs.value.events[kind][channel]
  prefs.value.events[kind][channel] = value
  saving.value = key
  try {
    prefs.value = await api.saveNotifyPrefs({ events: { [kind]: { [channel]: value } } })
    fb.ok(t('notify.saved'))
  } catch (e) {
    prefs.value.events[kind][channel] = before
    fb.fail(e)
  } finally { saving.value = '' }
}

function countdown(seconds) {
  cooldown.value = seconds
  const tick = setInterval(() => { cooldown.value = Math.max(0, cooldown.value - 1); if (!cooldown.value) clearInterval(tick) }, 1000)
}

async function sendEmail(addr) {
  const a = (addr || '').trim()
  if (!a || busy.value) return
  busy.value = 'email'
  try {
    await api.setEmail(a)
    fb.ok(t('notify.emailSent', { address: a }))
    changing.value = false
    address.value = ''
    countdown(60)
    await load()
  } catch (e) {
    if (e.code === 'notify.verify-too-soon') countdown(Number(e.params?.seconds) || 60)
    fb.fail(e)
  } finally { busy.value = '' }
}

function startChange() { address.value = ''; changing.value = true }

async function removeEmail() {
  busy.value = 'rm'
  try { await api.removeEmail(); fb.ok(t('notify.emailRemoved')); await load() } catch (e) { fb.fail(e) } finally { busy.value = '' }
}

function stopLink() {
  link.value = null
  clearInterval(ticker); clearInterval(poller)
  ticker = poller = null
}

async function startLink() {
  busy.value = 'link'
  try {
    const r = await api.lineLink()
    stopLink()
    now.value = Date.now()
    link.value = { code: r.code, until: Date.now() + (Number(r.ttlSeconds) || 300) * 1000 }
    ticker = setInterval(() => { now.value = Date.now(); if (left.value <= 0) { clearInterval(poller); poller = null } }, 1000)
    // the user sends the code in the LINE app: watch for the link every 3 seconds until it is made or the code expires
    poller = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const p = await api.notifyPrefs()
        if (p.line.linked) { prefs.value = p; stopLink(); fb.ok(t('notify.lineDone')) }
      } catch { /* try again in 3 seconds */ }
    }, 3000)
  } catch (e) { fb.fail(e) } finally { busy.value = '' }
}

async function unlink() {
  busy.value = 'unlink'
  try { await api.lineUnlink(); fb.ok(t('notify.lineUnlinked')); await load() } catch (e) { fb.fail(e) } finally { busy.value = '' }
}

onMounted(load)
onBeforeUnmount(stopLink)
</script>

<style scoped>
.np { display: flex; flex-direction: column; gap: 18px; }
.block h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.small { font-size: 13px; margin: 0 0 8px; }
.center { text-align: center; }
.addr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.addr-text { overflow-wrap: anywhere; min-width: 0; }
.actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.code { font-size: 38px; font-weight: 700; letter-spacing: 0.18em; text-align: center; padding: 14px 8px; margin: 6px 0; border: 1px dashed var(--border); border-radius: var(--radius); background: var(--surface-2); user-select: all; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) repeat(var(--cols), minmax(52px, auto)); align-items: center; }
.cell { display: flex; align-items: center; min-height: 44px; padding: 4px 4px; border-top: 1px solid var(--border); font-size: 14px; overflow-wrap: anywhere; }
.cell.head { border-top: 0; font-size: 12.5px; min-height: 28px; }
.cell.ch { justify-content: center; }
.cell.kind { padding-right: 10px; }
</style>
