<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.shareLinks') }}</h1><p>{{ tab === 'users' ? t('grants.usersSubtitle') : t('share.subtitle') }}</p></div>
      <div v-if="tab === 'links'" class="head-actions">
        <label v-if="app.isStaff" class="all">
          <n-switch v-model:value="all" :disabled="loading" @update:value="load" />
          <span>{{ t('share.showAll') }}</span>
        </label>
        <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
      </div>
    </div>
    <!-- links for people without an account, and folders shared with users: two lists, tabs only when the user may use both -->
    <n-tabs v-if="showLinks && app.canGrant" v-model:value="tab" type="line" class="tabs">
      <n-tab name="links">{{ t('grants.tabLinks') }}</n-tab>
      <n-tab name="users">{{ t('grants.tabUsers') }}</n-tab>
    </n-tabs>
    <grants-given-panel v-if="tab === 'users'" />
    <div v-show="tab === 'links'" class="surface">
      <n-data-table :columns="columns" :data="rows" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : (all ? 1080 : 980)" table-layout="fixed" :row-key="r => r.id" :pagination="{ pageSize: 25 }"
      >
        <template #empty><n-empty :description="t('share.none')" /></template>
      </n-data-table>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NEmpty, NIcon, NSwitch, NTab, NTabs, NTag } from 'naive-ui'
import { CloseCircleOutline, CloudUploadOutline, CopyOutline, DownloadOutline, LockClosedOutline, OpenOutline, RefreshOutline } from '@vicons/ionicons5'
import { api } from '../api'
import FileIcon from '../components/FileIcon.vue'
import GrantsGivenPanel from '../components/GrantsGivenPanel.vue'
import { useFeedback, useNarrow } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDate, parentPath } from '../utils'

const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const rows = ref([])
const loading = ref(false)
// a link needs `share` and `download` (or `upload`), a folder for a user only `share`: someone with the second alone sees that list only
const showLinks = computed(() => app.canShare || app.isStaff)
const tab = ref(showLinks.value ? 'links' : 'users')
// administrators: everybody's links (with the owner) instead of their own
const all = ref(false)

async function load() {
  loading.value = true
  try {
    let shares
    if (!all.value) shares = (await api.myShares()).shares
    else if (app.isAdmin) shares = (await api.allShares()).shares
    else {
      // a manager's list holds the links of the users they manage; their own come from the personal list
      const [others, mine] = await Promise.all([api.allShares(), api.myShares()])
      shares = [...mine.shares, ...others.shares.filter(s => !mine.shares.some(m => m.id === s.id))]
    }
    rows.value = [...shares].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function revoke(s) {
  const yes = await fb.confirm({ title: t('share.revokeTitle'), content: t('share.revokeBody', { name: s.name }), positive: t('share.revoke'), danger: true })
  if (!yes) return
  try {
    await api.revokeShare(s.id)
    fb.ok(t('share.revoked'))
  } catch (e) { fb.fail(e) }
  await load()
}

const TONE = { active: 'success', expired: 'default', revoked: 'error', 'used-up': 'warning', unavailable: 'warning' }
// a revoked, expired or used-up link is dead already
const revocable = s => s.state === 'active' || s.state === 'unavailable'
const where = s => `${s.space === 'public' ? t('share.spacePublic') : t('share.spaceHome')} · ${parentPath(s.path)}`

// the whole name and folder, wrapped: a phone can not hover for a tooltip
const itemCell = s => h('div', { class: 'item-cell' }, [
  h(FileIcon, { item: { name: s.name, type: s.type }, size: 20 }),
  h('div', { class: 'item-text' }, [h('div', { class: 'item-name' }, s.name), h('div', { class: 'muted mono wrap' }, where(s)), kindTag(s)]),
])
const stateTag = s => h(NTag, {
  size: 'small', round: true, bordered: false, type: TONE[s.state] || 'default',
  title: s.state === 'unavailable' ? t('share.unavailableHint') : undefined,
}, () => t(`share.state.${s.state}`))
const isUpload = s => s.kind === 'upload'
// icon + label: a request link (people send files in) or a download link
const kindTag = s => h('span', { class: `kind ${isUpload(s) ? 'up' : ''}` }, [
  h(NIcon, { component: isUpload(s) ? CloudUploadOutline : DownloadOutline }),
  isUpload(s) ? t('share.kindUploadShort') : t('share.kindDownloadShort'),
])
// what an upload link has received and the limits it was made with
const limitsOf = s => [
  s.maxFileBytes ? t('share.limitFile', { size: formatBytes(s.maxFileBytes) }) : null,
  s.maxFiles ? t('share.limitFiles', { n: s.maxFiles }) : null,
  s.maxTotalBytes ? t('share.limitTotal', { size: formatBytes(s.maxTotalBytes) }) : null,
].filter(Boolean)
const receivedCell = s => h('div', { class: 'recv' }, [
  h('div', {}, t('share.received', { n: s.uploadedFiles ?? 0, size: formatBytes(s.uploadedBytes ?? 0) })),
  h('div', { class: 'muted small' }, limitsOf(s).join(' · ') || t('share.limitNone')),
])
const downloads = s => (isUpload(s) ? receivedCell(s) : s.maxDownloads === null ? t('share.downloadsUnlimited', { n: s.downloads }) : t('share.downloadsOf', { n: s.downloads, max: s.maxDownloads }))
const passwordCell = s => (s.hasPassword
  ? h('span', { class: 'pw' }, [h(NIcon, { component: LockClosedOutline }), t('share.yes')])
  : h('span', { class: 'muted' }, t('share.no')))
const revokeButton = s => (revocable(s)
  ? h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => revoke(s) }, { default: () => t('share.revoke'), icon: () => h(NIcon, { component: CloseCircleOutline }) })
  : null)

// the link again (kept sealed on the server since 1.8.1); asked only when wanted, never sent with the list
async function linkOf(s) {
  try {
    const r = await api.shareLink(s.id)
    return `${location.origin}${r.url}`
  } catch (e) {
    fb.error(e)
    return null
  }
}
async function copyLink(s) {
  const url = await linkOf(s)
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    fb.ok(t('share.linkCopied'))
  } catch {
    // no clipboard API (plain http that is not localhost): the browser's own box, already selected, to copy by hand
    window.prompt(t('share.copyByHand'), url)
  }
}
async function openLink(s) {
  const url = await linkOf(s)
  if (url) window.open(url, '_blank', 'noopener')
}
// the server hands the link again to its owner and to a super admin only (a manager gets "not found" for others')
const mayCopy = s => app.isAdmin || String(s.owner).toLowerCase() === app.user?.username.toLowerCase()
const actions = s => {
  if (!revocable(s)) return null
  const linkButtons = !mayCopy(s) ? [] : s.linkAvailable
    ? [
        h(NButton, { size: 'small', secondary: true, onClick: () => copyLink(s) }, { default: () => t('share.copyLink'), icon: () => h(NIcon, { component: CopyOutline }) }),
        h(NButton, { size: 'small', quaternary: true, title: t('share.openLink'), 'aria-label': t('share.openLink'), onClick: () => openLink(s) }, { icon: () => h(NIcon, { component: OpenOutline }) }),
      ]
    : [h('span', { class: 'muted small no-link' }, t('share.linkNotKept'))]
  return h('div', { class: 'row-actions' }, [...linkButtons, revokeButton(s)])
}
const when = s => h('div', { class: 'when' }, [
  h('div', { class: 'nowrap' }, formatDate(s.expiresAt)),
  h('div', { class: 'muted small' }, t('share.createdAt', { date: formatDate(s.createdAt) })),
])

// on a phone seven columns would push the state and the revoke button off screen: one stacked card per link instead
const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('share.item'), key: 'name',
      render: s => h('div', { class: 'stacked' }, [
        itemCell(s),
        h('div', { class: 'stacked-meta' }, [
          stateTag(s),
          all.value ? h('span', { class: 'owner' }, `${t('share.owner')}: ${s.owner}`) : null,
          h('span', {}, `${t('share.expiresCol')} ${formatDate(s.expiresAt)}`),
          h('span', {}, t('share.createdAt', { date: formatDate(s.createdAt) })),
          h('span', { class: 'dl' }, [`${isUpload(s) ? t('share.receivedCol') : t('share.downloads')}: `, downloads(s)]),
          h('span', {}, [`${t('share.passwordCol')}: `, passwordCell(s)]),
        ]),
        revocable(s) ? h('div', { class: 'stacked-actions' }, [actions(s)]) : null,
      ]),
    }]
  : [
      // the item takes what the others leave: they hold short values
      { title: t('share.item'), key: 'name', minWidth: 200, render: itemCell },
      ...(all.value ? [{ title: t('share.owner'), key: 'owner', width: 100, render: s => h('span', { class: 'wrap' }, s.owner) }] : []),
      { title: t('share.expiresCol'), key: 'expiresAt', width: 140, render: when },
      { title: t('share.downloadsReceived'), key: 'downloads', width: 150, render: downloads },
      { title: t('share.passwordCol'), key: 'password', width: 80, render: passwordCell },
      { title: t('share.stateCol'), key: 'state', width: 120, render: stateTag },
      { title: '', key: 'a', width: 290, align: 'right', fixed: 'right', render: actions },
    ]))

onMounted(() => { if (showLinks.value) load() })
</script>

<style scoped>
.tabs { margin-bottom: 14px; }
.head-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.all { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
:deep(.item-cell) { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
:deep(.item-text) { min-width: 0; }
:deep(.item-name) { font-weight: 500; overflow-wrap: anywhere; }
:deep(.wrap) { overflow-wrap: anywhere; }
:deep(.when) { min-width: 0; }
:deep(.small) { font-size: 12.5px; margin-top: 2px; }
:deep(.nowrap) { white-space: nowrap; }
:deep(.kind) { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; font-size: 12.5px; color: var(--muted); }
:deep(.kind.up) { color: var(--primary); }
:deep(.stacked-meta .dl) { flex-basis: 100%; }
:deep(.recv .small) { overflow-wrap: anywhere; }
:deep(.pw) { display: inline-flex; align-items: center; gap: 4px; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
:deep(.stacked-meta) { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); padding-left: 30px; }
:deep(.stacked-meta .owner) { overflow-wrap: anywhere; }
:deep(.stacked-actions) { padding-left: 30px; }
:deep(.row-actions) { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }
:deep(.stacked-actions .row-actions) { justify-content: flex-start; }
:deep(.no-link) { max-width: 150px; text-align: right; line-height: 1.3; }
</style>
