<template>
  <div class="size">
    <n-input-number v-model:value="num" :min="0.01" :precision="2" :show-button="false" :disabled="disabled" class="num" :input-props="{ inputmode: 'decimal', id: inputId, 'aria-label': label }" @update:value="push" />
    <n-select v-model:value="unit" :options="UNITS" :disabled="disabled" class="unit" :aria-label="label" @update:value="push" />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { NInputNumber, NSelect } from 'naive-ui'
import { joinQuota, splitQuota } from '../account-utils'

/** a size in bytes, typed as a number with MB or GB next to it (v-model is the bytes, or null while empty) */
const props = defineProps({ modelValue: { type: Number, default: null }, disabled: Boolean, label: { type: String, default: '' }, inputId: { type: String, default: undefined } })
const emit = defineEmits(['update:modelValue'])
const UNITS = [{ label: 'MB', value: 'MB' }, { label: 'GB', value: 'GB' }]
const init = splitQuota(props.modelValue)
const num = ref(init.value)
const unit = ref(init.unit)

function push() { emit('update:modelValue', num.value > 0 ? joinQuota(num.value, unit.value) : null) }
// changed from outside (reset, discard, loaded): show it, unless it is what this box already says
watch(() => props.modelValue, v => {
  if ((v || null) === (num.value > 0 ? joinQuota(num.value, unit.value) : null)) return
  const s = splitQuota(v)
  num.value = s.value
  unit.value = s.unit
})
</script>

<style scoped>
.size { display: flex; gap: 8px; align-items: center; max-width: 280px; }
.num { flex: 1; min-width: 0; }
.unit { width: 92px; flex: none; }
</style>
