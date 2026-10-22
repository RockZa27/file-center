import { markRaw, reactive } from 'vue'
import { api } from '../api'
import { router } from '../router'
import { useAppStore } from '../store'
import { fullTour, resolve, tourIdsFor, tourSteps } from './tours'

/** the signed-in user's onboarding state, as the server keeps it */
export const guide = reactive({ loaded: false, seenVersion: null, toursDone: [] })

/** the what's-new / welcome window: mode 'welcome', 'news' (items newer than seenVersion) or 'all' (everything, for the help page) */
export const whatsNew = reactive({ show: false, mode: 'news', releases: [] })

/** AppLayout registers the side menu drawer here (it is only a drawer on a phone) */
export const drawerHook = markRaw({ open: null, close: null, isOpen: () => false })

export const tour = reactive({ active: false, steps: [], index: 0, targets: [], skipped: [], ids: [], busy: false })

export const PHONE = 960
const wait = ms => new Promise(r => setTimeout(r, ms))
let token = 0
/** where the user was when the tour began: a tour that walked through other pages brings them back */
let origin = ''

export async function loadGuide() {
  try {
    const g = await api.guide()
    guide.seenVersion = g.seenVersion ?? null
    guide.toursDone = Array.isArray(g.toursDone) ? g.toursDone : []
    guide.loaded = true
    return true
  } catch {
    return false // the guide is a nicety: no popup is better than an error
  }
}

export function saveSeen(version) {
  if (!version) return
  guide.seenVersion = version
  api.saveGuide({ seenVersion: version }).catch(() => { /* shown again next time */ })
}

function markDone(ids) {
  if (!ids.length) return
  const merged = [...new Set([...guide.toursDone, ...ids])]
  if (merged.length === guide.toursDone.length) return
  guide.toursDone = merged
  api.saveGuide({ toursDone: merged }).catch(() => { /* the tour may be offered again */ })
}

export function openWhatsNew(mode, releases) {
  whatsNew.mode = mode
  whatsNew.releases = releases
  whatsNew.show = true
}

/** the first of the named targets that is on the page and takes room */
export function findTarget(names) {
  for (const n of names) {
    for (const el of document.querySelectorAll(`[data-tour="${n}"]`)) if (el.getClientRects().length) return el
  }
  return null
}

const sameRoute = loc => {
  const cur = router.currentRoute.value
  const to = router.resolve(loc)
  return to.name && to.name === cur.name ? true : to.fullPath === cur.fullPath
}

/** make the step's page ready and answer its target, or null when it is not there (within ~1.5 s) */
async function prepare(step, mine) {
  let patience = 400 // a page that is already open has what it has; a page just opened may still be loading
  if (step.route && !sameRoute(step.route)) {
    try { await router.push(step.route) } catch { /* the page may refuse; look anyway */ }
    patience = 1500
  }
  const names = [].concat(step.target)
  let el = null
  for (let waited = 0; waited <= patience && mine === token; waited += 60) {
    el = findTarget(names)
    if (el) break
    await wait(60)
  }
  if (!el || mine !== token) return null
  // a phone shows the side menu as a drawer: open it for its items, close it for everything else
  const inMenu = !!el.closest('.sidebar')
  if (inMenu && window.innerWidth <= PHONE && !drawerHook.isOpen()) { drawerHook.open?.(); await wait(280) }
  else if (!inMenu && drawerHook.isOpen()) { drawerHook.close?.(); await wait(280) }
  if (mine !== token) return null
  el = findTarget(names) || el
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight
  const tall = r.height > vh * 0.6
  const off = tall ? r.top < 64 || r.top > vh * 0.6 : r.top < 64 || r.bottom > vh - 8
  if (off && !inFixed(el)) {
    el.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest' })
    if (tall) window.scrollBy(0, -80)
    await wait(60)
  }
  return el
}

/** inside something that stays put on screen (top bar, side menu): scrolling the page cannot bring it into view */
function inFixed(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const p = getComputedStyle(n).position
    if (p === 'fixed' || p === 'sticky') return true
  }
  return false
}

/** go to the next (dir 1) or previous (dir -1) step that has a target; past the last one the tour is over */
async function go(from, dir) {
  const mine = ++token
  tour.busy = true
  for (let i = from; i >= 0 && i < tour.steps.length; i += dir) {
    const step = tour.steps[i]
    const el = await prepare(step, mine)
    if (mine !== token) return
    if (el) { tour.index = i; tour.targets = [].concat(step.target); tour.busy = false; return }
    if (!tour.skipped.includes(step.id)) tour.skipped.push(step.id)
  }
  tour.busy = false
  if (dir > 0) end()
}

/** steps: step ids and/or inline steps (see tours.js); ids: the tours to record as done when it ends */
export async function startTour(list, { ids = [] } = {}) {
  const steps = resolve(list)
  if (!steps.length) return
  token++
  tour.steps = steps
  tour.ids = ids
  tour.skipped = []
  tour.index = 0
  tour.targets = []
  origin = router.currentRoute.value.fullPath
  tour.active = true
  await go(0, 1)
}

export const startTourById = id => startTour(tourSteps(id, useAppStore().user?.role), { ids: [id] })
export function startFullTour() {
  const role = useAppStore().user?.role
  return startTour(fullTour(role), { ids: tourIdsFor(role) })
}

export function nextStep() { if (tour.active && !tour.busy) return go(tour.index + 1, 1) }
export function prevStep() { if (tour.active && !tour.busy) return go(tour.index - 1, -1) }

/** finished, skipped or closed: the tour counts as done */
export function end() {
  token++
  tour.busy = false
  if (!tour.active) return
  tour.active = false
  tour.targets = []
  if (drawerHook.isOpen()) drawerHook.close?.()
  if (origin && router.currentRoute.value.fullPath !== origin) router.push(origin).catch(() => { /* stay */ })
  markDone(tour.ids)
}

/** a position among the steps that exist: steps found missing do not count */
export const stepNumber = () => tour.steps.slice(0, tour.index + 1).filter(s => !tour.skipped.includes(s.id)).length
export const stepTotal = () => tour.steps.filter(s => !tour.skipped.includes(s.id)).length
export const isLast = () => tour.steps.slice(tour.index + 1).every(s => tour.skipped.includes(s.id))
