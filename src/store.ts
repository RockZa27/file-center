import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { log } from './logger'

/**
 * A tiny JSON-file store. Writes are atomic (temp file + rename) and serialised
 * so concurrent requests cannot corrupt the file.
 */
export class JsonStore<T> {
  private static all = new Set<JsonStore<any>>()

  /** wait until every store has written what it was asked to (before the process exits) */
  static async flushAll(): Promise<void> {
    await Promise.all([...JsonStore.all].map(s => s.idle()))
  }

  /**
   * After a restore the files on disk are the truth: from here until the restart nothing in memory may
   * overwrite them (a login would otherwise write the old users back)
   */
  static frozen = false
  static freeze() {
    JsonStore.frozen = true
  }

  private data: T
  private queue: Promise<void> = Promise.resolve()

  /**
   * onCorrupt: "reset" starts fresh (fine for data that can be rebuilt, like sessions),
   * "fail" refuses to start so a broken users or settings file is never silently replaced
   */
  constructor(private file: string, private fallback: () => T, options: { onCorrupt?: 'reset' | 'fail' } = {}) {
    JsonStore.all.add(this)
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8')) as T
      } catch (err) {
        if (options.onCorrupt === 'fail') {
          throw new Error(
            `อ่านไฟล์ข้อมูล ${file} ไม่ได้ (ไฟล์เสียหาย) ระบบหยุดเพื่อไม่ให้ข้อมูลถูกเขียนทับ ` +
            `กรุณาแก้ไฟล์หรือกู้คืนจากข้อมูลสำรองแล้วเริ่มใหม่ (${(err as Error).message})`,
          )
        }
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
    if (JsonStore.frozen) return
    const snapshot = JSON.stringify(this.data, null, 2)
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`
      await Bun.write(tmp, snapshot)
      renameSync(tmp, this.file)
    }).catch(err => log.error('store-write-failed', { file: this.file, error: err }))
  }

  flushSync(): void {
    if (JsonStore.frozen) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  async idle(): Promise<void> {
    await this.queue
  }
}
