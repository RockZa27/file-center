<template>
  <div class="shell" :class="{ center }">
    <header class="bar">
      <app-logo :to="logoTo" />
      <div class="bar-right">
        <slot name="actions" />
        <preference-controls />
      </div>
    </header>
    <div class="body"><slot /></div>
  </div>
</template>

<script setup>
// The frame of every page a visitor sees without the app shell (sign in, the public page, a share link):
// the same top bar with the logo and the name from the settings, the theme and language controls, then the page.
import AppLogo from './AppLogo.vue'
import PreferenceControls from './PreferenceControls.vue'

defineProps({
  logoTo: { type: [String, Object], default: '/' },
  /** the content sits in the middle of the screen (the sign in card) */
  center: { type: Boolean, default: false },
})
</script>

<style scoped>
.shell { min-height: 100vh; display: flex; flex-direction: column; }
.shell.center { background: radial-gradient(900px 400px at 0% 0%, var(--primary-soft), transparent 70%), var(--bg); }
.bar { height: var(--header-h); flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 24px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 30; }
.bar-right { display: flex; align-items: center; gap: 8px; flex: none; }
.body { flex: 1; min-width: 0; }
.center .body { display: grid; place-items: center; padding: 24px 16px; }
@media (max-width: 768px) {
  .bar { padding: 0 12px; }
}
</style>
