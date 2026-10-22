import { i18n } from '../i18n'

/** "1.12.0" -> [1, 12, 0]; a pre-release tail ("-beta.1") is ignored */
const parts = v => String(v || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)

/** negative when a is older than b, 0 when equal, positive when newer */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d
  }
  return 0
}

/** the roles a user is shown content for: an admin sees admin + manager + user items, a manager manager + user */
export function rolesOf(role) {
  if (role === 'admin') return ['admin', 'manager', 'user']
  if (role === 'manager') return ['manager', 'user']
  return ['user']
}
export const forRole = (list, role) => list.filter(x => !x.roles || x.roles.some(r => rolesOf(role).includes(r)))

/** the text of a { th, en } pair in the language the page shows */
export const loc = o => (o && typeof o === 'object' ? o[i18n.global.locale.value] ?? o.th ?? '' : o ?? '')
