import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * A tiny JSON-file store. Writes are atomic (temp file + rename) and serialised
 * so concurrent requests cannot corrupt the file.
 */
export class JsonStore<T> {
  private data: T
  private queue: Promise<void> = Promise.resolve()

  constructor(private file: string, private fallback: () => T) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8')) as T
      } catch {
        // keep the broken file for inspection and start fresh
        try { renameSync(file, `${file}.broken-${Date.now()}`) } catch { /* ignore */ }
        this.data = fallback()
      }
    } else {
      this.data = fallback()
      this.flushSync()
    }
  }

  get value(): T {
    return this.data
  }

  /** mutate in place then persist */
  update(fn: (draft: T) => void): void {
    fn(this.data)
    this.save()
  }

  replace(next: T): void {
    this.data = next
    this.save()
  }

  save(): void {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`
      await Bun.write(tmp, snapshot)
      renameSync(tmp, this.file)
    }).catch(err => console.error('[store] write failed', this.file, err))
  }

  flushSync(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  async idle(): Promise<void> {
    await this.queue
  }
}
