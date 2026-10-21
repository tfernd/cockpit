// Keeps the docs honest: each control file stays under its line budget, every repo path a doc names exists, and
// SCHEMA.md names the Claude Code version whose types it describes. Run by `make docs` and the pre-commit hook.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const BUDGET = { 'AGENTS.md': 150, 'SCHEMA.md': 400, 'README.md': 120, 'AGENTS-SNIPPET.md': 40 } // adding a rule means merging or removing one
const DOCS = [...Object.keys(BUDGET), 'assets/README.md']
const GENERATED = ['.claude-plugin/types', '.render'] // named by the docs, made by Claude Code or `make render`
const tops = new Set(readdirSync(root))
const errors = []

for (const doc of DOCS) {
  const file = join(root, doc)
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').length
  if (BUDGET[doc] && lines > BUDGET[doc]) errors.push(`${doc}: ${lines} lines, budget ${BUDGET[doc]}`)
  // Markdown links, relative to the doc.
  for (const [, href] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(href)) continue
    if (!existsSync(join(dirname(file), href))) errors.push(`${doc}: link to missing ${href}`)
  }
  // Backticked repo paths: a top-level entry of the repo followed by a slash (`lib/model.js`, `.shots/`).
  for (const [, p] of text.matchAll(/`([\w.-]+\/[\w./-]*)`/g)) {
    if (!tops.has(p.split('/')[0]) || GENERATED.some((g) => p.startsWith(g))) continue
    if (!existsSync(join(root, p))) errors.push(`${doc}: names missing ${p}`)
  }
}

const types = join(root, '.claude-plugin/types/claude-code/index.d.ts')
if (existsSync(types)) {
  const v = /Claude Code (\d+\.\d+\.\d+)/.exec(readFileSync(types, 'utf8').slice(0, 200))?.[1]
  if (v && !readFileSync(join(root, 'SCHEMA.md'), 'utf8').includes('Claude Code ' + v)) errors.push(`SCHEMA.md: written for another Claude Code; the types are ${v}, check what changed and update it`)
} else {
  console.log('check-docs: no .claude-plugin/types yet (run `claude --plugin-dir .` once), SCHEMA.md version not checked')
}

for (const e of errors) console.error('check-docs: ' + e)
process.exit(errors.length ? 1 : 0)
