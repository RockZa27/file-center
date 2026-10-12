/** Markdown to clean page nodes for the live preview (GitHub style: tables, task lists, fenced code). */
import { Marked } from 'marked'
import { safeFragment } from './safe-html'

const md = new Marked({ gfm: true, breaks: false, async: false })

/** `resolve(path, 'image' | 'link')` turns an address relative to the file into a URL of this app, or null */
export function renderMarkdown(text, resolve) {
  return safeFragment(md.parse(text), { resolve })
}
