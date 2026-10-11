<template>
  <div class="rules" aria-live="polite">
    <div class="muted">{{ t('password.rule', { n: min }) }}</div>
    <ul v-if="password" class="checks">
      <li v-for="c in checks" :key="c.key" :data-ok="c.ok" :style="{ color: c.ok ? theme.successColor : theme.errorColor }">
        <n-icon :component="c.ok ? CheckmarkCircle : CloseCircle" /><span>{{ c.text }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
// The rule and a live hint under a new-password field. Only length and "contains the username" are checked here;
// the server judges everything (the common-password list too) and its message is shown as it comes.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NIcon, useThemeVars } from 'naive-ui'
import { CheckmarkCircle, CloseCircle } from '@vicons/ionicons5'
import { useAppStore } from '../store'

const props = defineProps({ password: { type: String, default: '' }, username: { type: String, default: '' } })
const { t } = useI18n()
const app = useAppStore()
const theme = useThemeVars()

const min = computed(() => app.config.passwordMinLength || 10)
const name = computed(() => props.username.trim().toLowerCase())
const longEnough = computed(() => props.password.length >= min.value)
const hasName = computed(() => !!name.value && props.password.toLowerCase().includes(name.value))
const checks = computed(() => {
  const len = props.password.length
  const list = [{ key: 'length', ok: longEnough.value, text: longEnough.value ? t('password.lengthOk', { len }) : t('password.tooShort', { len, n: min.value }) }]
  // no username typed yet (new user): nothing to compare with
  if (name.value) list.push({ key: 'username', ok: !hasName.value, text: hasName.value ? t('password.hasUsername') : t('password.noUsername') })
  return list
})
</script>

<style scoped>
.rules { font-size: 12.5px; line-height: 1.5; margin-top: 6px; overflow-wrap: anywhere; }
.checks { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.checks li { display: flex; align-items: flex-start; gap: 6px; }
.checks li .n-icon { flex: none; margin-top: 3px; }
</style>
