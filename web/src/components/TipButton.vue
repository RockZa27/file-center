<template>
  <!-- in a row of buttons that must touch each other (a button group) the tooltip is the root: `bare` -->
  <n-tooltip v-if="bare" :delay="300">
    <template #trigger>
      <n-button v-bind="$attrs" :size="size" :type="type" :secondary="secondary" :quaternary="quaternary" :circle="circle" :loading="loading" :aria-label="ariaLabel || label">
        <template #icon><slot /></template>
      </n-button>
    </template>
    {{ label }}
  </n-tooltip>
  <!-- else a real element holds the button: a drop-down or a popover that opens from it needs an element to anchor to -->
  <span v-else class="tip-btn" v-bind="$attrs">
    <n-tooltip :delay="300">
      <template #trigger>
        <n-button :size="size" :type="type" :secondary="secondary" :quaternary="quaternary" :circle="circle" :loading="loading" :aria-label="ariaLabel || label">
          <template #icon><slot /></template>
        </n-button>
      </template>
      {{ label }}
    </n-tooltip>
  </span>
</template>

<script setup>
// A button that shows only an icon: it always carries a tooltip and an aria-label (the same words), so a screen
// reader and a mouse both know what it does. The icon goes in the slot; class, data-* and listeners go to the
// wrapper (or to the button with `bare`).
import { NButton, NTooltip } from 'naive-ui'

defineOptions({ inheritAttrs: false })
defineProps({
  label: { type: String, required: true },
  /** the spoken label when it should say more than the tooltip (e.g. which file) */
  ariaLabel: { type: String, default: '' },
  bare: { type: Boolean, default: false },
  size: { type: String, default: 'medium' },
  type: { type: String, default: 'default' },
  secondary: { type: Boolean, default: false },
  quaternary: { type: Boolean, default: true },
  circle: { type: Boolean, default: true },
  loading: { type: Boolean, default: false },
})
</script>

<style scoped>
.tip-btn { display: inline-flex; flex: none; }
</style>
