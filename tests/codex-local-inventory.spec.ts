import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listLocalCodexInventory } from '../src/codex/local-inventory.ts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-inventory-'))
  homes.push(home)
  return home
}

function rollout(home: string, directory: string, id: string, body = '{}\n'): string {
  const path = join(home, directory, '2026', '01', '02', `rollout-2026-01-02T03-04-05-${id}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  utimesSync(path, new Date('2023-01-01T00:00:00Z'), new Date('2023-01-01T00:00:00Z'))
  return path
}

function stateDatabase(home: string, columns: {
  id: string
  name?: string
  title?: string
  source?: string
  updated_at?: number
  parent?: string
}[]): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(`create table threads (id text primary key, name text, title text, source text not null,
    updated_at integer not null, attached_thread_parent_id text)`)
  const insert = db.prepare('insert into threads values (?, ?, ?, ?, ?, ?)')
  for (const row of columns) {
    insert.run(row.id, row.name ?? null, row.title ?? null, row.source ?? 'cli',
      row.updated_at ?? 1_700_000_000, row.parent ?? null)
  }
  db.close()
}

it('joins rollout files with the state database for main, subagent, and archived threads', async () => {
  const home = makeHome()
  rollout(home, 'sessions', '11111111-1111-4111-8111-111111111111')
  rollout(home, 'sessions', '22222222-2222-4222-8222-222222222222')
  rollout(home, 'archived_sessions', '33333333-3333-4333-8333-333333333333')
  stateDatabase(home, [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Main thread', source: 'cli', updated_at: 1_700_000_001 },
    { id: '22222222-2222-4222-8222-222222222222', title: 'Child thread', updated_at: 1_700_000_002,
      source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: '11111111-1111-4111-8111-111111111111' } } }) },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Archived thread', source: 'vscode', updated_at: 1_700_000_003 },
  ])

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads).toEqual([
    { id: '11111111-1111-4111-8111-111111111111', name: 'Main thread', updatedAt: '2023-11-14T22:13:21.000Z',
      archived: false, sourceKind: 'cli' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Child thread', updatedAt: '2023-11-14T22:13:22.000Z',
      archived: false, sourceKind: 'subAgentThreadSpawn', parentThreadId: '11111111-1111-4111-8111-111111111111' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Archived thread', updatedAt: '2023-11-14T22:13:23.000Z',
      archived: true, sourceKind: 'vscode' },
  ])
})

it('reports unknown source kind and the file mtime when the database has no row', async () => {
  const home = makeHome()
  const path = rollout(home, 'sessions', '44444444-4444-4444-8444-444444444444')
  stateDatabase(home, [{ id: '11111111-1111-4111-8111-111111111111', source: 'cli' }])

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads).toHaveLength(1)
  expect(threads[0]).toMatchObject({ id: '44444444-4444-4444-8444-444444444444', sourceKind: 'unknown' })
  expect(threads[0]!.updatedAt).toBe(new Date((await import('node:fs')).statSync(path).mtimeMs).toISOString())
  expect(threads[0]!.name).toBeUndefined()
})

it('keeps a thread that appears in both directories and marks it archived', async () => {
  const home = makeHome()
  rollout(home, 'sessions', '55555555-5555-4555-8555-555555555555')
  rollout(home, 'archived_sessions', '55555555-5555-4555-8555-555555555555')
  stateDatabase(home, [{ id: '55555555-5555-4555-8555-555555555555', source: 'exec' }])

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads).toHaveLength(1)
  expect(threads[0]).toMatchObject({ id: '55555555-5555-4555-8555-555555555555', archived: true, sourceKind: 'exec' })
})

it('uses the rollout mtime when a resumed thread has a stale database timestamp', async () => {
  const home = makeHome()
  const id = 'abababab-0000-4000-8000-000000000001'
  const path = rollout(home, 'sessions', id)
  stateDatabase(home, [{ id, source: 'vscode', updated_at: Date.parse('2026-10-01T00:00:00Z') / 1000 }])
  const resumed = new Date('2026-11-02T00:00:00Z')
  utimesSync(path, resumed, resumed)
  const [thread] = await listLocalCodexInventory(home, new AbortController().signal)
  expect(thread?.updatedAt).toBe(resumed.toISOString())
})

it('deduplicates two rollout files that carry the same thread ID', async () => {
  const home = makeHome()
  const directory = join(home, 'sessions', '2026', '01', '02')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'rollout-2026-01-02T03-04-05-12121212-1212-4121-8121-121212121212.jsonl'), '{}')
  writeFileSync(join(directory, 'rollout-2026-01-02T09-09-09-12121212-1212-4121-8121-121212121212.jsonl'), '{}')
  stateDatabase(home, [{ id: '12121212-1212-4121-8121-121212121212', source: 'cli' }])

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads).toHaveLength(1)
  expect(threads[0]).toMatchObject({ id: '12121212-1212-4121-8121-121212121212', archived: false, sourceKind: 'cli' })
})

it('normalizes every documented source string', async () => {
  const home = makeHome()
  const rows = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', source: 'cli' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', source: 'vscode' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', source: 'exec' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', source: '{"subagent":"review"}' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000005', source: '{"subagent":{"other":"guardian"}}' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000006', source: '{"subagent":{"thread_spawn":{"parent_thread_id":"bbbbbbbb-0000-4000-8000-000000000001"}}}' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000007', source: 'not-json' },
  ]
  for (const row of rows) rollout(home, 'sessions', row.id)
  stateDatabase(home, rows)

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads.map(thread => thread.sourceKind)).toEqual(['cli', 'vscode', 'exec', 'subAgentReview',
    'subAgentOther', 'subAgentThreadSpawn', 'unknown'])
  expect(threads[5]!.parentThreadId).toBe('bbbbbbbb-0000-4000-8000-000000000001')
})

it('ignores symlinked rollout files and rejects symlinked session roots', async () => {
  const home = makeHome()
  const outside = makeHome()
  rollout(outside, 'sessions', '66666666-6666-4666-8666-666666666666')
  rollout(home, 'sessions', '77777777-7777-4777-8777-777777777777')
  symlinkSync(join(outside, 'sessions', '2026', '01', '02',
    'rollout-2026-01-02T03-04-05-66666666-6666-4666-8666-666666666666.jsonl'),
  join(home, 'sessions', '2026', '01', '02', 'rollout-2026-01-02T03-04-05-88888888-8888-4888-8888-888888888888.jsonl'))
  stateDatabase(home, [])

  const threads = await listLocalCodexInventory(home, new AbortController().signal)
  expect(threads.map(thread => thread.id)).toEqual(['77777777-7777-4777-8777-777777777777'])

  const linkedRoot = makeHome()
  stateDatabase(linkedRoot, [])
  symlinkSync(join(outside, 'sessions'), join(linkedRoot, 'sessions'))
  await expect(listLocalCodexInventory(linkedRoot, new AbortController().signal)).rejects.toThrow('unsafe')
})

it('fails loudly when the state database is missing, damaged, or lacks the threads table', async () => {
  const home = makeHome()
  rollout(home, 'sessions', '99999999-9999-4999-8999-999999999999')

  await expect(listLocalCodexInventory(home, new AbortController().signal))
    .rejects.toThrow(/state database/)

  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('create table other (id text)')
  db.close()
  await expect(listLocalCodexInventory(home, new AbortController().signal))
    .rejects.toThrow(/threads table/)
})

it('fails loudly when the state database file is corrupt', async () => {
  const home = makeHome()
  rollout(home, 'sessions', '13131313-1313-4131-8131-131313131313')
  writeFileSync(join(home, 'state_5.sqlite'), 'this is not a sqlite database')
  await expect(listLocalCodexInventory(home, new AbortController().signal))
    .rejects.toThrow(/state database/)
})

it('rejects a cancelled scan', async () => {
  const home = makeHome()
  rollout(home, 'sessions', 'aaaaaaaa-0000-4000-8000-000000000009')
  const controller = new AbortController()
  controller.abort()
  await expect(listLocalCodexInventory(home, controller.signal)).rejects.toThrow(/cancelled/)
})
