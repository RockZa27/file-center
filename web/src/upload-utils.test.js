import { describe, expect, test } from 'bun:test'
import { NAME_MAX_BYTES, nameProblem, utf8Bytes } from './upload-utils'

describe('nameProblem', () => {
  test('counts bytes, not letters', () => {
    expect(utf8Bytes('ก')).toBe(3)
    expect(NAME_MAX_BYTES).toBe(255)
  })
  test('85 Thai letters fit, 86 do not', () => {
    expect(nameProblem('ก'.repeat(85))).toBeNull()
    expect(nameProblem('ก'.repeat(86))).toEqual({ kind: 'file' })
  })
  test('an 80+ letter Thai name with an extension is refused', () => {
    expect(nameProblem(`${'รายงาน'.repeat(15)}.docx`)).toEqual({ kind: 'file' })
  })
  test('255 plain letters fit, 256 do not', () => {
    expect(nameProblem('a'.repeat(255))).toBeNull()
    expect(nameProblem('a'.repeat(256))).toEqual({ kind: 'file' })
  })
  test('surrounding spaces are not counted (the server trims)', () => {
    expect(nameProblem(` ${'a'.repeat(255)} `)).toBeNull()
  })
  test('a folder of the path that is too long is named', () => {
    expect(nameProblem('ok.txt', `a/${'ข'.repeat(90)}/b`)).toEqual({ kind: 'folder', name: 'ข'.repeat(90) })
    expect(nameProblem('ok.txt', 'a/b/c')).toBeNull()
  })
})
