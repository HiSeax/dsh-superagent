import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/web/tokens.css', import.meta.url), 'utf8')

/** One top-level page function as a standalone expression, so its rules can run in a test harness. */
function pageFunctionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} is missing from src/web/app.js`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        return `(${source.slice(start, index + 1)})`
      }
    }
  }
  throw new Error(`${name} has no closing brace`)
}

/** Builds `orderedByLane` against a stubbed saved order. */
function orderedByLaneWith(order: Record<string, string[]>) {
  return new Function('readOrder', `return ${pageFunctionSource('orderedByLane')}`)(() => order) as
    (lane: string, rows: string[], idOf: (row: string) => string) => string[]
}

describe('card ordering', () => {
  it('applies a saved lane order and appends rows it does not know yet', () => {
    expect(orderedByLaneWith({ members: ['c', 'a'] })('members', ['a', 'b', 'c'], row => row)).toEqual(['c', 'a', 'b'])
  })

  it('keeps the feed order when the lane has no saved order', () => {
    expect(orderedByLaneWith({})('members', ['b', 'a'], row => row)).toEqual(['b', 'a'])
  })

  it('ignores a saved order that belongs to another lane', () => {
    expect(orderedByLaneWith({ 'bucket:active': ['y', 'x'] })('members', ['x', 'y'], row => row)).toEqual(['x', 'y'])
  })
})

describe('cards are whole, draggable blocks', () => {
  it('makes cards unselectable and gives them a drag cursor', () => {
    expect(css).toMatch(/\.card, \.ticket-row, \.temp-card \{[\s\S]*?user-select: none;/)
    expect(css).toContain('cursor: grab;')
    expect(css).toContain('.card.is-dragging, .ticket-row.is-dragging')
    expect(css).toContain('.drop-placeholder')
  })

  it('separates a press from a drag with a movement threshold', () => {
    expect(source).toContain('const DRAG_THRESHOLD = 5')
    expect(source).toContain('Math.hypot(dx, dy) < DRAG_THRESHOLD')
    expect(source).toContain('swallowClick = true')
  })

  it('marks the lane containers and gives every reorderable card an order key', () => {
    expect(source).toContain('<div class="team-members" data-lane="members">')
    expect(source).toContain('data-lane="bucket:${group.key}"')
    expect(source).toMatch(/data-order-key="\$\{escapeHtml\(row\.id\)\}"/)
    expect(source).toMatch(/data-ticket-id="\$\{escapeHtml\(ticket\.id\)\}" data-order-key="\$\{escapeHtml\(ticket\.id\)\}"/)
  })

  it('persists the order in the browser and reapplies it on render', () => {
    expect(source).toContain("const ORDER_KEY = 'board.order.v1'")
    expect(source).toContain('localStorage.setItem(ORDER_KEY')
    expect(source).toContain("orderedByLane('members'")
    expect(source).toContain("orderedByLane('bucket:' + group.key")
  })

  it('keeps keyboard reordering next to plain focus movement', () => {
    expect(source).toContain("event.key !== 'ArrowUp' && event.key !== 'ArrowDown'")
    expect(source).toContain('if (!event.altKey) { neighbour.focus(); return }')
    expect(source).toContain('saveOrder(lane.dataset.lane')
  })
})
