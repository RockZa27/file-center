/**
 * Naive UI is not registered globally (web/src/main.js): every page imports the components it uses. A tag that is not
 * imported does not fail the build, it renders as an unknown element (an <n-checkbox> that shows its label but can never
 * be ticked — found in the browser check of the backup restore dialog). The same for h(NXxx) in render functions,
 * which throws only when that row is drawn. Static check of every .vue file.
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..', 'web', 'src')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? vueFiles(p) : n.endsWith('.vue') ? [p] : []
  })
}

/** n-checkbox → NCheckbox, n-input-number → NInputNumber */
const componentOf = (tag: string) => 'N' + tag.slice(2).split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('')

function naiveImports(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]naive-ui['"]/g)) {
    for (const part of m[1].split(',')) {
      // `NFoo as Bar` imports NFoo
      const name = part.trim().split(/\s+as\s+/)[0]
      if (name) out.add(name)
    }
  }
  return out
}

test('every Naive UI tag and h(NXxx) in a page is imported from naive-ui', () => {
  const files = vueFiles(root)
  expect(files.length).toBeGreaterThan(20)
  const missing: string[] = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const imported = naiveImports(src)
    const template = src.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
    const used = new Set<string>()
    for (const m of template.matchAll(/<(n-[a-z0-9-]+)/g)) used.add(componentOf(m[1]))
    for (const m of src.matchAll(/\bh\(\s*(N[A-Z][A-Za-z]*)\b/g)) used.add(m[1])
    for (const name of used) if (!imported.has(name)) missing.push(`${relative(root, file)}: ${name}`)
  }
  expect(missing).toEqual([])
})

test('the check itself sees a tag that is not imported', () => {
  const src = "<template><n-checkbox /><n-input-number /></template>\n<script setup>\nimport { NInputNumber } from 'naive-ui'\n</script>"
  const imported = naiveImports(src)
  const tags = [...src.matchAll(/<(n-[a-z0-9-]+)/g)].map(m => componentOf(m[1]))
  expect(tags).toEqual(['NCheckbox', 'NInputNumber'])
  expect(tags.filter(t => !imported.has(t))).toEqual(['NCheckbox'])
})
