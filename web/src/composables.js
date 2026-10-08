import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

export const errorText = (e, fallback = '') => e?.message || fallback

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
