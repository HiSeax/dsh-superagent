/**
 * E2E for the board's card contract: cards are whole unselectable blocks, a drag with a threshold reorders a lane,
 * the order survives a reload, a press without movement stays a click, and Alt+Arrow reorders from the keyboard.
 *
 * Usage: node tests/e2e-board-cards.mjs --url http://127.0.0.1:18096
 * The one-time token comes from BOARD_TOKEN in the environment or the file named by --token-file; it never
 * travels in a command-line argument. Playwright resolves from PLAYWRIGHT_ROOT when the repository keeps it
 * out of its own dependencies.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const url = option('url')
const tokenFile = option('token-file')
const token = process.env.BOARD_TOKEN ?? (tokenFile === undefined ? undefined : readFileSync(tokenFile, 'utf8').trim())
if (!url || !token) {
  console.error('usage: node tests/e2e-board-cards.mjs --url <base> --token-file <file> (or BOARD_TOKEN)')
  process.exit(2)
}
const require = createRequire(`${process.env.PLAYWRIGHT_ROOT ?? process.cwd()}\\`)
const { chromium } = require('playwright')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` :: ${detail}`}`)
  if (!ok) failures += 1
}

/** Drags `from` to the middle of `to` and returns nothing; the pointer must travel past the 5 px threshold. */
async function dragCard(page, from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (a === null || b === null) throw new Error('a card has no box')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 4 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 10, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}

const laneIds = (page, selector) => page.$$eval(selector, nodes => nodes.map(node => node.dataset.orderKey))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`))

try {
  await page.goto(`${url}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${url}/superagent-board/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tickets .ticket-row', { timeout: 30000 })
  await page.evaluate(() => localStorage.removeItem('board.order.v1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tickets .ticket-row', { timeout: 30000 })
  // The roster arrives from its own 3 s poll: wait for real member cards instead of assuming they are already there.
  await page.waitForSelector('.team-members[data-lane="members"] .card', { timeout: 30000 })

  const selectOfRow = await page.$eval('.ticket-row', node => getComputedStyle(node).userSelect)
  const selectOfCard = await page.$eval('.card', node => getComputedStyle(node).userSelect)
  check('ticket row is not selectable text', selectOfRow === 'none', `user-select=${selectOfRow}`)
  check('member card is not selectable text', selectOfCard === 'none', `user-select=${selectOfCard}`)

  // A press that does not move stays a click: the detail panel opens for that ticket.
  await page.click('#tickets .ticket-row')
  await page.waitForTimeout(200)
  const detailOpen = await page.$eval('#detail', node => !node.hidden)
  check('a press without movement still selects', detailOpen === 'true' || detailOpen === true)

  // Reorder inside one ticket lane.
  const laneSelector = '#tickets .group[data-lane]'
  const lane = await page.evaluateHandle(selector => {
    const groups = Array.from(document.querySelectorAll(selector))
    return groups.find(group => group.querySelectorAll('.ticket-row').length >= 2) ?? null
  }, laneSelector)
  const laneElement = lane.asElement()
  check('a ticket lane with two cards exists', laneElement !== null)
  if (laneElement !== null) {
    const before = await laneElement.evaluate(node => Array.from(node.querySelectorAll('.ticket-row')).map(row => row.dataset.orderKey))
    const rows = await laneElement.$$('.ticket-row')
    await dragCard(page, rows[0], rows[1])
    const after = await laneElement.evaluate(node => Array.from(node.querySelectorAll('.ticket-row')).map(row => row.dataset.orderKey))
    check('dragging a ticket card changes the lane order', before[0] === after[1] && before[1] === after[0], `${before.slice(0, 2)} -> ${after.slice(0, 2)}`)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('board.order.v1') ?? '{}'))
    const laneKey = await laneElement.evaluate(node => node.dataset.lane)
    check('the new order is persisted', Array.isArray(stored[laneKey]) && stored[laneKey][0] === after[0], JSON.stringify(stored[laneKey]?.slice(0, 2)))

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#tickets .ticket-row', { timeout: 30000 })
    await page.waitForSelector('.team-members[data-lane="members"] .card', { timeout: 30000 })
    const reloaded = await page.$$eval(`${laneSelector}[data-lane="${laneKey}"] .ticket-row`, nodes => nodes.map(node => node.dataset.orderKey))
    check('the order survives a reload', reloaded[0] === after[0] && reloaded[1] === after[1], `${reloaded.slice(0, 2)}`)
  }

  // Member cards reorder inside the members lane and keep the edge layer.
  const members = await page.$$('.team-members[data-lane="members"] .card')
  check('the members lane has two cards', members.length >= 2, `cards=${members.length}`)
  if (members.length >= 2) {
    const before = await page.$$eval('.team-members[data-lane="members"] .card', nodes => nodes.map(node => node.dataset.orderKey))
    await dragCard(page, members[0], members[1])
    const after = await page.$$eval('.team-members[data-lane="members"] .card', nodes => nodes.map(node => node.dataset.orderKey))
    check('dragging a member card changes the order', before[0] === after[1] && before[1] === after[0], `${before.slice(0, 2)} -> ${after.slice(0, 2)}`)
    const edges = await page.$$eval('.team-edges path', nodes => nodes.length)
    check('the edge layer is still drawn', edges > 0, `paths=${edges}`)
  }

  // Keyboard: focus walks the lane, Alt+Arrow moves the card and saves.
  const firstRow = await page.evaluateHandle(() => {
    const rows = Array.from(document.querySelectorAll('#tickets .group[data-lane]'))
      .find(group => group.querySelectorAll('.ticket-row').length >= 2)?.querySelectorAll('.ticket-row')
    return rows === undefined ? null : rows[0]
  })
  const firstRowElement = firstRow.asElement()
  if (firstRowElement !== null) {
    await firstRowElement.focus()
    const laneKey = await firstRowElement.evaluate(node => node.parentElement?.dataset.lane)
    const before = await page.$$eval(`#tickets .group[data-lane="${laneKey}"] .ticket-row`, nodes => nodes.map(node => node.dataset.orderKey))
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(120)
    const after = await page.$$eval(`#tickets .group[data-lane="${laneKey}"] .ticket-row`, nodes => nodes.map(node => node.dataset.orderKey))
    check('Alt+ArrowDown reorders from the keyboard', before[0] === after[1] && before[1] === after[0], `${before.slice(0, 2)} -> ${after.slice(0, 2)}`)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('board.order.v1') ?? '{}'))
    check('the keyboard order is persisted', stored[laneKey]?.[0] === after[0], JSON.stringify(stored[laneKey]?.slice(0, 2)))
  }

  check('no console error or page error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? 'board-cards-e2e.png', fullPage: false })
} catch (error) {
  check('e2e completed without throwing', false, String(error && error.message).slice(0, 300))
} finally {
  await browser.close()
}

console.log(failures === 0 ? 'E2E_OK' : `E2E_FAILED checks=${failures}`)
process.exit(failures === 0 ? 0 : 1)
