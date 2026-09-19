#!/usr/bin/env node
/**
 * Probe the declared peer range for real: run this package's suite in a clean
 * project per admitted dsh line, against the published packages.
 *
 * Two things make the result trustworthy:
 *
 * 1. The installed version of every package this plugin imports is asserted to
 *    be exactly the probed line's version before the suite runs. A floating
 *    transitive resolution cannot quietly turn a "0.1.5" probe into a 0.1.6 run.
 * 2. The suite is the same file the package ships, so a line is admitted only
 *    if the behaviour — not just the imports — holds there.
 *
 * `--legacy-peer-deps` is required because the probe pins a subset of the
 * harness: the remaining harness packages float to the newest patch of the same
 * line, whose own peers are then unsatisfiable (measured on 0.1.5-alpha.1 and
 * 0.1.6-alpha.1). Nothing in this package's manifest is involved in that
 * conflict — the plugin is not installed here, its built output is imported
 * directly.
 *
 * Usage: node scripts/probe-lines.mjs [version ...]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const IMPORTED = ['dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-subagent', 'dsh-tools']

/** The lines the manifest declares, oldest first. Keep in step with `package.json`. */
const DECLARED = [
  '0.1.2-rc.1', '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DECLARED
const spec = readFileSync(join(root, 'test/subagent-model.spec.mjs'), 'utf8')
  .replace("'../lib/index.js'", `'${join(root, 'lib/index.js')}'`)

let failed = false
for (const version of versions) {
  const dir = mkdtempSync(join(tmpdir(), `subagent-model-probe-${version}-`))
  const dependencies = { '@deepseek-ai/cordis': '^4.0.2' }
  for (const name of IMPORTED) dependencies[`@deepseek-ai/${name}`] = version
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'probe', private: true, type: 'module', dependencies }, null, 2)}\n`)
  writeFileSync(join(dir, 'spec.mjs'), spec)
  mkdirSync(join(dir), { recursive: true })
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: 'inherit' })
  const drifted = IMPORTED.filter((name) => {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8'))
    return installed.version !== version
  })
  if (drifted.length > 0) {
    console.error(`probe ${version}: INVALID — ${drifted.join(', ')} did not resolve to the probed version`)
    failed = true
    continue
  }
  try {
    execFileSync(process.execPath, ['--test', 'spec.mjs'], { cwd: dir, stdio: 'inherit' })
    console.log(`probe ${version}: pass`)
  } catch {
    console.error(`probe ${version}: FAIL`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
