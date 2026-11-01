// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, text } from './fixtures/panel.tsx'

usePanel()
it('shows the Codex read-only trial in the DSH panel without implying live control', async () => {
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('pnpm codex:local')
  expect(text()).toContain('无法证明 Codex Desktop 此刻的运行状态')
  expect(text()).toContain('当前只读试验没有控制接口')
})
