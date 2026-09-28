import { describe, expect, test } from 'bun:test'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import {
  validateBehaviorErrorEvent,
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
  validateSecurityRequestResultEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateShellRequestResultEvent,
  validateStoreRequestEvent,
  validateStoreRequestResultEvent,
  validateSystemTwoCancelEvent,
  validateSystemTwoRequestEvent,
  validateSystemTwoRequestResultEvent,
} from '../faculties.types.ts'

describe('workers.types event vocabulary', () => {
  describe('system_two_request', () => {
    test('accepts a well-formed request', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: {
          id: 'call_1',
          input: { provider: 'ollama', modelId: 'llama3.1', input: [] },
        },
      })
      expect(valid).toBe(true)
    })
    test('accepts optional space', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: { id: 'call_1', input: {} },
        space: 'main',
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without id', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: { input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing detail', () => {
      const valid = validateSystemTwoRequestEvent({ type: FACULTY_MESSAGE_KINDS.system_two_request })
      expect(valid).toBe(false)
    })
    test('rejects a different event type', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'call_1', input: { op: 'run', script: 'x' } },
      })
      expect(valid).toBe(false)
    })
    test('rejects ingress — routed events are synthesized, never ingress', () => {
      const valid = validateSystemTwoRequestEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: { id: 'call_1', input: {} },
        ingress: 'boot',
      })
      expect(valid).toBe(false)
    })
  })

  describe('system_two_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateSystemTwoRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request_result,
        detail: { id: 'call_1', ok: true, result: { items: [], status: 'completed' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateSystemTwoRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request_result,
        detail: { id: 'call_1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing id', () => {
      const valid = validateSystemTwoRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_request_result,
        detail: { result: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('shell_request', () => {
    test('accepts a well-formed request', () => {
      const valid = validateShellRequestEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', input: { op: 'run', script: 'console.log(1)' } },
      })
      expect(valid).toBe(true)
    })
    test('accepts an optional label annotation', () => {
      const valid = validateShellRequestEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', label: 'skill-scan', input: { op: 'shell', command: 'echo hi' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without input', () => {
      const valid = validateShellRequestEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', label: 'skill-scan' },
      })
      expect(valid).toBe(false)
    })
    test('rejects extra detail keys — params live inside input', () => {
      const valid = validateShellRequestEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', bogus: 'x', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('shell_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateShellRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'sh_1', ok: true, result: { value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a missing result payload', () => {
      const valid = validateShellRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'sh_1' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('cancels', () => {
    test('accepts a well-formed system_two_cancel', () => {
      const valid = validateSystemTwoCancelEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_cancel,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(true)
    })
    test('accepts a well-formed shell_cancel', () => {
      const valid = validateShellCancelEvent({
        type: FACULTY_MESSAGE_KINDS.shell_cancel,
        detail: { id: 'shell_1' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a cancel without id', () => {
      const valid = validateSystemTwoCancelEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_cancel,
        detail: {},
      })
      expect(valid).toBe(false)
    })
    test('rejects an empty correlation id — nothing to correlate', () => {
      const valid = validateSystemTwoCancelEvent({
        type: FACULTY_MESSAGE_KINDS.system_two_cancel,
        detail: { id: '' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request', () => {
    test('accepts a well-formed request with a known operation', () => {
      const valid = validateFrontierRequestEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'explore', input: { threads: [], maxDepth: 1 } },
      })
      expect(valid).toBe(true)
    })
    test('accepts the add_thread operation — the admission path', () => {
      const valid = validateFrontierRequestEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'add_thread', input: { thread: { label: 't', rules: [] }, maxDepth: 8 } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an unknown operation — frontier is its own worker, not a tool', () => {
      const valid = validateFrontierRequestEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'frontier-explore', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateFrontierRequestEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateFrontierRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', ok: true, result: { status: 'verified' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateFrontierRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request', () => {
    test('accepts a well-formed put request', () => {
      const valid = validateStoreRequestEvent({
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'put', input: { collection: 'runs', key: 'r1', value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an op outside the enum — put|get|delete|query is the whole surface', () => {
      const valid = validateStoreRequestEvent({
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'purge', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateStoreRequestEvent({
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: { id: 's1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateStoreRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', ok: true, result: {} },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateStoreRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('credential_request / credential_result / credential_cancel', () => {
    test('accepts a well-formed credential request with the ctx join lane', () => {
      const valid = validateSecurityRequestEvent({
        type: FACULTY_MESSAGE_KINDS.credential_request,
        detail: {
          id: 'sec1',
          input: { serverUrl: 'https://mcp.example.com/mcp' },
          ctx: { issuer: 'https://as.example.com' },
        },
      })
      expect(valid).toBe(true)
    })
    test('accepts a well-formed credential result', () => {
      const valid = validateSecurityRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.credential_result,
        detail: { id: 'sec1', ok: true, result: { token: 't' } },
      })
      expect(valid).toBe(true)
    })
    test('accepts a well-formed credential cancel', () => {
      const valid = validateSecurityCancelEvent({
        type: FACULTY_MESSAGE_KINDS.credential_cancel,
        detail: { id: 'sec1' },
      })
      expect(valid).toBe(true)
    })
  })

  describe('faculty_error', () => {
    test('accepts a well-formed crash report', () => {
      const valid = validateBehaviorErrorEvent({
        type: FACULTY_MESSAGE_KINDS.faculty_error,
        detail: { faculty: 'shell', message: 'module never loaded' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a report without message', () => {
      const valid = validateBehaviorErrorEvent({
        type: FACULTY_MESSAGE_KINDS.faculty_error,
        detail: { faculty: 'shell' },
      })
      expect(valid).toBe(false)
    })
  })
})
