import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { download } from './api'

export const errorText = (e, fallback = '') => e?.message || fallback

/** true while the screen is phone-wide: tables switch to one stacked card per row instead of scrolling sideways */
export function useNarrow(query = '(max-width: 640px)') {
  const mq = window.matchMedia(query)
  const narrow = ref(mq.matches)
  const onChange = e => { narrow.value = e.matches }
  onMounted(() => { narrow.value = mq.matches; mq.addEventListener('change', onChange) })
  onBeforeUnmount(() => mq.removeEventListener('change', onChange))
  return narrow
}

/**
 * A download button that checks the session first (see `download` in api.js): signed out, the error shows on the
 * page and the app goes to sign-in instead of the browser saving the server's error as the file.
 * `busy` holds the key of the download being checked, for the button's spinner; `save` answers whether it started.
 */
export function useDownload() {
  const fb = useFeedback()
  const busy = ref(null)
  async function save(url, { key = url, name = '', admin = false } = {}) {
    if (busy.value !== null) return false
    busy.value = key
    try {
      await download(url, { name, admin })
      return true
    } catch (e) {
      fb.fail(e)
      return false
    } finally {
      busy.value = null
    }
  }
  return { busy, save }
}

/** message + confirm helpers shared by every screen */
export function useFeedback() {
  const message = useMessage()
  const dialog = useDialog()
  const { t } = useI18n()
  return {
    ok: text => message.success(text),
    warn: text => message.warning(text, { duration: 6000 }),
    fail: (e, fallback) => message.error(errorText(e, fallback || t('common.unknownError')), { duration: 6000 }),
    confirm: ({ title, content, positive, danger = false }) =>
      new Promise(resolve => {
        dialog[danger ? 'warning' : 'info']({
          title,
          content,
          positiveText: positive || t('common.confirm'),
          negativeText: t('common.cancel'),
          positiveButtonProps: danger ? { type: 'error' } : { type: 'primary' },
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
          onMaskClick: () => resolve(false),
        })
      }),
  }
}
