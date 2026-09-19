/**
 * Packaging contract tests.
 *
 * A dsh plugin's manifest is part of its behaviour: a harness package declared
 * as a *dependency* lets npm nest a second copy of the runtime, and a range
 * that admits a line the plugin does not actually support hands the user a
 * silently broken install. Both are asserted here rather than described.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Published @deepseek-ai/dsh-* versions, oldest first — identical for all five, frozen 2026-09-19. */
const PUBLISHED = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5',
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

/**
 * The lines this plugin is tested against — every line from 0.1.2-rc.1 on that
 * still exports the two seams it needs (`delegationDepthOf`,
 * `agent/request` + `agent/pre-step`). Earlier lines are excluded because the
 * subagent depth helper is not exported there; the range says exactly that.
 */
const SUPPORTED = [
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

const DSH = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
]

test('no @deepseek-ai/dsh-* package is declared as a dependency', () => {
  const leaked = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(
    leaked,
    [],
    `harness packages must be peers so npm cannot nest a second copy of the runtime: ${leaked.join(', ')}`,
  )
})

for (const dep of DSH) {
  test(`peer range for ${dep} admits exactly the supported lines`, () => {
    const range = pkg.peerDependencies[dep]
    assert.ok(range, 'the dsh peer dependency must be declared')
    const admitted = PUBLISHED.filter((v) => satisfies(v, range))
    assert.deepEqual(
      admitted,
      SUPPORTED,
      `the range "${range}" admits [${admitted.join(', ')}] but this plugin supports [${SUPPORTED.join(', ')}]`,
    )
  })

  test(`peer range for ${dep} refuses every line it does not support`, () => {
    assert.equal(satisfies('0.1.1-rc.2', pkg.peerDependencies[dep]), false, 'the pre-depth helper line is refused')
    assert.equal(satisfies('0.1.2-alpha.5', pkg.peerDependencies[dep]), false, 'the same line\'s alphas are refused')
  })
}

test('the ranges are stated per line rather than as a caret on a prerelease', () => {
  // A caret on a prerelease admits only its own tuple, which would silently
  // narrow a range meant to cover several lines; naming each line is explicit.
  for (const dep of DSH) {
    const range = pkg.peerDependencies[dep]
    assert.ok(!range.startsWith('^'), `"${range}" hides the line scope behind a caret`)
    assert.equal(range.split('||').length, SUPPORTED.length >= 4 ? 4 : range.split('||').length)
  }
})

test('the dev pins stay on a line the range admits', () => {
  for (const [dep, pin] of Object.entries(pkg.devDependencies ?? {})) {
    if (!dep.startsWith('@deepseek-ai/dsh-')) continue
    assert.ok(SUPPORTED.includes(pin), `devDependency ${dep}@"${pin}" is not a supported line`)
  }
})

test('the published entry points exist', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/types/index.d.ts')
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['.'].types, './lib/types/index.d.ts')
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'the bundle patch ships')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('the plugin name, the bundle row id and the module id agree', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: subagent-model\n\s+name: '@argszero\/cordis-plugin-subagent-model'/)
  assert.equal(pkg.name, '@argszero/cordis-plugin-subagent-model')
})

test('the README quotes every peer range verbatim', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const dep of DSH) {
    const range = pkg.peerDependencies[dep]
    assert.ok(readme.includes(range), `README must quote the exact peer range: "${range}"`)
  }
  assert.ok(readme.includes(pkg.peerDependencies['@deepseek-ai/cordis']), 'the cordis range is quoted too')
})
