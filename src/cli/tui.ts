import { createInterface } from 'node:readline'
import type { JSONSchemaType } from 'ajv'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent } from '../behavioral/behavioral.types.ts'

// ---------------------------------------------------------------------------
// The tui_* vocabulary — its own small closed family, ingress-only (not a
// `ui_*` mirror). Two incoming constants with specific detail shapes; no
// outbound `tui_*` exists — the TUI's egress is the existing trace wire.
// The constants live here because they are the TUI's vocabulary, not the
// engine's; the guard-threads generator consumes the type→schema pairs.
// ---------------------------------------------------------------------------

/** A raw (unparsed) command line from the prompt. */
export const TUI_COMMAND = 'tui_command'

/** A chosen option from a selection. */
export const TUI_SELECT = 'tui_select'

export type TuiCommandDetail = { line: string }
export type TuiSelectDetail = { option: string }

export const TuiCommandDetailSchema: JSONSchemaType<TuiCommandDetail> = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
  additionalProperties: false,
}

export const TuiSelectDetailSchema: JSONSchemaType<TuiSelectDetail> = {
  type: 'object',
  properties: { option: { type: 'string' } },
  required: ['option'],
  additionalProperties: false,
}

/** The tui_* ingress detail schemas, keyed by the event type. */
export const TUI_DETAIL_SCHEMAS = {
  [TUI_COMMAND]: TuiCommandDetailSchema,
  [TUI_SELECT]: TuiSelectDetailSchema,
} as const

/**
 * Kind/severity → `Bun.color` input for trace lines. Colors are
 * presentation-only: `emit` resolves them at render time and they never enter
 * the wire or a prompt. Kinds without an entry render plain.
 */
export const TRACE_KIND_COLORS: Record<string, string> = {
  [TRACE_MESSAGE_KINDS.deadlock]: 'red',
  [TRACE_MESSAGE_KINDS.trigger_error]: 'red',
  [TRACE_MESSAGE_KINDS.add_thread_error]: 'red',
  [TRACE_MESSAGE_KINDS.idle]: 'dimgray',
  [TRACE_MESSAGE_KINDS.selection]: 'cyan',
}

/** Where the TUI writes by default. */
const defaultWrite = (text: string): void => {
  process.stdout.write(text)
}

/**
 * The minimal TUI surface — exactly three primitives: `emit` (trace/log lines
 * → terminal, egress-only), `prompt` (a slash-command line → a `tui_command`
 * ingress event), `select` (a numbered choice → a `tui_select` ingress event).
 *
 * @remarks
 * Readline only, no alt-buffer framework. Slash commands are NOT parsed here:
 * the TUI forwards the raw line and the engine's threads validate. The TUI
 * never calls the engine — every primitive that produces user intent resolves
 * to a BPEvent the client wiring sends over the socket like every other
 * client. The TUI is deliberately a single-file thin client (a `serve.ts`-style
 * surface); if it outgrows ~300 lines that is a design smell, not structure to
 * build — logic belongs in threads.
 *
 * @public
 */
export type Tui = {
  /** Egress-only: write one terminal line, optionally colored. Produces no event. */
  emit: (text: string, color?: string) => void
  /** Read one command line; resolves to the `tui_command` ingress event. */
  prompt: (text?: string) => Promise<BPEvent>
  /** Render numbered options and read one choice; resolves to `tui_select`. */
  select: (question: string, options: string[]) => Promise<BPEvent>
  /** Release the readline. */
  close: () => void
}

/**
 * Create the TUI over `input` (readline) and `write` (egress).
 *
 * @public
 */
export const createTui = ({
  input,
  write = defaultWrite,
}: {
  /** The line source (stdin for the real TUI; a scripted stream in specs). */
  input: NodeJS.ReadableStream
  /** The terminal writer (injectable so specs can collect output). */
  write?: (text: string) => void
}): Tui => {
  const readline = createInterface({ input, terminal: false })
  let closed = false
  const eofRejectors = new Set<(error: Error) => void>()
  // With `terminal: false` readline delivers every buffered line regardless of
  // a pending question, so lines are consumed through an explicit queue
  // instead of `question()` (whose second call never sees buffered lines).
  const bufferedLines: string[] = []
  const lineWaiters: Array<(line: string) => void> = []

  readline.on('line', (line: string) => {
    const waiter = lineWaiters.shift()
    if (waiter === undefined) {
      bufferedLines.push(line)
    } else {
      waiter(line)
    }
  })

  readline.on('close', () => {
    closed = true
    for (const reject of eofRejectors) reject(new Error('tui stdin closed'))
    eofRejectors.clear()
  })

  /** Print `text`, resolve the next input line. */
  const askLine = (text: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('tui stdin closed'))
        return
      }
      write(text)
      const buffered = bufferedLines.shift()
      if (buffered !== undefined) {
        resolve(buffered)
        return
      }
      const rejectOnClose = (error: Error): void => {
        eofRejectors.delete(rejectOnClose)
        reject(error)
      }
      eofRejectors.add(rejectOnClose)
      lineWaiters.push((line) => {
        eofRejectors.delete(rejectOnClose)
        resolve(line)
      })
    })

  const emit = (text: string, color?: string): void => {
    const ansi = color === undefined ? '' : (Bun.color(color, 'ansi') ?? '')
    // Colors are presentation-only: resolved here at render time, never on
    // the wire, never on a prompt line (readline width math).
    write(ansi === '' ? `${text}\n` : `${ansi}${text}\x1b[0m\n`)
  }

  const prompt = async (text = '> '): Promise<BPEvent> => {
    for (;;) {
      const line = (await askLine(text)).trim()
      // A stray enter re-prompts; it carries no intent, so no event.
      if (line === '') continue
      return { type: TUI_COMMAND, detail: { line } }
    }
  }

  const select = async (question: string, options: string[]): Promise<BPEvent> => {
    for (;;) {
      write(`${question}\n`)
      options.forEach((option, index) => {
        write(`  ${index + 1}. ${option}\n`)
      })
      const line = (await askLine('> ')).trim()
      const choice = Number.parseInt(line, 10)
      if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
        return { type: TUI_SELECT, detail: { option: options[choice - 1]! } }
      }
      emit(`invalid choice: ${line}`, 'red')
    }
  }

  return {
    emit,
    prompt,
    select,
    close: () => {
      readline.close()
    },
  }
}
