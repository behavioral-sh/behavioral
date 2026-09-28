import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { behavioralHome } from '../behavioral-home.ts'

describe('behavioralHome', () => {
  test('BEHAVIORAL_HOME overrides the default root', () => {
    expect(behavioralHome({ BEHAVIORAL_HOME: '/tmp/behavioral-home' })).toBe('/tmp/behavioral-home')
  })

  test('defaults to ~/.behavioral when BEHAVIORAL_HOME is unset', () => {
    expect(behavioralHome({})).toBe(join(homedir(), '.behavioral'))
  })
})
