/**
 * Cleans HTML that came out of a file (Markdown, a Word document, slides) before the page shows it: no scripts, no
 * event handlers, no frames or forms, links only to http(s), mail and phone, or to files next to it.
 * Pictures from other sites would be blocked by the page's security policy anyway: they become a link instead.
 */
import DOMPurify from 'dompurify'

// http(s), mailto, tel, blob (pictures a viewer unpacked from the file), and relative addresses
const SAFE_URI = /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
const EXTERNAL = /^[a-z][a-z+.-]*:/i

const purify = DOMPurify(window)
/** set during one sanitize call: maps a relative address in the file to a URL of this app (or null) */
let resolveRelative = null
/** set during one safeFragment call: ids and names are prefixed, so a file can not clobber page globals */
let prefixIds = false

purify.addHook('afterSanitizeAttributes', node => {
  const tag = node.nodeName
  if (tag === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href')
    if (href.startsWith('#')) {
      // named ids get a prefix in Markdown (see safeFragment), so same-page links follow them
      if (prefixIds && href.length > 1 && !href.startsWith('#user-content-')) node.setAttribute('href', `#user-content-${href.slice(1)}`)
      return
    }
    if (!EXTERNAL.test(href) && !href.startsWith('//')) {
      const url = resolveRelative?.(href, 'link')
      if (url) node.setAttribute('href', url)
      else node.removeAttribute('href')
    }
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (tag === 'IMG' && node.hasAttribute('src')) {
    const src = node.getAttribute('src')
    if (/^(?:data:image\/|blob:)/i.test(src)) return
    const url = !EXTERNAL.test(src) && !src.startsWith('//') ? resolveRelative?.(src, 'image') : null
    if (url) { node.setAttribute('src', url); return }
    // a picture from another site: marked here, swapped for a link once the walk is over (see outsidePictures)
    node.removeAttribute('src')
    node.setAttribute('data-outside-src', /^https?:/i.test(src) ? src : '')
  }
})

/** pictures from other sites become a link to them, with their alt text */
function outsidePictures(root) {
  for (const img of root.querySelectorAll('img[data-outside-src]')) {
    const src = img.getAttribute('data-outside-src')
    const a = img.ownerDocument.createElement('a')
    a.textContent = img.getAttribute('alt') || src || '?'
    if (src) { a.setAttribute('href', src); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') }
    img.replaceWith(a)
  }
  return root
}

const BASE = {
  ALLOWED_URI_REGEXP: SAFE_URI,
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping'],
}

/** an HTML string from a converter (Markdown) as clean nodes; never assigned with innerHTML */
export function safeFragment(html, { resolve = null } = {}) {
  resolveRelative = resolve
  prefixIds = true
  try {
    // Markdown shows in the page itself (not a shadow root): no style attribute, ids and names prefixed (DOM clobbering)
    return outsidePictures(purify.sanitize(html, {
      ...BASE,
      FORBID_TAGS: [...BASE.FORBID_TAGS, 'style'],
      FORBID_ATTR: [...BASE.FORBID_ATTR, 'style'],
      SANITIZE_NAMED_PROPS: true,
      RETURN_DOM_FRAGMENT: true,
    }))
  } finally {
    resolveRelative = null
    prefixIds = false
  }
}

/** nodes a viewer library built: cleaned where they are, before they are put into the page */
export function cleanInPlace(node, { resolve = null } = {}) {
  resolveRelative = resolve
  try {
    purify.sanitize(node, { ...BASE, IN_PLACE: true })
  } finally {
    resolveRelative = null
  }
  return outsidePictures(node)
}

/** one rendered slide: cleaned where it is (inline SVG, positioning styles and blob: pictures stay), then its links */
export function cleanSlide(el) {
  // a slide is drawn from shapes and text: no stylesheet of its own, no SVG that points elsewhere
  purify.sanitize(el, { ...BASE, FORBID_TAGS: [...BASE.FORBID_TAGS, 'style', 'foreignObject', 'use', 'script'], IN_PLACE: true })
  outsidePictures(el)
  for (const n of [el, ...el.querySelectorAll('[style]')]) {
    const style = n.getAttribute?.('style')
    // a style that loads something from another site (url(https://...), @import) would call out as soon as it is shown
    if (style && /url\s*\(|@import|expression\s*\(/i.test(style)) {
      n.setAttribute('style', style.replace(/url\(\s*(['"]?)(?!blob:|data:image\/|#)[^)]*\1\s*\)/gi, 'none').replace(/@import|expression\s*\(/gi, ''))
    }
  }
  cleanLinks(el)
  return el
}

/** links in slides the viewer already put in the page: only safe addresses, opened in a new tab */
export function cleanLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    if (!/^(?:https?:|mailto:|tel:|#)/i.test(href)) a.removeAttribute('href')
    else if (!href.startsWith('#')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') }
  }
}
