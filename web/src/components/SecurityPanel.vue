<template>
  <div class="sec">
    <!-- storage use: only for an account with a quota -->
    <section v-if="usage && usage.quota > 0" class="block">
      <h3>{{ t('security.storage') }}</h3>
      <n-progress type="line" :percentage="pct" :status="pct >= 100 ? 'error' : pct >= 90 ? 'warning' : 'default'" :show-indicator="false" :height="10" />
      <div class="muted small">{{ t('security.usedOf', { used: formatBytes(usage.used), quota: formatBytes(usage.quota) }) }} ({{ pct }}%)</div>
    </section>

    <!-- two-factor sign-in -->
    <section class="block">
      <h3>{{ t('security.twoFactor') }}</h3>

      <template v-if="mode === 'codes'">
        <n-alert type="warning" :show-icon="true" class="gap">{{ t('security.codesWarning') }}</n-alert>
        <ul class="codes mono"><li v-for="c in codes" :key="c">{{ c }}</li></ul>
        <div class="actions">
          <n-button secondary @click="copyCodes">{{ t('security.copy') }}</n-button>
          <n-button secondary @click="downloadCodes">{{ t('security.downloadTxt') }}</n-button>
          <n-button type="primary" @click="finishCodes">{{ t('security.savedCodes') }}</n-button>
        </div>
      </template>

      <template v-else-if="mode === 'scan'">
        <p class="small">{{ t('security.scanHelp') }}</p>
        <div class="qr"><img v-if="qr" :src="qr" width="200" height="200" :alt="t('security.qrAlt')"><n-spin v-else size="small" /></div>
        <div class="small muted">{{ t('security.typeSecret') }}</div>
        <div class="secret mono" data-testid="secret">{{ groupSecret(setup.secret) }}</div>
        <n-form-item :label="t('security.sixDigits')" :show-feedback="false" class="gap">
          <n-input :placeholder="t('security.codeOrBackup')" v-model:value="code" inputmode="numeric" maxlength="6" placeholder="123456" :input-props="codeProps" @keyup.enter="enable" />
        </n-form-item>
        <div class="actions">
          <n-button @click="cancel">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="busy" :disabled="code.length !== 6" @click="enable">{{ t('security.confirmOn') }}</n-button>
        </div>
      </template>

      <template v-else-if="!app.user?.twoFactor">
        <p class="small muted">{{ t('security.offHelp') }}</p>
        <template v-if="mode === 'ask'">
          <n-form-item :label="t('security.yourPassword')" :show-feedback="false" class="gap">
            <n-input :placeholder="t('security.yourPassword')" v-model:value="password" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" @keyup.enter="start" />
          </n-form-item>
          <div class="actions">
            <n-button @click="cancel">{{ t('common.cancel') }}</n-button>
            <n-button type="primary" :loading="busy" :disabled="!password" @click="start">{{ t('security.continue') }}</n-button>
          </div>
        </template>
        <n-button v-else type="primary" @click="mode = 'ask'">{{ t('security.turnOn') }}</n-button>
      </template>

      <template v-else>
        <div class="status"><n-tag type="success" round size="small" :bordered="false">{{ t('security.isOn') }}</n-tag><span v-if="app.user?.twoFactorSince" class="muted small since">{{ t('security.since', { date: formatDate(app.user.twoFactorSince) }) }}</span></div>
        <template v-if="mode === 'newcodes' || mode === 'off'">
          <p class="small muted">{{ mode === 'off' ? t('security.offConfirm') : t('security.newCodesConfirm') }}</p>
          <n-form-item :label="t('security.yourPassword')" :show-feedback="false" class="gap">
            <n-input :placeholder="t('security.yourPassword')" v-model:value="password" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" />
          </n-form-item>
          <n-form-item :label="t('security.codeOrBackup')" :show-feedback="false" class="gap">
            <n-input :placeholder="t('security.codeOrBackup')" v-model:value="code" maxlength="20" :input-props="{ autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: false }" @keyup.enter="manage" />
          </n-form-item>
          <div class="actions">
            <n-button @click="cancel">{{ t('common.cancel') }}</n-button>
            <n-button :type="mode === 'off' ? 'error' : 'primary'" :loading="busy" :disabled="!password || !code" @click="manage">
              {{ mode === 'off' ? t('security.turnOff') : t('security.makeNewCodes') }}
            </n-button>
          </div>
        </template>
        <div v-else class="actions">
          <n-button secondary @click="mode = 'newcodes'">{{ t('security.newCodes') }}</n-button>
          <n-button secondary type="error" @click="mode = 'off'">{{ t('security.turnOff') }}</n-button>
        </div>
      </template>
    </section>

    <!-- signed-in devices -->
    <section class="block">
      <div class="head">
        <h3>{{ t('devices.title') }}</h3>
        <n-button v-if="others > 0" size="small" secondary type="warning" :loading="busyId === '*'" @click="revokeOthers">{{ t('devices.signOutOthers') }}</n-button>
      </div>
      <n-spin v-if="loadingSessions && !sessions.length" size="small" />
      <device-list v-else :sessions="sessions" removable :busy-id="busyId" @revoke="revoke" />
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NFormItem, NInput, NProgress, NSpin, NTag } from 'naive-ui'
import { groupSecret } from '../account-utils'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDate } from '../utils'
import DeviceList from './DeviceList.vue'

// `lock` is true while the backup codes are on screen: the dialog must not close by a stray click; `signedout`
// when this very device was signed out
const emit = defineEmits(['lock', 'signedout'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()

const mode = ref('') // '' | ask | scan | newcodes | off | codes
const password = ref('')
const code = ref('')
const busy = ref(false)
const setup = ref({ secret: '', uri: '' })
const qr = ref('')
const codes = ref([])
const codeProps = { autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]*' }

const usage = ref(null)
const sessions = ref([])
const loadingSessions = ref(false)
const busyId = ref('')
const others = computed(() => sessions.value.filter(s => !s.current).length)
const pct = computed(() => (usage.value?.quota ? Math.min(100, Math.round((usage.value.used / usage.value.quota) * 100)) : 0))

async function loadSessions() {
  loadingSessions.value = true
  try { sessions.value = (await api.sessions()).sessions } catch (e) { fb.fail(e) } finally { loadingSessions.value = false }
}
onMounted(async () => {
  loadSessions()
  try { usage.value = await api.usage() } catch { /* the bar is a nicety */ }
})

function reset() { mode.value = ''; password.value = ''; code.value = ''; setup.value = { secret: '', uri: '' }; qr.value = '' }
const cancel = () => reset()

async function start() {
  if (!password.value || busy.value) return
  busy.value = true
  try {
    setup.value = await api.twoFactorSetup(password.value)
    password.value = ''
    code.value = ''
    mode.value = 'scan'
    // the QR is drawn here in the browser, loaded only now; the secret never goes to any outside service
    const QR = await import('qrcode')
    qr.value = await QR.toDataURL(setup.value.uri, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
  } catch (e) { fb.fail(e); password.value = '' } finally { busy.value = false }
}

function showCodes(list) {
  codes.value = list
  mode.value = 'codes'
  password.value = ''
  code.value = ''
  setup.value = { secret: '', uri: '' }
  qr.value = ''
  emit('lock', true)
}

async function enable() {
  if (code.value.length !== 6 || busy.value) return
  busy.value = true
  try {
    const r = await api.twoFactorEnable(code.value)
    showCodes(r.backupCodes)
    await app.refresh()
    loadSessions()
  } catch (e) { fb.fail(e); code.value = '' } finally { busy.value = false }
}

async function manage() {
  if (!password.value || !code.value || busy.value) return
  busy.value = true
  try {
    if (mode.value === 'off') {
      await api.twoFactorDisable(password.value, code.value.trim())
      reset()
      await app.refresh()
      fb.ok(t('security.turnedOff'))
    } else {
      showCodes((await api.twoFactorBackupCodes(password.value, code.value.trim())).backupCodes)
    }
  } catch (e) { fb.fail(e); code.value = '' } finally { busy.value = false }
}

const codesText = () => `${app.appName} - ${app.user?.username}\n${t('security.backupTitle')}\n\n${codes.value.join('\n')}\n`

async function copyCodes() {
  try {
    await navigator.clipboard.writeText(codes.value.join('\n'))
    fb.ok(t('security.copied'))
  } catch {
    // no clipboard permission (plain http): select-and-copy by hand through a temporary field
    const ta = document.createElement('textarea')
    ta.value = codes.value.join('\n')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand?.('copy')
    ta.remove()
    if (ok) fb.ok(t('security.copied')); else fb.fail(null, t('security.copyFailed'))
  }
}

function downloadCodes() {
  const url = URL.createObjectURL(new Blob([codesText()], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'backup-codes.txt'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function finishCodes() {
  if (!(await fb.confirm({ title: t('security.savedCodes'), content: t('security.savedConfirm'), positive: t('security.savedYes') }))) return
  codes.value = []
  mode.value = ''
  emit('lock', false)
}

async function revoke(s) {
  if (s.current) {
    if (!(await fb.confirm({ title: t('nav.logout'), content: t('devices.signOutHereConfirm'), positive: t('nav.logout') }))) return
  }
  busyId.value = s.id
  try {
    const r = await api.revokeSession(s.id)
    if (s.current) { app.apply(r); emit('signedout'); return }
    fb.ok(t('devices.signedOut'))
    await loadSessions()
  } catch (e) { fb.fail(e) } finally { busyId.value = '' }
}

async function revokeOthers() {
  if (!(await fb.confirm({ title: t('devices.signOutOthers'), content: t('devices.signOutOthersConfirm'), positive: t('devices.signOutOthers'), danger: true }))) return
  busyId.value = '*'
  try {
    await api.revokeOthers()
    fb.ok(t('devices.signedOut'))
    await loadSessions()
  } catch (e) { fb.fail(e) } finally { busyId.value = '' }
}
</script>

<style scoped>
.sec { display: flex; flex-direction: column; gap: 18px; }
.block { border-top: 1px solid var(--border); padding-top: 14px; min-width: 0; }
.block:first-child { border-top: 0; padding-top: 0; }
h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.head h3 { margin: 0; }
.small { font-size: 13px; margin: 0 0 8px; }
.gap { margin-bottom: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.status { margin-bottom: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
.since { margin: 0; }
.qr { display: flex; justify-content: center; margin: 8px 0; min-height: 200px; align-items: center; }
.qr img { background: #fff; padding: 6px; border-radius: 8px; border: 1px solid var(--border); max-width: 100%; height: auto; }
.secret { padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; margin: 4px 0 12px; font-size: 14px; letter-spacing: 1px; overflow-wrap: anywhere; user-select: all; }
.codes { list-style: none; margin: 0 0 12px; padding: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }
.codes li { overflow-wrap: anywhere; }
</style>
