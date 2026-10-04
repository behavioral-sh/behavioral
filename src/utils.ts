/**
 * Utility functions for the behavioral framework.
 * Provides general-purpose helpers for type checking, string manipulation, and more.
 *
 * @remarks
 * This module provides access to:
 * - **Type Checking**: {@link isTypeOf}, {@link trueTypeOf} - Runtime type validation and detection
 * - **Data Utilities**: {@link keyMirror} - Object key mirroring, {@link deepEqual} - Deep equality
 *
 * @remarks
 * All utilities are pure functions with no side effects unless explicitly documented.
 * These utilities are framework-agnostic and can be used independently of the behavioral harness's core features.
 *
 * @see {@link https://github.com/behavioral-sh/behavioral} for framework documentation
 * @since 1.0.0
 */

export * from './utils/case.ts'
export * from './utils/deep-equal.ts'
export * from './utils/escape.ts'
export * from './utils/hash-string.ts'
export * from './utils/is-type-of.ts'
export * from './utils/jittered-backoff.ts'
export * from './utils/key-mirror.ts'
export * from './utils/true-type-of.ts'
export * from './utils/uuid.ts'
export * from './utils/wait.ts'
