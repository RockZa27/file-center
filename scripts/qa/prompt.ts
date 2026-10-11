/**
 * Turns an agent definition (.claude/agents/<name>.md) into the exact prompt to hand to a subagent, so the
 * text that is scored is the text that is versioned. Fills {{placeholders}} and states the allowed tools,
 * because a general-purpose subagent has every tool and only the prompt holds it to its role.
 *
 *   bun scripts/qa/prompt.ts <agent> key=value key=@file ...   prints the prompt; fails if a {{placeholder}} is left
 *   bun scripts/qa/prompt.ts --hash <agent>              short hash of the definition (recorded with each KPI)
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

export function definition(name: string) {
  const raw = readFileSync(join(root, '.claude', 'agents', `${name}.md`), 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error(`${name}.md has no frontmatter`)
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1]?.trim() ?? ''
  return { name: field('name'), tools: field('tools'), body: m[2].trim(), hash: new Bun.CryptoHasher('sha256').update(raw).digest('hex').slice(0, 10) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--hash') {
    console.log(definition(args[1]).hash)
  } else {
    const d = definition(args[0])
    // key=@path reads the value from a file (long task specs)
    const vars = Object.fromEntries(args.slice(1).map(a => {
      const i = a.indexOf('=')
      const v = a.slice(i + 1)
      return [a.slice(0, i), v.startsWith('@') ? readFileSync(resolve(v.slice(1)), 'utf8').trim() : v]
    }))
    const body = d.body.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? vars[k] : all))
    const left = [...body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])
    if (left.length) { console.error(`missing values for: ${[...new Set(left)].join(', ')}`); process.exit(1) }
    console.log(`You are the \`${d.name}\` agent (definition ${d.hash}). Use ONLY these tools: ${d.tools}. Anything your definition does not allow is off limits even if a tool exists.\n\n${body}`)
  }
}
