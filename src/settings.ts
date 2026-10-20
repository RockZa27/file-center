import { paths } from './config'
import { type Lang, type MessageCode, text } from './messages'
import { JsonStore } from './store'

/** `share` (hand out a link to someone without an account) also needs `download` on the same space */
export const PERMISSIONS = ['read', 'write', 'upload', 'download', 'batchdownload', 'zip', 'share'] as const
export type Perm = (typeof PERMISSIONS)[number]

/** how the backup runs, saved from the backup page (backup.ts reads it; a missing key falls back to the BACKUP_* env values) */
export type BackupPrefs = {
  compression?: 'fast' | 'balanced' | 'smallest'
  schedule?:
    | { mode: 'off' }
    | { mode: 'daily'; time: string }
    | { mode: 'weekly'; days: number[]; time: string }
    | { mode: 'interval'; hours: number }
  keep?: number
  includeFiles?: boolean
  /** ISO time the schedule was last changed: a time slot before it is not run */
  scheduleChangedAt?: string
}

export type Settings = {
  appName: string
  primaryColor: string
  /** the three texts of the public page: '' shows the standard text in the visitor's language */
  welcomeTitle: string
  welcomeText: string
  publicEmptyText: string
  /** visitors who are not logged in may open the public page */
  publicEnabled: boolean
  /** what a visitor may do in the public folder */
  guestPermissions: Perm[]
  logo: string | null
  backup: BackupPrefs
}

const defaults = (): Settings => ({
  appName: 'File Center',
  primaryColor: '#2563eb',
  welcomeTitle: '',
  welcomeText: '',
  publicEmptyText: '',
  publicEnabled: true,
  guestPermissions: ['read', 'download', 'batchdownload'],
  logo: null,
  backup: {},
})

const store = new JsonStore<Settings>(paths.settings, defaults, { onCorrupt: 'fail' })
// make sure keys added in newer versions exist
store.update(s => Object.assign(s, { ...defaults(), ...s }))

export const settings = {
  get(): Settings {
    return store.value
  },
  update(patch: Partial<Settings>) {
    store.update(s => Object.assign(s, patch))
  },
  idle: () => store.idle(),
}

type PageText = 'welcomeTitle' | 'welcomeText' | 'publicEmptyText'
const STANDARD_TEXT: Record<PageText, MessageCode> = {
  welcomeTitle: 'admin.default-welcome-title',
  welcomeText: 'admin.default-welcome-text',
  publicEmptyText: 'admin.default-public-empty',
}
// what older versions stored as the default: a settings.json still holding exactly this follows the language as well
const OLD_DEFAULT: Record<PageText, string> = {
  welcomeTitle: 'ศูนย์รวมไฟล์',
  welcomeText: 'ดาวน์โหลดไฟล์ที่เผยแพร่ได้จากที่นี่ หากต้องการอัปโหลดหรือจัดการไฟล์ กรุณาเข้าสู่ระบบ',
  publicEmptyText: 'ยังไม่มีไฟล์เผยแพร่ในขณะนี้',
}

/** the public page's texts for a visitor: what the admin typed, exactly; otherwise the standard text in `lang` */
export function pageTexts(lang: Lang): Record<PageText, string> {
  const s = store.value
  const pick = (key: PageText) => (s[key] && s[key] !== OLD_DEFAULT[key] ? s[key] : text(lang, STANDARD_TEXT[key]))
  return { welcomeTitle: pick('welcomeTitle'), welcomeText: pick('welcomeText'), publicEmptyText: pick('publicEmptyText') }
}

export const isPerm = (p: unknown): p is Perm => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p)
export const cleanPerms = (list: unknown): Perm[] =>
  Array.isArray(list) ? [...new Set(list.filter(isPerm))] : []
