import { ref } from 'vue'
import { api } from './api'
import { extOf } from './utils'

/** what the server can make a small picture of (src/thumbs.ts): images, the first page of a PDF, a frame of a video */
const THUMB_IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif']
const THUMB_VIDEO = ['mp4', 'm4v', 'mov', '3gp', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'wmv', 'flv']

/** 'image' | 'pdf' | 'video' when a picture can be asked for, else null */
export function thumbKindOf(name) {
  const e = extOf(name || '')
  if (THUMB_IMAGE.includes(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (THUMB_VIDEO.includes(e)) return 'video'
  return null
}

/** 'image' | 'video' for what the gallery and the lightbox show (a PDF is not), else null */
export function mediaKindOf(name) {
  const k = thumbKindOf(name)
  return k === 'image' || k === 'video' ? k : null
}

/** the browser can show this one as it is (the others only through their picture) */
export const NATIVE_IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'ico']
export const canShowOriginal = name => NATIVE_IMAGE.includes(extOf(name || ''))

// ───── what the server can do: asked once per page load ─────
/** null = not known (a visitor cannot ask: every kind is tried and the icon shows when it fails) */
export const thumbStatus = ref(null)
/** false until the answer (or the fact that nobody can be asked) is in: no picture is requested before that */
export const thumbReady = ref(false)
let asked = null

export function loadThumbStatus(signedIn) {
  if (!signedIn) {
    thumbReady.value = true
    return Promise.resolve(thumbStatus.value)
  }
  if (!asked) {
    // a failed question leaves every kind to be tried (the icon shows for those that fail)
    asked = api.thumbStatus().then(s => { thumbStatus.value = s; thumbReady.value = true; return s }, () => { asked = null; thumbReady.value = true; return null })
  }
  return asked
}

/** a small picture is worth asking for: the file kind has one and the server can make it */
export function wantsThumb(name) {
  const k = thumbKindOf(name)
  if (!k || !thumbReady.value) return false
  return thumbStatus.value ? !!thumbStatus.value[k] : true
}

/** 256 is enough for a small tile; a sharp screen or a big tile takes the 1024 one */
export const sharpScreen = () => (typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 1.4)
