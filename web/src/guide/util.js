import { i18n } from '../i18n'

export { compareVersions } from './semver'

/** the roles a user is shown content for: an admin sees admin + manager + user items, a manager manager + user */
export function rolesOf(role) {
  if (role === 'admin') return ['admin', 'manager', 'user']
  if (role === 'manager') return ['manager', 'user']
  return ['user']
}
export const forRole = (list, role) => list.filter(x => !x.roles || x.roles.some(r => rolesOf(role).includes(r)))

/** the text of a { th, en } pair in the language the page shows */
export const loc = o => (o && typeof o === 'object' ? o[i18n.global.locale.value] ?? o.th ?? '' : o ?? '')
