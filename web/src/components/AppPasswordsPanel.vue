<template>
  <n-spin :show="loading && !data">
    <div class="ap">
      <p class="muted intro">{{ t('dav.intro') }}</p>

      <!-- where to connect -->
      <div class="kv">
        <span class="k muted">{{ t('dav.url') }}</span>
        <span class="v mono" data-testid="dav-url">{{ url }}</span>
        <n-button size="tiny" secondary @click="copy(url)"><template #icon><n-icon :component="CopyOutline" /></template>{{ t('dav.copy') }}</n-button>
      </div>
      <div class="kv">
        <span class="k muted">{{ t('dav.username') }}</span>
        <span class="v mono" data-testid="dav-user">{{ app.user?.username }}</span>
        <n-button size="tiny" secondary @click="copy(app.user?.username || '')"><template #icon><n-icon :component="CopyOutline" /></template>{{ t('dav.copy') }}</n-button>
      </div>

      <!-- make one -->
      <h3>{{ t('dav.createTitle') }}</h3>
      <n-form label-placement="top" :show-feedback="false" class="form" @submit.prevent="create">
        <input type="text" name="username" autocomplete="username" :value="app.user?.username || ''" readonly hidden>
        <n-form-item :label="t('dav.name')">
          <n-input v-model:value="form.name" :maxlength="60" :placeholder="t('dav.namePlaceholder')" :input-props="{ autocomplete: 'off' }" />
        </n-form-item>
        <n-form-item :label="t('dav.scope')">
          <n-radio-group v-model:value="form.scope" name="dav-scope">
            <n-radio-button value="read">{{ t('dav.scopeRead') }}</n-radio-button>
            <n-radio-button value="readwrite">{{ t('dav.scopeReadwrite') }}</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item :label="t('dav.currentPassword')">
          <n-input v-model:value="form.password" type="password" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" @keyup.enter="create" />
        </n-form-item>
        <div class="go">
          <n-button type="primary" :loading="busy" :disabled="!valid || full" @click="create">{{ t('dav.create') }}</n-button>
        </div>
      </n-form>
      <p class="small muted">{{ t('dav.passwordNote') }}</p>

      <!-- the ones made -->
      <h3>{{ t('dav.listTitle', { n: items.length, max: data?.max ?? 20 }) }}</h3>
      <div v-if="!items.length" class="muted small">{{ t('dav.none') }}</div>
      <div v-for="p in items" :key="p.id" class="item" data-testid="dav-item">
        <div class="item-main">
          <div class="item-head">
            <span class="item-name">{{ p.name }}</span>
            <n-tag size="small" round :bordered="false" :type="p.scope === 'readwrite' ? 'warning' : 'info'">{{ p.scope === 'readwrite' ? t('dav.scopeReadwrite') : t('dav.scopeRead') }}</n-tag>
          </div>
          <div class="small muted"><span>{{ t('dav.hint') }}</span> <span class="mono">{{ p.hint }}…</span></div>
          <div class="small muted">{{ t('dav.createdAt', { date: formatDate(p.createdAt) }) }}</div>
          <div class="small muted">
            <template v-if="p.lastUsedAt">{{ t('dav.lastUsed', { date: formatDate(p.lastUsedAt) }) }}<template v-if="p.lastIp"> · {{ t('dav.lastIp', { ip: p.lastIp }) }}</template></template>
            <template v-else>{{ t('dav.neverUsed') }}</template>
          </div>
        </div>
        <n-button size="small" quaternary type="error" :loading="removing === p.id" @click="revoke(p)">
          <template #icon><n-icon :component="TrashOutline" /></template>{{ t('dav.revoke') }}
        </n-button>
      </div>

      <!-- how to connect -->
      <h3>{{ t('dav.howto') }}</h3>
      <n-collapse>
        <n-collapse-item :title="t('dav.win')" name="win">
          <ol class="steps"><li>{{ t('dav.win1') }}</li><li>{{ t('dav.win2') }}</li><li>{{ t('dav.win3') }}</li></ol>
        </n-collapse-item>
        <n-collapse-item :title="t('dav.mac')" name="mac">
          <ol class="steps"><li>{{ t('dav.mac1') }}</li></ol>
        </n-collapse-item>
        <n-collapse-item :title="t('dav.mobile')" name="mobile">
          <ol class="steps"><li>{{ t('dav.mobile1') }}</li><li>{{ t('dav.mobile2') }}</li></ol>
        </n-collapse-item>
        <n-collapse-item title="rclone" name="rclone">
          <p class="small">{{ t('dav.rcloneIntro') }}</p>
          <pre class="code mono">{{ rcloneConf }}</pre>
        </n-collapse-item>
      </n-collapse>
      <n-alert type="warning" :show-icon="true" class="cf">{{ t('dav.cloudflare') }}</n-alert>
    </div>

    <!-- the secret: shown once, and nothing closes this by accident -->
    <n-modal :show="!!secret" preset="card" :title="t('dav.secretTitle')" style="width: min(460px, 94vw)" :mask-closable="false" :closable="false" :close-on-esc="false" :z-index="3000">
      <n-alert type="error" :show-icon="true" class="warn">{{ t('dav.secretWarn') }}</n-alert>
      <div class="secret mono" data-testid="dav-secret">{{ secret?.secret }}</div>
      <div class="small muted">{{ t('dav.secretUse', { user: app.user?.username || '' }) }}</div>
      <template #footer>
        <div class="foot">
          <n-button secondary @click="copy(secret.secret)"><template #icon><n-icon :component="CopyOutline" /></template>{{ t('dav.copy') }}</n-button>
          <n-button type="primary" @click="closeSecret">{{ t('dav.secretSaved') }}</n-button>
        </div>
      </template>
    </n-modal>
  </n-spin>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NIcon, NInput, NModal, NRadioButton, NRadioGroup, NSpin, NTag } from 'naive-ui'
import { CopyOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { copyText, formatDate } from '../utils'

// the profile dialog must not close while the secret is on screen
const emit = defineEmits(['lock'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const data = ref(null)
const loading = ref(false)
const busy = ref(false)
const removing = ref('')
const secret = ref(null)
const form = reactive({ name: '', scope: 'read', password: '' })

const url = `${location.origin}/dav/`
const items = computed(() => data.value?.items ?? [])
const full = computed(() => !!data.value && items.value.length >= data.value.max)
const valid = computed(() => form.name.trim().length > 0 && form.password.length > 0)
const rcloneConf = computed(() => `[filecenter]\ntype = webdav\nurl = ${url}\nvendor = other\nuser = ${app.user?.username || ''}\npass = <rclone obscure>`)

async function load() {
  loading.value = true
  try { data.value = await api.appPasswords() } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function copy(text) {
  if (await copyText(text)) fb.ok(t('dav.copied'))
  else window.prompt(t('dav.copyByHand'), text)
}

async function create() {
  if (!valid.value || busy.value || full.value) return
  busy.value = true
  try {
    const r = await api.createAppPassword(form.name.trim(), form.scope, form.password)
    secret.value = r
    emit('lock', true)
    form.name = ''
    form.password = ''
    await load()
  } catch (e) {
    fb.fail(e)
    form.password = ''
  } finally { busy.value = false }
}

function closeSecret() {
  secret.value = null
  emit('lock', false)
}

async function revoke(p) {
  if (!(await fb.confirm({ title: t('dav.revokeTitle', { name: p.name }), content: t('dav.revokeBody'), positive: t('dav.revoke'), danger: true }))) return
  removing.value = p.id
  try { await api.deleteAppPassword(p.id); fb.ok(t('dav.revoked')) } catch (e) { fb.fail(e) } finally { removing.value = '' }
  await load()
}

onMounted(load)
</script>

<style scoped>
.ap h3 { margin: 18px 0 8px; font-size: 14.5px; }
.intro { margin: 0 0 12px; font-size: 13.5px; }
.small { font-size: 12.5px; overflow-wrap: anywhere; }
.kv { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin-bottom: 8px; }
.kv .k { flex: 0 0 100%; font-size: 12.5px; }
.kv .v { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; padding: 6px 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); }
.form { display: flex; flex-direction: column; gap: 12px; }
.go { display: flex; justify-content: flex-end; }
.item { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.item-main { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.item-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.item-name { font-weight: 600; overflow-wrap: anywhere; }
.steps { margin: 0; padding-left: 20px; font-size: 13.5px; display: flex; flex-direction: column; gap: 6px; overflow-wrap: anywhere; }
.code { margin: 6px 0 0; padding: 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; }
.cf { margin-top: 12px; }
.warn { margin-bottom: 12px; }
.secret { margin: 0 0 10px; padding: 12px; border-radius: 8px; background: var(--primary-soft); font-size: 16px; font-weight: 600; text-align: center; overflow-wrap: anywhere; user-select: all; }
.foot { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
</style>
