import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The host resolves this package by three separate strings that must agree:
//   - package.json  name      -> the boot graph row id (nearestPackage)
//   - cordis.patch.yml insert -> the loader entry name the row is checked against
//   - lib/client.js load({id})-> the browser registration key
// A one-sided rename does not fail any other test: the loader drops the entry
// and the browser throws `could not load`. Pin all three here.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const pkg = JSON.parse(read('../package.json'))
const patch = read('../cordis.patch.yml')
const client = read('../lib/client.js')
const index = read('../lib/index.js')

const patchNames = [...patch.matchAll(/^\s*-?\s*name:\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1])
const clientId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)?.[1]
const exportName = index.match(/export const name = ['"]([^'"]+)['"]/)?.[1]

test('package.json declares the plugin name', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.ok(pkg.name.length > 0)
})

test('the bundle patch inserts exactly one plugin, under the package name', () => {
  assert.deepEqual(patchNames, [pkg.name])
})

test('the client registers under the package name', () => {
  assert.equal(clientId, pkg.name)
})

test('the plugin exports the package name', () => {
  assert.equal(exportName, pkg.name)
})
