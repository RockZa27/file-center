<template>
  <div class="surface lp">
    <list-skeleton v-if="loading && !count" />
    <n-empty v-else-if="!count" class="lp-empty" :description="empty" />
    <ul v-else class="lp-list"><slot /></ul>
  </div>
</template>

<script setup>
// The panel of a list that is not a table (favorites, group folders, shared with me): the same frame, spacing and
// states as a table page. Put <list-row> items in it.
import { NEmpty } from 'naive-ui'
import ListSkeleton from './ListSkeleton.vue'

defineProps({
  /** the list is being read */
  loading: { type: Boolean, default: false },
  /** how many rows there are (none: the skeleton while loading, else the empty state) */
  count: { type: Number, default: 0 },
  empty: { type: String, default: '' },
})
</script>

<style scoped>
.lp { overflow: hidden; }
.lp-empty { padding: 56px 16px; }
.lp-list { list-style: none; margin: 0; padding: 0; }
</style>
