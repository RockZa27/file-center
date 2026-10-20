<template><span hidden /></template>

<script setup>
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { urlNotice } from '../urlNotice'

// shows the one-time toast the address asked for (see urlNotice.js)
const { t } = useI18n()
const message = useMessage()
onMounted(() => {
  if (urlNotice === 'emailVerified') message.success(t('notify.emailVerified'))
  else if (urlNotice === 'emailVerifyFailed') message.error(t('notify.emailVerifyFailed'), { duration: 8000 })
})
</script>
