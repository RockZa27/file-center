import { expect, test } from 'bun:test'
// @ts-ignore plain JS from the web app
import { compareVersions } from '../web/src/guide/semver.js'

const sign = (n: number) => Math.sign(n)

test('compareVersions follows semver precedence', () => {
  expect(sign(compareVersions('1.12.0-beta.2', '1.12.0'))).toBe(-1)
  expect(sign(compareVersions('1.12.0', '1.12.0-beta.2'))).toBe(1)
  expect(sign(compareVersions('1.12.0-beta.2', '1.12.0-beta.10'))).toBe(-1)
  expect(sign(compareVersions('1.12.0-alpha', '1.12.0-beta'))).toBe(-1)
  expect(sign(compareVersions('1.12.0-beta', '1.12.0-beta.1'))).toBe(-1)
  expect(sign(compareVersions('1.12.0-1', '1.12.0-beta'))).toBe(-1)
  expect(sign(compareVersions('1.11.9', '1.12.0-beta.1'))).toBe(-1)
  expect(sign(compareVersions('1.12.1', '1.12.0'))).toBe(1)
  expect(compareVersions('1.12.0', '1.12.0')).toBe(0)
  expect(compareVersions('1.12.0-rc.1+build5', '1.12.0-rc.1')).toBe(0)
  expect(compareVersions(null, '0.0.0')).toBe(0)
})
