import { createPinia } from 'pinia'
import { createApp } from 'vue'
import '@fontsource/ibm-plex-sans-thai/400.css'
import '@fontsource/ibm-plex-sans-thai/500.css'
import '@fontsource/ibm-plex-sans-thai/600.css'
import App from './App.vue'
import { i18n } from './i18n'
import { router } from './router'
import { useAppStore } from './store'
import './styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)

// the session decides which pages exist, so load it before the first navigation
const store = useAppStore()
store.init().finally(() => {
  app.use(router)
  app.mount('#app')
})
