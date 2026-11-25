import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'trading-desk',
  component: 'Pane',
  requestId: 'trading-desk',
  props: { title: 'AI Trading Desk', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('every tab draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const has = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
    expect(await has(/Practice money/)).toBe(true)
    expect(await has(/What the team thinks/)).toBe(true)
    expect(await has(/Your Liquid account/)).toBe(true)
    await ui.press({ key: 'tab-charts' })
    expect(await has(/What matters right now/)).toBe(true)
    await ui.press({ key: 'coin-ETH' })
    expect(await has(/The desk on ETH/)).toBe(true)
    await ui.press({ key: 'tab-office' })
    expect(await has(/Trading floor/)).toBe(true)
    expect(await has(/Research AI/)).toBe(true)
    await ui.press({ key: 'tab-team' })
    expect(await has(/Agent team · 13/)).toBe(true)
    expect(await has(/Head AI/)).toBe(true)
    await ui.press({ key: 'tab-updates' })
    expect(await has(/How to get better/)).toBe(true)
    expect(await has(/Brainstorm/)).toBe(true)
    expect(await has(/Plugin Scout/)).toBe(true)
    expect(await has(/what the team is learning/)).toBe(true)
    await ui.press({ key: 'tab-activity' })
    expect(await has(/Recent activity/)).toBe(true)
    await ui.press({ key: 'tab-settings' })
    expect(await has(/How often to check/)).toBe(true)
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})
