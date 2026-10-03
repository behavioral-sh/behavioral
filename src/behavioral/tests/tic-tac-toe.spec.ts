import { expect, test } from 'bun:test'
import { behavioral } from '../behavioral.ts'
import type { Idioms, JsonObject } from '../behavioral.types.ts'
import { onSelection } from './helpers.ts'

/** Author-facing thread arguments accepted by `addThread`. */
type ThreadArgs = { rules: Idioms[]; once?: true }

type WinningLine = [number, number, number]

/** Represents all possible winning combinations of squares in Tic-Tac-Toe. */
const winConditions: WinningLine[] = [
  //rows
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  // columns
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  // diagonals
  [0, 4, 8],
  [2, 4, 6],
]

/** An array representing all squares on the Tic-Tac-Toe board, indexed 0 through 8. */
const squares = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** Represents the current state of the Tic-Tac-Toe board, storing available squares. */
let board: Set<number>
/** Type definition for the detail payload of 'X' and 'O' events, indicating the chosen square. */
const onType = (type: string) => ({
  type,
})
const onMove = (player: 'X' | 'O', square?: number) => ({
  type: player,
  detailSchema:
    square === undefined
      ? ({
          type: 'object',
          properties: { square: { type: 'number' } },
          required: ['square'],
          additionalProperties: false,
        } as JsonObject)
      : ({
          type: 'object',
          properties: { square: { const: square } },
          required: ['square'],
          additionalProperties: false,
        } as JsonObject),
})
const onPlayerMoveIn = (player: 'X' | 'O', [a, b, c]: WinningLine) => ({
  type: player,
  detailSchema: {
    type: 'object' as const,
    properties: { square: { enum: [a, b, c] } },
    required: ['square'],
    additionalProperties: false,
  },
})

/**
 * Test case: Demonstrates the basic mechanism of taking a square.
 * It sets up a bProgram and uses feedback handlers (`addHandler`) to update the board state
 * when 'X' or 'O' events are triggered. This test verifies that triggering an event
 * correctly modifies the shared `board` state via the feedback mechanism.
 */
test('taking a square', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { trigger } = program

  // Initialize the board with all squares available for this test.
  board = new Set(squares)
  // Register feedback handlers to react to 'X' and 'O' events.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  // X takes square 1
  trigger({ type: 'X', detail: { square: 1 } })
  // Check if square 1 is removed from the board.
  expect(board.has(1)).toBe(false)
  // O takes square 0
  trigger({ type: 'O', detail: { square: 0 } })
  // Check if square 0 is removed from the board.
  expect(board.has(0)).toBe(false)
})

/**
 * A b-thread that enforces strict turn-taking between players 'X' and 'O'.
 * It waits for 'X', then blocks 'X' while waiting for 'O', and repeats.
 * Omitted `once` makes the thread loop indefinitely.
 */
const enforceTurns: ThreadArgs = {
  rules: [
    { waitFor: [onType('X')], block: [onType('O')] },
    { waitFor: [onType('O')], block: [onType('X')] },
  ],
}

/**
 * Test case: Verifies the `enforceTurns` b-thread correctly manages player turns.
 * It adds the `enforceTurns` thread to the bProgram.
 * Attempts to make 'O' take two turns in a row should fail due to the blocking mechanism.
 */
test('take turns', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  // Initialize the board.
  board = new Set(squares)
  // Add the turn-enforcing thread.
  // Register feedback handlers to update the board.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  // X takes square 1 (valid).
  trigger({ type: 'X', detail: { square: 1 } })
  expect(board.has(1)).toBe(false)
  // O takes square 0 (valid).
  trigger({ type: 'O', detail: { square: 0 } })
  expect(board.has(0)).toBe(false)
  // O attempts to take square 2 immediately (invalid, blocked by enforceTurns).
  trigger({ type: 'O', detail: { square: 2 } })
  // Check that square 2 is still available because O's second move was blocked.
  expect(board.has(2)).toBe(true)
})

/**
 * A collection of b-threads, one for each square, to prevent taking an already occupied square.
 * Each thread waits for any player ('X' or 'O') to take its specific square,
 * then blocks any further attempts to take that same square.
 */
const squaresTaken: Record<string, ThreadArgs> = {}
for (const square of squares) {
  squaresTaken[`(${square}) taken`] = {
    rules: [
      // Wait for an event (X or O) targeting this specific square.
      { waitFor: [onMove('X', square), onMove('O', square)] },
      // Once taken, block any future event targeting this square.
      { block: [onMove('X', square), onMove('O', square)] },
    ],
    once: true,
  }
}

/**
 * Test case: Verifies that the `squaresTaken` threads prevent players from choosing occupied squares.
 * It combines `enforceTurns` and `squaresTaken`.
 * An attempt by 'X' to take square 1 again after it's already taken should be blocked.
 * Because X's invalid move was blocked, it remains X's turn, preventing O's subsequent move.
 */
test('squares taken', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  // Initialize the board.
  board = new Set(squares)
  // Add threads for turn enforcement and preventing taking occupied squares.
  // Register feedback handlers.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  // X takes square 1 (valid).
  trigger({ type: 'X', detail: { square: 1 } })
  expect(board.has(1)).toBe(false)
  // O takes square 0 (valid).
  trigger({ type: 'O', detail: { square: 0 } })
  expect(board.has(0)).toBe(false)
  // X attempts to take square 1 again (invalid, blocked by squaresTaken[`(1) taken`]).
  trigger({ type: 'X', detail: { square: 1 } })
  // O attempts to take square 2 (invalid, blocked by enforceTurns because X's last move was blocked).
  trigger({ type: 'O', detail: { square: 2 } })
  expect(board.has(2)).toBe(true) // Square 2 remains available.
  // X takes square 2 (valid, as the previous invalid moves were blocked).
  trigger({ type: 'X', detail: { square: 2 } })
  expect(board.has(2)).toBe(false)
})

/** Type definition for the detail payload of the 'win' event. */
type Winner = { player: 'X' | 'O'; squares: number[] }

/**
 * Generates a set of b-threads to detect winning conditions for a specific player ('X' or 'O').
 * For each winning line defined in `winConditions`, it creates a thread that:
 * 1. Waits for the player to take the first square in that line.
 * 2. Waits for the player to take the second square in that line.
 * 3. Waits for the player to take the third square in that line.
 * 4. Requests a 'win' event, declaring the player and the winning line.
 * @param player - Player (`'X'` or `'O'`) for whom to detect wins.
 * @returns Record of b-threads, one for each potential winning line for the player.
 */
const detectWins = (player: 'X' | 'O') =>
  winConditions.reduce((acc: Record<string, ThreadArgs>, squares) => {
    acc[`${player}Wins (${squares})`] = {
      rules: [
        // Wait for the player to take the first square of this winning line.
        { waitFor: [onPlayerMoveIn(player, squares)] },
        // Wait for the player to take the second square of this winning line.
        { waitFor: [onPlayerMoveIn(player, squares)] },
        // Wait for the player to take the third square of this winning line.
        { waitFor: [onPlayerMoveIn(player, squares)] },
        // Request a 'win' event if all three squares are taken by the player.
        { request: { type: 'win', detail: { squares, player } } },
      ],
      once: true,
    }
    return acc
  }, {})

/**
 * Test case: Verifies that the `detectWins` threads correctly identify a winning condition.
 * It includes threads for turn enforcement, square occupation, and win detection for both players.
 * A sequence of moves leading to X winning along the top row [0, 1, 2] is simulated.
 */
test('detect winner', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('X'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('O'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  // Initialize the board.
  board = new Set(squares)
  // Add threads for game rules and win detection.
  /** Stores the winner information when a 'win' event occurs. */
  const winner: Winner | Record<string, unknown> = {}
  // Register feedback handlers, including one for the 'win' event.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'win') {
      const detail = selected.detail as Winner

      Object.assign(winner, detail)
    }
  })
  // Simulate moves leading to X winning.
  trigger({ type: 'X', detail: { square: 0 } })
  trigger({ type: 'O', detail: { square: 3 } })
  trigger({ type: 'X', detail: { square: 1 } })
  trigger({ type: 'O', detail: { square: 4 } })
  trigger({ type: 'X', detail: { square: 2 } }) // X completes the [0, 1, 2] line.
  // Verify that the 'win' event was triggered with the correct details.
  expect(winner).toEqual({ player: 'X', squares: [0, 1, 2] })
})

/**
 * A b-thread that stops the game once a 'win' event occurs.
 * It waits for the 'win' event and then blocks any further 'X' or 'O' moves indefinitely.
 */
const stopGame: ThreadArgs = {
  rules: [{ waitFor: [onType('win')] }, { block: [onType('X'), onType('O')] }],
}

/**
 * Test case: Verifies that the `stopGame` thread prevents further moves after a win.
 * It includes all previous rule threads plus `stopGame`.
 * After X wins, an attempt by O to make another move should be blocked.
 */
test('stop game', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('X'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('O'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  addThread({ name: 'stopGame', description: 'Test thread.', ...stopGame })
  // Initialize the board.
  board = new Set(squares)
  // Add all game rule threads, including the one to stop the game on win.
  const winner: Winner | Record<string, unknown> = {}
  // Register feedback handlers.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'win') {
      const detail = selected.detail as Winner

      Object.assign(winner, detail)
    }
  })
  // Simulate moves leading to X winning.
  trigger({ type: 'X', detail: { square: 0 } })
  trigger({ type: 'O', detail: { square: 3 } })
  trigger({ type: 'X', detail: { square: 1 } })
  trigger({ type: 'O', detail: { square: 4 } })
  trigger({ type: 'X', detail: { square: 2 } }) // X wins.
  expect(winner).toEqual({ player: 'X', squares: [0, 1, 2] })
  // O attempts to take square 5 after the game has ended (invalid, blocked by stopGame).
  trigger({ type: 'O', detail: { square: 5 } })
  // Verify square 5 is still available because O's move was blocked.
  expect(board.has(5)).toBe(true)
})

/**
 * A collection of b-threads representing default moves for player 'O'.
 * Each thread requests to take a specific square ('O' move) and repeats indefinitely.
 * These act as low-priority suggestions for O's moves.
 */
const defaultMoves: Record<string, ThreadArgs> = {}
for (const square of squares) {
  defaultMoves[`defaultMoves(${square})`] = {
    rules: [
      {
        request: {
          type: 'O',
          detail: { square },
        },
      },
    ],
  }
}

/**
 * Test case: Demonstrates the use of default moves for player 'O'.
 * When it's O's turn, and no higher-priority strategy dictates a move,
 * one of the `defaultMoves` threads will have its request selected.
 * The specific square chosen depends on internal priority and blocking.
 */
test('defaultMoves', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('X'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('O'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  addThread({ name: 'stopGame', description: 'Test thread.', ...stopGame })
  for (const [key, threadArgs] of Object.entries(defaultMoves)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  // Initialize the board.
  board = new Set(squares)
  // Add game rules and default moves for O.

  // Register feedback handlers.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  // X takes square 0.
  trigger({ type: 'X', detail: { square: 0 } })
  // Now it's O's turn. Since no specific strategy applies yet, a default move is made.
  // The exact square taken by O (e.g., 1) depends on the implicit priority of the default move threads.
  expect(board.has(1)).toBe(false) // Assuming default move for square 1 gets selected first.
})

/**
 * A b-sync definition representing a strategy for player 'O' to start by taking the center square (4).
 * This is a single, high-priority request.
 */
const startAtCenter: ThreadArgs = {
  rules: [
    {
      request: {
        type: 'O',
        detail: { square: 4 },
      },
    },
  ],
  once: true,
}

/**
 * Test case: Demonstrates overriding default moves with a specific strategy.
 * The `startAtCenter` strategy is added with higher priority (implicitly, by being added later or explicitly)
 * than the `defaultMoves`. When it's O's first turn, `startAtCenter` should be selected over any default move.
 */
test('start at center', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('X'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('O'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  addThread({ name: 'stopGame', description: 'Test thread.', ...stopGame })
  addThread({ name: 'startAtCenter', description: 'Test thread.', ...startAtCenter })
  for (const [key, threadArgs] of Object.entries(defaultMoves)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  // Initialize the board.
  board = new Set(squares)
  // Add game rules, the center strategy, and default moves.
  // `startAtCenter` likely has higher priority due to registration order or could be set explicitly.

  // Register feedback handlers.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  // X takes square 0.
  trigger({ type: 'X', detail: { square: 0 } })
  // Now it's O's turn. The `startAtCenter` strategy should be selected.
  expect(board.has(4)).toBe(false) // Verify O took the center square.
})

/**
 * Generates b-threads for player 'O' to block player 'X' from winning.
 * For each potential winning line:
 * 1. Waits for 'X' to take two squares in that line.
 * 2. Requests an 'O' move to take the remaining empty square in that line, thus blocking 'X'.
 * @returns Record of b-threads, one for each potential winning line, designed to block X.
 */
const preventCompletionOfLineWithTwoXs = () => {
  const bThreads: Record<string, ThreadArgs> = {}
  for (const win of winConditions) {
    const [a, b, c] = win
    bThreads[`StopXWin(${win})-ab`] = {
      rules: [
        { waitFor: [onMove('X', a)] },
        { waitFor: [onMove('X', b)] },
        { request: { type: 'O', detail: { square: c } } },
      ],
      once: true,
    }
    bThreads[`StopXWin(${win})-ac`] = {
      rules: [
        { waitFor: [onMove('X', a)] },
        { waitFor: [onMove('X', c)] },
        { request: { type: 'O', detail: { square: b } } },
      ],
      once: true,
    }
    bThreads[`StopXWin(${win})-bc`] = {
      rules: [
        { waitFor: [onMove('X', b)] },
        { waitFor: [onMove('X', c)] },
        { request: { type: 'O', detail: { square: a } } },
      ],
      once: true,
    }
  }
  return bThreads
}

/**
 * Test case: Verifies the 'preventCompletionOfLineWithTwoXs' strategy.
 * This test sets up a scenario where 'X' is about to win on line [6, 7, 8].
 * The blocking strategy for 'O' should detect this and request 'O' take square 7.
 * It combines all previous rules with this blocking strategy.
 */
test('prevent completion of line with two Xs', () => {
  // Create a new bProgram instance.
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'enforceTurns', description: 'Test thread.', ...enforceTurns })
  for (const [key, threadArgs] of Object.entries(squaresTaken)) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('X'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  for (const [key, threadArgs] of Object.entries(detectWins('O'))) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  addThread({ name: 'stopGame', description: 'Test thread.', ...stopGame })
  addThread({ name: 'startAtCenter', description: 'Test thread.', ...startAtCenter })
  for (const [key, threadArgs] of Object.entries(preventCompletionOfLineWithTwoXs())) {
    addThread({ name: key, description: 'Test thread.', ...threadArgs })
  }
  // Initialize the board.
  board = new Set(squares)
  // Add all game rules, including the blocking strategy for O.
  const winner: Winner | Record<string, unknown> = {}
  // Register feedback handlers with specific types for clarity.
  onSelection(program, (selected) => {
    if (selected.type === 'X') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'O') {
      const { square } = selected.detail as { square: number }

      board.delete(square)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'win') {
      const detail = selected.detail as Winner

      Object.assign(winner, detail)
    }
  })
  // Simulate moves:
  trigger({ type: 'X', detail: { square: 2 } })
  trigger({ type: 'O', detail: { square: 4 } })
  trigger({ type: 'X', detail: { square: 6 } })
  trigger({ type: 'O', detail: { square: 0 } })
  trigger({ type: 'X', detail: { square: 8 } }) // X has 6 and 8. O MUST block at 7.
  trigger({ type: 'O', detail: { square: 7 } })
  // X takes 5, completing the line [2, 5, 8] and winning.
  trigger({ type: 'X', detail: { square: 5 } })
  // Verify X won with the expected line.
  expect(winner).toEqual({ player: 'X', squares: [2, 5, 8] })
})
