/**
 * The bProgram composition boundary — the host-agnostic runtime composition
 * (`bProgram`) and its specs (`src/b-program/tests/`), the `src/controller.ts`
 * precedent. The bProgram worker entry joins this home with the browser-shape
 * work; the `src/cli/` boundary shrinks to host entries, config, and the TUI.
 *
 * @public
 */

export { bProgram } from './b-program/b-program.ts'
