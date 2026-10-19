/**
 * One shared limit on chunk requests in flight, across all files of a page.
 * A big file alone gets every slot; many small files share them.
 * `limit` is read on each use, so a changed setting applies at once.
 */
export function createPool(limit) {
  let used = 0
  const waiting = []
  const free = () => {
    while (waiting.length && used < Math.max(1, limit())) {
      used++
      waiting.shift()()
    }
  }
  return {
    /** resolves when a slot is yours; give it back with release() */
    acquire() {
      if (used < Math.max(1, limit())) { used++; return Promise.resolve() }
      return new Promise(resolve => waiting.push(resolve))
    },
    release() {
      used--
      free()
    },
  }
}
