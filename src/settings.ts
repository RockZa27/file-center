import { paths } from './config'
import { JsonStore } from './store'

export const PERMISSIONS = ['read', 'write', 'upload', 'download', 'batchdownload', 'zip'] as const
export type Perm = (typeof PERMISSIONS)[number]

export type Settings = {
  appName: string
  primaryColor: string
  welcomeTitle: string
  welcomeText: string
  publicEmptyText: string
  /** visitors who are not logged in may open the public page */
  publicEnabled: boolean
  /** what a visitor may do in the public folder */
  guestPermissions: Perm[]
  logo: string | null
}

const defaults = (): Settings => ({
  appName: 'File Center',
  primaryColor: '#2563eb',
  welcomeTitle: 'ศูนย์รวมไฟล์',
  welcomeText: 'ดาวน์โหลดไฟล์ที่เผยแพร่ได้จากที่นี่ หากต้องการอัปโหลดหรือจัดการไฟล์ กรุณาเข้าสู่ระบบ',
  publicEmptyText: 'ยังไม่มีไฟล์เผยแพร่ในขณะนี้',
  publicEnabled: true,
  guestPermissions: ['read', 'download', 'batchdownload'],
  logo: null,
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

export const isPerm = (p: unknown): p is Perm => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p)
export const cleanPerms = (list: unknown): Perm[] =>
  Array.isArray(list) ? [...new Set(list.filter(isPerm))] : []
