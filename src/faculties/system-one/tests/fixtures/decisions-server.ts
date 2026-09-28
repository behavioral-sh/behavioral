/**
 * In-process System One (Decisions) endpoint over loopback HTTP (Bun.serve),
 * mirroring the TypeSafe `/v1/systemone` contract: `{ state, model, questions }`
 * in, `{ model, answers, usage }` out. Answers are canned by question type.
 *
 * Every request (path, authorization header, parsed body) is recorded in
 * `requests` for routing/auth assertions. `apiKey` turns on bearer auth;
 * `rateLimitFirst` emits that many `429 Too Many Requests` (with `retry-after`)
 * before succeeding; `delayMs` delays each successful response.
 */

export const DECISIONS_MODEL = 'jev-1.13.0'

type Question = { type: string; instructions: unknown; criteria?: unknown }

const answerFor = (question: Question, index: number, pickChoice?: string): unknown => {
  if (question.type === 'noul') return { type: 'noul', noul: 0.9 }
  if (question.type === 'choice') {
    const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
    // `pickChoice` overrides the canned first-option answer (the rejection
    // path needs a server that answers reject).
    const choice = pickChoice !== undefined && options.includes(pickChoice) ? pickChoice : (options[0] ?? 'unknown')
    const probabilities = Object.fromEntries(
      options.map((o) => [o, o === choice ? 0.7 : 0.3 / Math.max(options.length - 1, 1)]),
    )
    return {
      type: 'choice',
      choice,
      probabilities,
      confidence: 0.81,
    }
  }
  const levels = (question.criteria ?? []) as unknown[]
  const legend = Object.fromEntries(levels.map((_, i) => [String(i), `level ${i}`]))
  const probabilities = Object.fromEntries(
    levels.map((_, i) => [String(i), i === 0 ? 0.8 : 0.2 / Math.max(levels.length - 1, 1)]),
  )
  return { type: 'score', score: 0.5 + index * 0.1, legend, probabilities, confidence: 0.9 }
}

export type RecordedDecisionRequest = {
  path: string
  auth: string | null
  body: { state?: unknown; model?: string; questions?: Record<string, Question> }
}

export type DecisionsFixture = {
  url: string
  requests: RecordedDecisionRequest[]
  close: () => Promise<void>
}

export const startDecisionsServer = async ({
  apiKey,
  rateLimitFirst = 0,
  delayMs = 0,
  pickChoice,
}: {
  apiKey?: string
  rateLimitFirst?: number
  delayMs?: number
  /** Override the canned choice answer (e.g. `'reject'` for the judgment's rejection path). */
  pickChoice?: string
} = {}): Promise<DecisionsFixture> => {
  const requests: RecordedDecisionRequest[] = []
  let rateLimited = 0

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { pathname } = new URL(req.url)
      let body: RecordedDecisionRequest['body'] = {}
      try {
        body = (await req.json()) as RecordedDecisionRequest['body']
      } catch {
        body = {}
      }
      requests.push({ path: pathname, auth: req.headers.get('authorization'), body })

      if (apiKey && req.headers.get('authorization') !== `Bearer ${apiKey}`) {
        return Response.json({ error: { code: 'invalid_api_key', message: 'bad key' } }, { status: 401 })
      }
      if (rateLimited < rateLimitFirst) {
        rateLimited += 1
        return Response.json(
          { error: { code: 'rate_limited', message: 'slow down' } },
          { status: 429, headers: { 'retry-after': '0' } },
        )
      }
      if (typeof body.model !== 'string' || body.model.length === 0) {
        return Response.json({ error: { code: 'invalid_request', message: 'model is required' } }, { status: 422 })
      }
      if (delayMs > 0) await Bun.sleep(delayMs)

      const questions = body.questions ?? {}
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question], index) => [id, answerFor(question, index, pickChoice)]),
      )
      return Response.json({
        model: DECISIONS_MODEL,
        answers,
        usage: { input_tokens: 296, output_tokens: 20 },
      })
    },
  })

  return {
    url: `${server.url}v1/systemone`,
    requests,
    close: (): Promise<void> => server.stop(true),
  }
}
