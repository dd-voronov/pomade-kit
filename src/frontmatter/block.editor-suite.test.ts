// Pomade's editor suite for the block core (src/renderer/modules/editor/frontmatter-edit.unit.test.ts),
// carried over unchanged except for the import path (and one `?.` for strict indexing): the kit
// must behave exactly like the editor.

import { describe, expect, it } from 'vitest'
import {
  addProperty,
  emitScalar,
  getKeyLines,
  moveKey,
  parseFrontmatter,
  removeProperty,
  setBooleanValue,
  setComplexKeyLines,
  setListValue,
  setScalarValue,
  validateYaml
} from './block.js'

describe('parseFrontmatter — classification', () => {
  it('classifies string, number, boolean, date, list, and complex rows', () => {
    const block = [
      '---',
      'title: Hello',
      'count: 3',
      'done: true',
      'due: 2026-06-15',
      'tags:',
      '  - a',
      '  - b',
      'meta:',
      '  nested: yes',
      '---',
      ''
    ].join('\n')
    const { ok, rows } = parseFrontmatter(block)
    expect(ok).toBe(true)
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey.title).toMatchObject({ type: 'string', scalar: 'Hello' })
    expect(byKey.count).toMatchObject({ type: 'number', scalar: '3' })
    expect(byKey.done).toMatchObject({ type: 'boolean', bool: true })
    expect(byKey.due).toMatchObject({ type: 'date', scalar: '2026-06-15' })
    expect(byKey.tags).toMatchObject({ type: 'list', list: ['a', 'b'], isTags: true })
    expect(byKey.meta).toMatchObject({ type: 'complex', editable: false })
  })

  it('unparseable YAML → ok:false, no rows (never throws, caller falls back to raw)', () => {
    const block = '---\nfoo: [unterminated\n---\n'
    expect(parseFrontmatter(block)).toEqual({ ok: false, rows: [] })
  })

  it('a top-level scalar document (not a map) → ok:false raw fallback', () => {
    const block = '---\njust a string\n---\n'
    expect(parseFrontmatter(block).ok).toBe(false)
  })

  it('a block missing the closing delimiter → ok:false', () => {
    expect(parseFrontmatter('---\ntitle: x\n').ok).toBe(false)
  })

  it('an empty frontmatter body (blank inner line) parses to zero rows, ok:true', () => {
    expect(parseFrontmatter('---\n\n---\n')).toEqual({ ok: true, rows: [] })
  })

  // Edge case not previously exercised: a multiline (block-scalar) string value must be
  // classified complex/¶, distinct from a nested-map complex/{} — the picker renders a
  // different glyph for each.
  it('a multiline block-scalar string is complex with the ¶ glyph (not {} like a map)', () => {
    const block = ['---', 'summary: |', '  line one', '  line two', '---', ''].join('\n')
    const { rows } = parseFrontmatter(block)
    const row = rows.find((r) => r.key === 'summary')!
    expect(row.type).toBe('complex')
    expect(row.complexGlyph).toBe('¶')
  })

  it('a quoted key is unquoted for row.key and lookup', () => {
    const block = '---\n"weird key": 1\n---\n'
    const { rows } = parseFrontmatter(block)
    expect(rows[0]?.key).toBe('weird key')
  })
})

describe('setScalarValue — byte-identical elsewhere, only target line changes', () => {
  const block = ['---', 'title: Old', 'count: 3 # keep', '---', '\n'].join('\n')

  it('rewrites only the target key, preserving an inline comment and other keys verbatim', () => {
    const out = setScalarValue(block, 'title', 'New')
    expect(out).toBe(['---', 'title: New', 'count: 3 # keep', '---', '\n'].join('\n'))
  })

  it('preserves a trailing inline comment on the line being edited', () => {
    const out = setScalarValue(block, 'count', '9')
    expect(out).toContain('count: 9 # keep')
  })

  it('an empty new value clears the scalar but keeps the comment', () => {
    const out = setScalarValue(block, 'count', '')
    expect(out).toContain('count: # keep')
  })

  it('an unknown key returns the block unchanged', () => {
    expect(setScalarValue(block, 'missing', 'x')).toBe(block)
  })

  it('a malformed block (no closing ---) returns the block unchanged', () => {
    const bad = '---\ntitle: x\n'
    expect(setScalarValue(bad, 'title', 'y')).toBe(bad)
  })
})

describe('emitScalar — plain vs quoted', () => {
  const cases: [name: string, input: string, expected: string][] = [
    ['plain word stays unquoted', 'hello', 'hello'],
    ['leading dash forces quoting (would parse as YAML list marker)', '-nope', JSON.stringify('-nope')],
    ['embedded "key: value" colon forces quoting', 'a: b', JSON.stringify('a: b')],
    ['inline-comment-looking value forces quoting', 'a #b', JSON.stringify('a #b')],
    ['value with surrounding whitespace forces quoting', ' x ', JSON.stringify(' x ')],
    ['empty string forces quoting', '', JSON.stringify('')]
  ]
  it.each(cases)('%s', (_name, input, expected) => {
    expect(emitScalar(input)).toBe(expected)
  })
})

describe('setBooleanValue', () => {
  it('writes true/false as plain (unquoted) scalars', () => {
    const block = '---\ndone: false\n---\n'
    expect(setBooleanValue(block, 'done', true)).toBe('---\ndone: true\n---\n')
  })
})

describe('setListValue', () => {
  it('rewrites a flow list [a, b] preserving flow style', () => {
    const block = '---\ntags: [a, b]\n---\n'
    expect(setListValue(block, 'tags', ['c', 'd'])).toBe('---\ntags: [c, d]\n---\n')
  })

  it('rewrites a block list preserving the existing item indent', () => {
    const block = ['---', 'tags:', '    - a', '    - b', '---', ''].join('\n')
    const out = setListValue(block, 'tags', ['c'])
    expect(out).toBe(['---', 'tags:', '    - c', '---', ''].join('\n'))
  })

  it('an empty items array collapses to flow form []', () => {
    const block = ['---', 'tags:', '  - a', '---', ''].join('\n')
    const out = setListValue(block, 'tags', [])
    expect(out).toBe(['---', 'tags: []', '---', ''].join('\n'))
  })
})

describe('addProperty', () => {
  it('creates a fresh frontmatter block when none exists', () => {
    expect(addProperty('', 'title', 'Hi')).toBe('---\ntitle: Hi\n---\n\n')
  })

  it('appends after the last non-blank inner line, not after trailing blanks', () => {
    const block = ['---', 'title: Hi', '', '---', ''].join('\n')
    const out = addProperty(block, 'count', '1')
    expect(out).toBe(['---', 'title: Hi', 'count: 1', '---', ''].join('\n'))
  })

  it('quotes a key that would otherwise be ambiguous YAML', () => {
    expect(addProperty('', 'a:b', 'x')).toBe(`---\n${JSON.stringify('a:b')}: x\n---\n\n`)
  })
})

describe('moveKey — reorders whole key-spans, leaves each span byte-identical', () => {
  const block = ['---', 'a: 1', 'b: 2', '# a comment', 'c: 3', '---', ''].join('\n')

  it('moves a key before another, standalone comment stays attached to its following key', () => {
    const out = moveKey(block, 'c', 'a')
    expect(out).toBe(['---', 'c: 3', 'a: 1', 'b: 2', '# a comment', '---', ''].join('\n'))
  })

  it('moves a key to the end when beforeKey is null', () => {
    const out = moveKey(block, 'a', null)
    expect(out).toBe(['---', 'b: 2', '# a comment', 'c: 3', 'a: 1', '---', ''].join('\n'))
  })

  it('an unknown source key returns the block unchanged', () => {
    expect(moveKey(block, 'zzz', 'a')).toBe(block)
  })

  // Edge case not previously exercised: beforeKey pointing at a key that does not exist behaves
  // like null (append to end) rather than silently dropping the moved key.
  it('an unknown beforeKey falls back to appending at the end', () => {
    const out = moveKey(block, 'a', 'zzz')
    expect(out).toBe(['---', 'b: 2', '# a comment', 'c: 3', 'a: 1', '---', ''].join('\n'))
  })
})

describe('getKeyLines / setComplexKeyLines round-trip', () => {
  it('getKeyLines returns the exact key + continuation lines', () => {
    const block = ['---', 'meta:', '  a: 1', '  b: 2', '---', ''].join('\n')
    expect(getKeyLines(block, 'meta')).toBe('meta:\n  a: 1\n  b: 2')
  })

  it('setComplexKeyLines splices replacement text in verbatim', () => {
    const block = ['---', 'meta:', '  a: 1', '---', ''].join('\n')
    const out = setComplexKeyLines(block, 'meta', 'meta:\n  z: 9')
    expect(out).toBe(['---', 'meta:', '  z: 9', '---', ''].join('\n'))
  })
})

describe('validateYaml', () => {
  it('accepts a mapping', () => {
    expect(validateYaml('a: 1')).toBeNull()
  })

  it('rejects a bare scalar with a descriptive message', () => {
    expect(validateYaml('just text')).toBe('Expected a property (key: value)')
  })

  it('rejects unparseable YAML with the parser error message', () => {
    expect(validateYaml('a: [unterminated')).not.toBeNull()
  })

  it('rejects a top-level list', () => {
    expect(validateYaml('- a\n- b')).toBe('Expected a property (key: value)')
  })
})

describe('removeProperty', () => {
  it('removes a single key, keeps the rest intact', () => {
    const block = ['---', 'a: 1', 'b: 2', '---', ''].join('\n')
    expect(removeProperty(block, 'a')).toBe(['---', 'b: 2', '---', ''].join('\n'))
  })

  it('removing the last remaining key drops the entire frontmatter block', () => {
    const block = ['---', 'a: 1', '---', ''].join('\n')
    expect(removeProperty(block, 'a')).toBe('')
  })

  it('an unknown key returns the block unchanged', () => {
    const block = ['---', 'a: 1', '---', ''].join('\n')
    expect(removeProperty(block, 'zzz')).toBe(block)
  })
})
