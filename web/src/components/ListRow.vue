<template>
  <li class="lr">
    <component :is="to ? RouterLink : 'button'" v-bind="to ? { to } : { type: 'button' }" class="lr-main" @click="$emit('open')">
      <span v-if="$slots.icon" class="lr-icon"><slot name="icon" /></span>
      <span class="lr-text">
        <span class="lr-title"><slot name="title" /></span>
        <span v-if="$slots.sub" class="lr-sub muted"><slot name="sub" /></span>
        <slot />
      </span>
    </component>
    <div v-if="$slots.actions" class="lr-actions"><slot name="actions" /></div>
  </li>
</template>

<script setup>
// One row of <list-panel>: an icon, a title with small lines under it, and the actions at the right. With `to` the
// main part is a link, else a button that says `open`. Long names wrap (a phone can not hover to read them).
import { RouterLink } from 'vue-router'

defineProps({ to: { type: [String, Object], default: null } })
defineEmits(['open'])
</script>

<style scoped>
.lr { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.lr:last-child { border-bottom: 0; }
.lr-main { all: unset; box-sizing: border-box; flex: 1 1 240px; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 6px 4px; border-radius: 8px; cursor: pointer; color: inherit; text-decoration: none; }
.lr:hover { background: var(--surface-2); }
.lr-main:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.lr-icon { flex: none; display: inline-flex; }
.lr-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.lr-title { font-weight: 500; overflow-wrap: anywhere; }
.lr-main:hover .lr-title { color: var(--primary); }
.lr-sub { font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 2px 12px; overflow-wrap: anywhere; }
.lr-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
</style>
