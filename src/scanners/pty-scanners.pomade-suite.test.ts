// Pomade's unit suite for its pty scanners (src/main/pty-scanners.unit.test.ts), carried over
// unchanged except for the import path: the kit must behave exactly like Pomade's terminals.
//
// T-167 — isolated unit tests for the two chunk-split-safe pty output scanners extracted from
// PtyManager.create(). These state machines were previously reachable only through a live pty;
// here they are driven byte-by-byte and chunk-by-chunk. The BEL / OSC-notification semantics
// asserted below are the contract documented in docs/modules/agents/agent-providers.md
// (§"What Pomade detects"): a standalone BEL is attention (claude's idle bell / codex's unfocused
// bell), OSC 9·99·777 are attention, and window-title OSC 0·1·2 (which also end in BEL) plus our
// own OSC 7879 shim markers are NOT.

import { describe, expect, it } from 'vitest'
import { AttentionScanner, MarkerScanner, type MarkerEvent } from './pty-scanners.js'

const PREFIX = '\x1b]7879;'
const BEL = '\x07'
const marker = (payload: string): string => `${PREFIX}${payload}${BEL}`

/** Feed a MarkerScanner the given chunks in order and return every event it emitted. */
function runMarker(chunks: string[]): MarkerEvent[] {
  const events: MarkerEvent[] = []
  const scanner = new MarkerScanner((e) => events.push(e))
  for (const chunk of chunks) scanner.push(chunk)
  return events
}

/** Feed an AttentionScanner the given chunks in order and return the attention count. */
function countAttention(chunks: string[]): number {
  let n = 0
  const scanner = new AttentionScanner(() => n++)
  for (const chunk of chunks) scanner.push(chunk)
  return n
}

describe('MarkerScanner — classification', () => {
  it('classifies an exec marker, stripping the pomade:exec; name', () => {
    expect(runMarker([marker('pomade:exec;ls -la')])).toEqual([{ kind: 'exec', command: 'ls -la' }])
  })

  it('classifies a prompt marker carrying $PWD', () => {
    expect(runMarker([marker('pomade:prompt;/home/x/repo')])).toEqual([
      { kind: 'prompt', cwd: '/home/x/repo' }
    ])
  })

  it('classifies the payload-less prompt marker with cwd null', () => {
    expect(runMarker([marker('pomade:prompt')])).toEqual([{ kind: 'prompt', cwd: null }])
  })

  it('treats an empty-cwd prompt (pomade:prompt;) as cwd null (payload == prefix length)', () => {
    // `payload.length > MARK_PROMPT_CWD.length` is false here, so no cwd is reported — this is the
    // boundary that keeps a bare `;` from being emitted as an empty-string cwd.
    expect(runMarker([marker('pomade:prompt;')])).toEqual([{ kind: 'prompt', cwd: null }])
  })

  it('drops an unrecognised 7879 marker (neither exec nor prompt)', () => {
    expect(runMarker([marker('pomade:whatever;x')])).toEqual([])
  })

  it('preserves an exec command line with embedded semicolons and spaces', () => {
    expect(runMarker([marker('pomade:exec;git commit -m "a; b"')])).toEqual([
      { kind: 'exec', command: 'git commit -m "a; b"' }
    ])
  })
})

describe('MarkerScanner — interleaved sequences', () => {
  it('emits exec then prompt in byte order from a single chunk', () => {
    const data = marker('pomade:exec;claude') + 'some output\r\n' + marker('pomade:prompt;/tmp')
    expect(runMarker([data])).toEqual([
      { kind: 'exec', command: 'claude' },
      { kind: 'prompt', cwd: '/tmp' }
    ])
  })

  it('emits several markers back-to-back with no intervening bytes', () => {
    const data = marker('pomade:prompt;/a') + marker('pomade:exec;ls') + marker('pomade:prompt;/a')
    expect(runMarker([data])).toEqual([
      { kind: 'prompt', cwd: '/a' },
      { kind: 'exec', command: 'ls' },
      { kind: 'prompt', cwd: '/a' }
    ])
  })

  it('ignores ordinary output containing no markers', () => {
    expect(runMarker(['just a normal line of\r\nterminal output'])).toEqual([])
  })
})

describe('MarkerScanner — chunk-boundary splits (the core state machine)', () => {
  it('recognises a marker split across two chunks exactly once', () => {
    const full = marker('pomade:exec;npm run build')
    const at = 12 // inside the payload, after the prefix
    expect(runMarker([full.slice(0, at), full.slice(at)])).toEqual([
      { kind: 'exec', command: 'npm run build' }
    ])
  })

  it('recognises a marker whose split falls inside the OSC prefix itself', () => {
    const full = marker('pomade:prompt;/deep/dir')
    // Split after ESC ] 7 8 (3 bytes into the 7-byte prefix) — the carry must stitch the prefix
    // back together, since indexOf(PREFIX) cannot match a prefix straddling the boundary.
    expect(runMarker([full.slice(0, 3), full.slice(3)])).toEqual([
      { kind: 'prompt', cwd: '/deep/dir' }
    ])
  })

  it('recognises a marker split at every single byte boundary (fuzz over one marker)', () => {
    const full = marker('pomade:exec;deploy --prod')
    for (let at = 1; at < full.length; at++) {
      expect(runMarker([full.slice(0, at), full.slice(at)])).toEqual([
        { kind: 'exec', command: 'deploy --prod' }
      ])
    }
  })

  it('recognises a marker dribbled one byte per chunk', () => {
    const full = marker('pomade:prompt;/x')
    expect(runMarker([...full])).toEqual([{ kind: 'prompt', cwd: '/x' }])
  })

  it('carries a dangling prefix tail so a marker opening at the chunk end still fires', () => {
    // First chunk ends mid-prefix with no complete marker → nothing yet; the rest completes it.
    expect(runMarker(['output' + PREFIX.slice(0, 4), PREFIX.slice(4) + 'pomade:exec;x' + BEL])).toEqual(
      [{ kind: 'exec', command: 'x' }]
    )
  })

  it('holds an open marker (terminator not yet streamed) then completes it on the next chunk', () => {
    expect(runMarker([PREFIX + 'pomade:exec;sleep 5', BEL])).toEqual([
      { kind: 'exec', command: 'sleep 5' }
    ])
  })
})

describe('MarkerScanner — bounded carry (MARK_CARRY_MAX = 2048)', () => {
  it('keeps buffering an open marker up to the bound and completes it', () => {
    // A payload just within the bound (prefix 7 + payload < 2048) survives a split before its BEL.
    const payload = 'pomade:exec;' + 'a'.repeat(2000)
    expect(runMarker([PREFIX + payload, BEL])).toEqual([
      { kind: 'exec', command: 'a'.repeat(2000) }
    ])
  })

  it('drops an open marker once its unterminated length exceeds the bound', () => {
    // prefix + 3000 unterminated bytes → buf.length - start > 2048 → carry reset to ''. The BEL
    // that arrives next therefore closes nothing: the runaway sequence is discarded, not buffered
    // without bound.
    const events = runMarker([PREFIX + 'pomade:exec;' + 'a'.repeat(3000), 'tail' + BEL])
    expect(events).toEqual([])
  })

  it('resynchronises on the NEXT well-formed marker after a dropped runaway', () => {
    const events = runMarker([
      PREFIX + 'pomade:exec;' + 'a'.repeat(3000),
      'noise' + BEL,
      marker('pomade:prompt;/ok')
    ])
    expect(events).toEqual([{ kind: 'prompt', cwd: '/ok' }])
  })
})

describe('AttentionScanner — BEL semantics (agent-providers.md contract)', () => {
  it('raises attention on a standalone BEL (claude idle bell / codex unfocused bell)', () => {
    expect(countAttention([BEL])).toBe(1)
  })

  it('raises attention once per OSC 9 notification (iTerm2 style), not for its terminating BEL', () => {
    expect(countAttention(['\x1b]9;done' + BEL])).toBe(1)
  })

  it('raises attention on OSC 99 (kitty) and OSC 777 (urxvt/Ghostty/WezTerm)', () => {
    expect(countAttention(['\x1b]99;x' + BEL])).toBe(1)
    expect(countAttention(['\x1b]777;x' + BEL])).toBe(1)
  })

  it('does NOT raise attention on window/icon TITLE sequences OSC 0/1/2 (which end in BEL)', () => {
    expect(countAttention(['\x1b]0;my title' + BEL])).toBe(0)
    expect(countAttention(['\x1b]1;icon' + BEL])).toBe(0)
    expect(countAttention(['\x1b]2;window' + BEL])).toBe(0)
  })

  it('does NOT raise attention on our own OSC 7879 shim markers', () => {
    expect(countAttention([marker('pomade:prompt;/x'), marker('pomade:exec;ls')])).toBe(0)
  })

  it('accepts ST (ESC \\) as an OSC terminator — notify fires, title does not', () => {
    expect(countAttention(['\x1b]9;x\x1b\\'])).toBe(1)
    expect(countAttention(['\x1b]0;title\x1b\\'])).toBe(0)
  })

  it('counts a spurious ESC inside an OSC payload as payload, still terminating correctly', () => {
    // ESC not followed by \\ returns to the OSC body; the trailing BEL still closes OSC 9.
    expect(countAttention(['\x1b]9;a\x1bb' + BEL])).toBe(1)
  })
})

describe('AttentionScanner — interleaving and chunk splits', () => {
  it('separates standalone BELs from a title BEL in one stream', () => {
    // bell, then a title (its BEL ignored), then another bell → exactly 2.
    expect(countAttention(['a' + BEL + '\x1b]0;t' + BEL + 'b' + BEL])).toBe(2)
  })

  it('persists OSC state across a chunk boundary (sequence split mid-payload)', () => {
    expect(countAttention(['\x1b]9;', 'msg' + BEL])).toBe(1)
  })

  it('accumulates the OSC number across a chunk boundary (777 split as 7 | 77)', () => {
    expect(countAttention(['\x1b]7', '77;x' + BEL])).toBe(1)
  })

  it('keeps a title non-attention even when split across chunks', () => {
    expect(countAttention(['\x1b]0;long ', 'title here' + BEL])).toBe(0)
  })

  it('counts multiple standalone BELs dribbled one byte per chunk', () => {
    expect(countAttention([...(BEL + 'x' + BEL + 'y' + BEL)])).toBe(3)
  })

  it('does not miscount a 7879 shim marker split across chunks as attention', () => {
    const m = marker('pomade:prompt;/deep')
    const at = 5
    expect(countAttention([m.slice(0, at), m.slice(at)])).toBe(0)
  })
})
