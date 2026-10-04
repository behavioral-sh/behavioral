import { afterAll, describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { createTui, TUI_COMMAND, TUI_SELECT } from '../tui.ts'

/** A still-open readable whose buffered contents readline consumes line by line. */
const scriptInput = (lines: string[], end = false): Readable => {
  const stream = new Readable({ read() {} })
  for (const line of lines) stream.push(line)
  if (end) stream.push(null)
  return stream
}

const out: string[] = []

describe('createTui', () => {
  afterAll(() => {
    out.length = 0
  })

  describe('emit', () => {
    test('writes the line followed by a newline', () => {
      const written: string[] = []
      const tui = createTui({ input: scriptInput([]), write: (text) => written.push(text) })
      tui.emit('engine idle')
      expect(written).toEqual(['engine idle\n'])
      tui.close()
    })

    test('a color request is resolved through Bun.color and never touches the text', () => {
      const written: string[] = []
      const tui = createTui({ input: scriptInput([]), write: (text) => written.push(text) })
      tui.emit('deadlock', 'red')
      const rendered = written.join('')
      expect(rendered).toContain('deadlock')
      expect(rendered.endsWith('\n')).toBe(true)
      // The ansi format auto-detects stdout depth: degrade means the plain
      // line, support means the escape codes precede it.
      const ansi = Bun.color('red', 'ansi') ?? ''
      if (ansi === '') {
        expect(rendered).toBe('deadlock\n')
      } else {
        expect(rendered.startsWith(ansi)).toBe(true)
      }
      tui.close()
    })
  })

  describe('prompt', () => {
    test('a line of input resolves to a tui_command ingress event', async () => {
      const tui = createTui({ input: scriptInput(['/umwelt new docs\n']), write: (text) => out.push(text) })
      const event = await tui.prompt('behavioral> ')
      expect(event).toEqual({ type: TUI_COMMAND, detail: { line: '/umwelt new docs' } })
      tui.close()
    })

    test('an empty line re-prompts without producing an event; the next line resolves', async () => {
      const tui = createTui({ input: scriptInput(['\n', '/kick\n']), write: (text) => out.push(text) })
      const event = await tui.prompt()
      expect(event).toEqual({ type: TUI_COMMAND, detail: { line: '/kick' } })
      tui.close()
    })

    test('stdin closing while a prompt is pending rejects', async () => {
      const tui = createTui({ input: scriptInput([], true), write: (text) => out.push(text) })
      await tui.prompt().then(
        () => {
          throw new Error('expected the pending prompt to reject on EOF')
        },
        (error: unknown) => {
          expect((error as Error).message).toContain('closed')
        },
      )
      tui.close()
    })
  })

  describe('select', () => {
    test('a numbered choice resolves to a tui_select event for that option', async () => {
      const written: string[] = []
      const tui = createTui({ input: scriptInput(['2\n']), write: (text) => written.push(text) })
      const event = await tui.select('pick a umwelt', ['docs', 'harness', 'scratch'])
      expect(event).toEqual({ type: TUI_SELECT, detail: { option: 'harness' } })
      // The question and the numbered options were rendered before the input.
      expect(written.join('')).toContain('pick a umwelt')
      expect(written.join('')).toContain('1. docs')
      expect(written.join('')).toContain('3. scratch')
      tui.close()
    })

    test('an out-of-range choice reports and re-prompts; a later valid choice resolves', async () => {
      const written: string[] = []
      const tui = createTui({
        input: scriptInput(['9\n', 'not-a-number\n', '1\n']),
        write: (text) => written.push(text),
      })
      const event = await tui.select('pick a umwelt', ['docs', 'harness'])
      expect(event).toEqual({ type: TUI_SELECT, detail: { option: 'docs' } })
      expect(written.join('')).toContain('invalid choice: 9')
      expect(written.join('')).toContain('invalid choice: not-a-number')
      tui.close()
    })
  })
})
