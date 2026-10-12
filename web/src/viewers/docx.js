/**
 * Word documents (.docx) for the preview, drawn by docx-preview into a shadow root: the document's own styles stay
 * inside it and the page's styles stay out. Rendered while detached and cleaned before it is shown; embedded HTML
 * parts (altChunk) are never rendered, embedded fonts are not loaded.
 */
import { renderAsync } from 'docx-preview'
import { cleanInPlace } from './safe-html'

const OWN_STYLE = `
:host { display: block; }
.docx-wrapper { background: var(--doc-backdrop, #e5e7eb) !important; padding: 16px !important; }
.docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(0, 0, 0, .25) !important; margin-bottom: 16px !important; }
.docx a[href] { color: #2563eb; }
.narrow .docx-wrapper { padding: 6px !important; }
.narrow .docx-wrapper > section.docx { padding: 16px !important; width: auto !important; min-height: 0 !important; }
.narrow table { max-width: 100%; }
/* headers and footers sit in the page margin; on a phone the margin is small, so they go into the flow */
.narrow section.docx > header { margin: 0 0 12px !important; min-height: 0 !important; }
.narrow section.docx > footer { margin: 12px 0 0 !important; min-height: 0 !important; }
`

/** draws `data` into `host`; answers a function that frees the pictures it unpacked */
export async function renderDocx(data, host, { narrow = false } = {}) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const styles = document.createElement('div')
  const body = document.createElement('div')
  if (narrow) body.className = 'narrow'
  await renderAsync(data, body, styles, {
    className: 'docx', inWrapper: true, breakPages: true, ignoreWidth: narrow, ignoreHeight: narrow,
    ignoreFonts: true, renderAltChunks: false, renderComments: false, renderChanges: false, useBase64URL: false,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, experimental: false,
  })
  cleanInPlace(body)
  const own = document.createElement('style')
  own.textContent = OWN_STYLE
  root.replaceChildren(styles, own, body)
  return () => {
    for (const img of root.querySelectorAll('img[src^="blob:"]')) URL.revokeObjectURL(img.getAttribute('src'))
    root.replaceChildren()
  }
}
