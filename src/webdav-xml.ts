/**
 * The little XML WebDAV needs: reading the bodies of PROPFIND, PROPPATCH and LOCK, and writing text safely.
 * Not a general parser. It refuses what could hurt (a DOCTYPE or ENTITY, which is how XML bombs and external
 * entities are made; deep nesting; many elements; bodies over 64 KB are refused before they reach it) and is
 * tolerant about the rest (any prefix, comments, CDATA, processing instructions, extra whitespace).
 */

export const DAV_NS = 'DAV:'
export const XML_MAX_BYTES = 64 * 1024
const MAX_DEPTH = 24
const MAX_ELEMENTS = 2000

export class XmlError extends Error {}

export type XNode = {
  /** namespace URI ('' when none), and the name without its prefix */
  ns: string
  name: string
  children: XNode[]
  /** all text directly inside, entities decoded */
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?'
const START = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'y')
const ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g')
const END = new RegExp(`</(${NAME})\\s*>`, 'y')

/** the document's root element; throws XmlError on anything it does not accept */
export function parseXml(src: string): XNode {
  if (src.length > XML_MAX_BYTES) throw new XmlError('too big')
  if (/<!\s*(doctype|entity)/i.test(src)) throw new XmlError('doctype')
  let i = 0
  let count = 0
  let root: XNode | null = null
  // each open element with the prefixes in scope at that point
  const stack: { node: XNode; qname: string; scope: Map<string, string> }[] = []
  const scopeOf = () => stack.at(-1)?.scope ?? new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']])

  const resolve = (qname: string, scope: Map<string, string>, isAttr = false) => {
    const c = qname.indexOf(':')
    const prefix = c < 0 ? '' : qname.slice(0, c)
    const local = c < 0 ? qname : qname.slice(c + 1)
    if (isAttr && !prefix) return { ns: '', local }
    const ns = scope.get(prefix)
    if (prefix && ns === undefined) throw new XmlError('unknown prefix')
    return { ns: ns ?? '', local }
  }

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const textEnd = lt < 0 ? src.length : lt
    if (textEnd > i && stack.length) stack.at(-1)!.node.text += decode(src.slice(i, textEnd))
    if (lt < 0) break
    i = lt
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) throw new XmlError('comment')
      i = end + 3
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9)
      if (end < 0 || !stack.length) throw new XmlError('cdata')
      stack.at(-1)!.node.text += src.slice(i + 9, end)
      i = end + 3
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end < 0) throw new XmlError('pi')
      i = end + 2
    } else if (src.startsWith('</', i)) {
      END.lastIndex = i
      const m = END.exec(src)
      const open = stack.pop()
      if (!m || !open || open.qname !== m[1]) throw new XmlError('mismatched tag')
      i = END.lastIndex
    } else {
      START.lastIndex = i
      const m = START.exec(src)
      if (!m) throw new XmlError('bad tag')
      if (++count > MAX_ELEMENTS || stack.length >= MAX_DEPTH) throw new XmlError('too complex')
      i = START.lastIndex
      // namespace declarations first: they apply to the element itself
      const scope = new Map(scopeOf())
      const attrs: [string, string][] = []
      for (const a of m[2].matchAll(ATTR)) attrs.push([a[1], decode(a[2] ?? a[3] ?? '')])
      for (const [k, v] of attrs) {
        if (k === 'xmlns') scope.set('', v)
        else if (k.startsWith('xmlns:')) {
          // a prefix can not be undeclared (XML Namespaces 1.0)
          if (!v) throw new XmlError('empty prefix namespace')
          scope.set(k.slice(6), v)
        }
      }
      const { ns, local } = resolve(m[1], scope)
      const node: XNode = { ns, name: local, children: [], text: '' }
      if (stack.length) stack.at(-1)!.node.children.push(node)
      else if (root) throw new XmlError('two roots')
      else root = node
      if (!m[3]) stack.push({ node, qname: m[1], scope })
    }
  }
  if (!root || stack.length) throw new XmlError('incomplete')
  return root
}

export const child = (n: XNode, name: string, ns = DAV_NS) => n.children.find(c => c.name === name && c.ns === ns)

// ───────────── writing ─────────────

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g
/** text: & < > escaped, and the characters XML 1.0 can not hold become U+FFFD (a file name may hold them) */
export const esc = (s: string): string => s.replace(CONTROL, '\ufffd').replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
/** an attribute value in double quotes */
export const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;')

export const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'

/** an element name that came from a request is written back only when it is a plain name */
export const safeName = (s: string) => /^[A-Za-z_][\w.-]{0,100}$/.test(s)
