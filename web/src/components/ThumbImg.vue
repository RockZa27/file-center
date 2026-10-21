<template>
  <span ref="el" class="timg">
    <img v-if="active && !failed" :key="nonce" :src="src" :alt="alt" decoding="async" draggable="false" :class="{ on: loaded }" @load="loaded = true" @error="onError">
    <span v-if="!loaded" class="ph"><slot name="fallback" /></span>
  </span>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// A small picture that is asked for only when it is near the screen. It shows the `fallback` slot (the file icon)
// until the picture is in, and for good when the server has none: any answer but 200 means "use the icon". A busy
// server (503) is asked once more after the pause it names.
const props = defineProps({ src: { type: String, required: true }, alt: { type: String, default: '' } })

const el = ref(null)
const active = ref(false)
const loaded = ref(false)
const failed = ref(false)
const nonce = ref(0)
let retried = false
let timer = null

// one observer for every picture of the page
let shared = null
const callbacks = new WeakMap()
function observer() {
  if (!shared) {
    shared = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        shared.unobserve(e.target)
        callbacks.get(e.target)?.()
      }
    }, { rootMargin: '300px 0px' })
  }
  return shared
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { active.value = true; return }
  callbacks.set(el.value, () => { active.value = true })
  observer().observe(el.value)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  if (el.value && shared) { shared.unobserve(el.value); callbacks.delete(el.value) }
})

watch(() => props.src, () => {
  clearTimeout(timer)
  loaded.value = false
  failed.value = false
  retried = false
})

/** an <img> does not say why it failed: ask once to learn whether it is worth another try */
async function onError() {
  if (retried) { failed.value = true; return }
  let status = 0
  let wait = 3
  try {
    const res = await fetch(props.src, { credentials: 'same-origin', cache: 'no-store' })
    status = res.status
    wait = Math.min(10, Math.max(1, Number(res.headers.get('retry-after')) || 3))
    // it came right this time (a hiccup): show it
    if (res.ok) { nonce.value++; retried = true; return }
  } catch { /* no connection: the icon stays */ }
  if (status !== 503) { failed.value = true; return }
  retried = true
  timer = setTimeout(() => { nonce.value++ }, wait * 1000)
}
</script>

<style scoped>
.timg { position: relative; display: block; width: 100%; height: 100%; overflow: hidden; }
.timg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.2s; }
.timg img.on { opacity: 1; }
.ph { position: absolute; inset: 0; display: grid; place-items: center; }
</style>
