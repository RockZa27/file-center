<template>
  <div class="srow" :class="{ changed, bad: !!error }">
    <div class="head">
      <label class="label" :for="forId">{{ label }}</label>
      <n-tag v-if="source" size="small" round :bordered="false" :type="TONES[source]" class="tag">{{ t(`settings.source.${source}`) }}</n-tag>
      <n-button v-if="source === 'web' && !resetting" text size="tiny" type="primary" class="reset" @click="emit('reset')">{{ t('settings.reset') }}</n-button>
      <span v-if="resetting" class="resetting">
        {{ t('settings.willReset') }}
        <n-button text size="tiny" type="primary" @click="emit('undo')">{{ t('settings.undo') }}</n-button>
      </span>
    </div>
    <div class="control"><slot /></div>
    <div v-if="help" class="muted help">{{ help }}</div>
    <slot name="extra" />
    <div v-if="error" class="err" role="alert">{{ error }}</div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'

/**
 * One setting: its name, where its value comes from (the .env, the web, or the built-in default) with a way back to the
 * default when it was set on the web, the control (slot), a short help text and a field-level error.
 */
defineProps({
  label: { type: String, required: true },
  help: { type: String, default: '' },
  /** 'web' | 'env' | 'default' (none: a setting that has no .env twin) */
  source: { type: String, default: '' },
  error: { type: String, default: '' },
  /** the value was changed and is not saved yet */
  changed: Boolean,
  /** "back to the default" is chosen and takes effect on save */
  resetting: Boolean,
  forId: { type: String, default: undefined },
})
const emit = defineEmits(['reset', 'undo'])
const { t } = useI18n()
const TONES = { env: 'info', web: 'success', default: 'default' }
</script>

<style scoped>
.srow { padding: 14px 0; border-top: 1px solid var(--border); min-width: 0; }
.srow:first-child { border-top: 0; padding-top: 0; }
.srow:last-child { padding-bottom: 0; }
.srow.changed { box-shadow: -3px 0 0 0 var(--primary); padding-left: 10px; margin-left: -13px; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 6px; min-width: 0; }
.label { font-weight: 600; font-size: 14.5px; overflow-wrap: anywhere; }
.tag { flex: none; }
.reset { margin-left: auto; }
.resetting { margin-left: auto; font-size: 12.5px; color: var(--muted); }
.control { min-width: 0; }
.help { font-size: 12.5px; line-height: 1.55; margin-top: 6px; overflow-wrap: anywhere; }
.err { color: var(--danger); font-size: 12.5px; margin-top: 6px; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .srow.changed { margin-left: -4px; padding-left: 8px; }
}
</style>
