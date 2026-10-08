<template>
  <div class="page narrow">
    <div class="page-header"><div><h1>{{ t('nav.settings') }}</h1><p>{{ t('settings.subtitle') }}</p></div></div>
    <n-spin :show="loading">
      <div class="surface block">
        <h2>{{ t('settings.brand') }}</h2>
        <n-form label-placement="top">
          <n-form-item :label="t('settings.appName')"><n-input v-model:value="f.appName" maxlength="60" /></n-form-item>
          <n-form-item :label="t('settings.color')">
            <div class="colors">
              <button v-for="c in presets" :key="c" type="button" class="swatch" :class="{ on: f.primaryColor.toLowerCase() === c }" :style="{ background: c }" :aria-label="c" @click="f.primaryColor = c" />
              <n-color-picker v-model:value="f.primaryColor" :modes="['hex']" :show-alpha="false" style="width: 110px" />
            </div>
          </n-form-item>
          <n-form-item :label="t('settings.logo')">
            <div class="logo-row">
              <img v-if="app.config.logo" :src="`/api/branding/logo?v=${encodeURIComponent(app.config.logo)}`" class="logo-prev" alt="">
              <n-upload :show-file-list="false" accept="image/png,image/jpeg,image/webp,image/svg+xml" :custom-request="() => {}" :on-before-upload="onLogo">
                <n-button secondary><template #icon><n-icon :component="ImageOutline" /></template>{{ t('settings.uploadLogo') }}</n-button>
              </n-upload>
              <n-button v-if="app.config.logo" quaternary type="error" @click="removeLogo">{{ t('common.remove') }}</n-button>
            </div>
            <div class="muted hint">{{ t('settings.logoHint') }}</div>
          </n-form-item>
        </n-form>
      </div>

      <div class="surface block">
        <h2>{{ t('settings.publicPage') }}</h2>
        <n-form label-placement="top">
          <n-form-item :label="t('settings.publicEnabled')"><n-switch v-model:value="f.publicEnabled" /></n-form-item>
          <n-form-item :label="t('settings.welcomeTitle')"><n-input v-model:value="f.welcomeTitle" maxlength="120" /></n-form-item>
          <n-form-item :label="t('settings.welcomeText')"><n-input v-model:value="f.welcomeText" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" maxlength="600" /></n-form-item>
          <n-form-item :label="t('settings.emptyText')"><n-input v-model:value="f.publicEmptyText" maxlength="300" /></n-form-item>
          <n-form-item :label="t('settings.guestPerms')">
            <n-checkbox-group v-model:value="f.guestPermissions">
              <div class="perms"><n-checkbox v-for="k in PERMS" :key="k" :value="k" :label="t(`perm.${k}`)" /></div>
            </n-checkbox-group>
          </n-form-item>
          <n-alert v-if="f.guestPermissions.some(p => ['write', 'upload', 'zip'].includes(p))" type="warning">{{ t('settings.guestWarn') }}</n-alert>
        </n-form>
      </div>

      <div class="actions"><n-button type="primary" size="large" :loading="saving" @click="save"><template #icon><n-icon :component="SaveOutline" /></template>{{ t('common.save') }}</n-button></div>
    </n-spin>

    <div class="surface block info">
      <h2>{{ t('settings.about') }}</h2>
      <div class="kv"><span class="muted">{{ t('dash.system') }}</span><span>v{{ app.config.version }}</span></div>
      <div class="kv"><span class="muted">{{ t('settings.uploadLimit') }}</span><span>{{ formatBytes(app.config.uploadMaxSize) }}</span></div>
      <div class="kv"><span class="muted">{{ t('settings.chunk') }}</span><span>{{ formatBytes(app.config.uploadChunkSize) }} × {{ app.config.uploadSimultaneous }}</span></div>
      <div class="kv"><span class="muted">{{ t('settings.retention') }}</span><span>{{ t('trash.days', { n: app.config.trashRetentionDays }) }}</span></div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NColorPicker, NForm, NFormItem, NIcon, NInput, NSpin, NSwitch, NUpload } from 'naive-ui'
import { ImageOutline, SaveOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes } from '../utils'

const PERMS = ['read', 'download', 'batchdownload', 'upload', 'write', 'zip']
const presets = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0d9488', '#475569']
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const loading = ref(false)
const saving = ref(false)
const f = reactive({ appName: '', primaryColor: '#2563eb', welcomeTitle: '', welcomeText: '', publicEmptyText: '', publicEnabled: true, guestPermissions: [] })

async function load() {
  loading.value = true
  try {
    const s = await api.settings()
    Object.assign(f, { appName: s.appName, primaryColor: s.primaryColor, welcomeTitle: s.welcomeTitle, welcomeText: s.welcomeText, publicEmptyText: s.publicEmptyText, publicEnabled: s.publicEnabled, guestPermissions: [...s.guestPermissions] })
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function save() {
  saving.value = true
  try {
    await api.saveSettings({ ...f })
    await app.refresh()
    fb.ok(t('common.saved'))
  } catch (e) { fb.fail(e) } finally { saving.value = false }
}

async function onLogo({ file }) {
  try { await api.uploadLogo(file.file); await app.refresh(); fb.ok(t('common.saved')) } catch (e) { fb.fail(e) }
  return false
}
async function removeLogo() {
  try { await api.removeLogo(); await app.refresh() } catch (e) { fb.fail(e) }
}
onMounted(load)
</script>

<style scoped>
.narrow { max-width: 760px; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
.colors { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; outline: 1px solid var(--border); }
.swatch.on { border-color: var(--surface); outline: 2px solid var(--text); }
.logo-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.logo-prev { max-height: 40px; max-width: 160px; object-fit: contain; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
.hint { font-size: 12.5px; width: 100%; margin-top: 4px; }
.perms { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.actions { display: flex; justify-content: flex-end; margin-bottom: 20px; }
.kv { display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
</style>
