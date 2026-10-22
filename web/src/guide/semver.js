/** "1.12.0-beta.2+build" -> { nums: [1, 12, 0], pre: ['beta', '2'] } (build metadata is ignored) */
function parse(v) {
  const [core, ...rest] = String(v || '').split('+')[0].split('-')
  const pre = rest.join('-')
  return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] }
}

/** semver precedence: negative when a is older than b, 0 when equal, positive when newer ("1.12.0-beta.2" < "1.12.0") */
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (d) return d
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (+p !== +q) return +p - +q } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}
