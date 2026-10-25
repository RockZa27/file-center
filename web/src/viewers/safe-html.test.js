/**
 * What the viewers let through from a file: the Markdown and slide cleaners need a real DOM, so the cleaner is bundled
 * and run in headless Chromium (Playwright). Without Playwright and a Chromium on the machine these tests are skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = ['playwright', '/opt/node-tools/node_modules/playwright/index.mjs']
const CHROMES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean)

let chromium = null
for (const name of CANDIDATES) {
  try { chromium = (await import(name)).chromium; break } catch { /* try the next one */ }
}
const executablePath = CHROMES.find(p => existsSync(p))
const available = !!chromium && (!!executablePath || !!process.env.PLAYWRIGHT_BROWSERS_PATH)

let browser = null
let page = null

beforeAll(async () => {
  if (!available) return
  const entry = join(import.meta.dir, 'safe-html.js')
  const built = await Bun.build({
    entrypoints: ['/virtual-entry.js'],
    files: { '/virtual-entry.js': `import * as s from ${JSON.stringify(entry)}; window.safe = s` },
    target: 'browser', format: 'iife',
  })
  if (!built.success) throw new Error(built.logs.join('\n'))
  const code = await built.outputs[0].text()
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
  page = await browser.newPage()
  await page.setContent('<!doctype html><body></body>')
  await page.addScriptTag({ content: code })
})
afterAll(async () => { await browser?.close() })

const t = available ? test : test.skip
const md = html => page.evaluate(h => {
  const f = window.safe.safeFragment(h)
  const d = document.createElement('div')
  d.append(f)
  return d.innerHTML
}, html)
const slide = html => page.evaluate(h => {
  const d = document.createElement('div')
  d.innerHTML = h
  window.safe.cleanSlide(d)
  return d.innerHTML
}, html)

describe('Markdown output', () => {
  t('script, event handlers and javascript: links are gone', async () => {
    const out = await md('<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><iframe src="https://a.test"></iframe><svg onload=alert(1)></svg>')
    expect(out).not.toMatch(/<script|onerror|onload|javascript:|<iframe/i)
    expect(out).toContain('<a>')
  })

  t('the style attribute is removed, so a file can not cover the page', async () => {
    const out = await md('<div style="position:fixed;inset:0;background:red">x</div><p style="color:red">y</p>')
    expect(out).not.toContain('style')
    expect(out).toContain('x')
  })

  t('forms and fields are dropped', async () => {
    const out = await md('<form id="f" action="https://a.test"><input name="q"><button>go</button></form>')
    expect(out).not.toMatch(/<form|<input|<button/)
  })

  t('ids and names are prefixed against DOM clobbering, same-page links follow', async () => {
    const out = await md('<img id="body" name="cookie"><h2 id="sec">S</h2><a href="#sec">go</a>')
    expect(out).toContain('id="user-content-body"')
    expect(out).toContain('name="user-content-cookie"')
    expect(out).toContain('id="user-content-sec"')
    expect(out).toContain('href="#user-content-sec"')
  })

  t('normal content stays', async () => {
    const out = await md('<h1>T</h1><table><tr><td>1</td></tr></table><pre><code>x</code></pre><a href="https://example.com/">l</a>')
    expect(out).toMatch(/<h1>T<\/h1>/)
    expect(out).toContain('<table>')
    expect(out).toContain('<pre><code>x</code></pre>')
    expect(out).toContain('href="https://example.com/"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
})

describe('slide output', () => {
  const SLIDE = '<div style="position:absolute;left:10px;top:5px;width:100px"><svg viewBox="0 0 10 10"><path d="M0 0L10 10" fill="#f00"/><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs></svg><img src="blob:https://app.test/abc"><table><tbody><tr><td>c</td></tr></tbody></table><span>text</span></div>'

  t('shapes, pictures from blob:, tables and positioning styles stay', async () => {
    const out = await slide(SLIDE)
    expect(out).toContain('position:absolute')
    expect(out).toContain('<path d="M0 0L10 10"')
    expect(out).toContain('linearGradient')
    expect(out).toContain('src="blob:https://app.test/abc"')
    expect(out).toContain('<td>c</td>')
  })

  t('script, handlers, javascript:/data: links, frames, forms and foreignObject are gone', async () => {
    const out = await slide(
      '<div onclick="alert(1)"><script>alert(1)</script><img src="blob:x" onerror="alert(1)">' +
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,<script>alert(1)</script>">b</a>' +
      '<iframe src="https://a.test"></iframe><form action="https://a.test"><input></form>' +
      '<svg><foreignObject><div onclick="alert(1)">h</div></foreignObject><use href="#x"/><script>alert(1)</script></svg></div>')
    expect(out).not.toMatch(/<script|onclick|onerror|javascript:|data:text|<iframe|<form|<input|foreignObject|<use/i)
  })

  t('a picture or style that would load from another site is not kept', async () => {
    const out = await slide('<div style="background:url(https://evil.test/x.png) red"><img src="https://evil.test/p.png" alt="p"><span style="background-image:url(blob:https://app.test/ok)">s</span></div>')
    expect(out).not.toContain('evil.test/x.png')
    expect(out).not.toMatch(/<img[^>]*evil\.test/)
    expect(out).toContain('url(blob:https://app.test/ok)')
  })
})
