/** Bounded reads of operator-owned local bridge inputs; errors never echo file contents or paths to a model. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export const MAX_CODEX_WATCHLIST_BYTES = 64 * 1024
export const MAX_CODEX_SNAPSHOT_BYTES = 1024 * 1024

export async function readPrivateText(path: string, maxBytes: number, kind: 'watchlist' | 'snapshot', signal: AbortSignal): Promise<string> {
  const invalid = () => new Error(`Codex ${kind} file is unavailable or invalid`)
  try {
    signal.throwIfAborted()
    // O_NOFOLLOW rejects a symlink at the final path component. The bridge should atomically replace a regular file.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw invalid()
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > maxBytes) throw invalid()
      return bytes.toString('utf8', 0, length)
    } finally { await handle.close() }
  } catch { throw signal.aborted ? new Error('Codex read cancelled') : invalid() }
}
