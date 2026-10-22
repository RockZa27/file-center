<template>
  <div class="page-header">
    <div class="ph-text">
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="ph-actions"><slot name="actions" /></div>
  </div>
</template>

<script setup>
defineProps({ title: { type: String, required: true }, description: { type: String, default: '' } })
</script>

<style scoped>
.ph-text { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
.ph-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
