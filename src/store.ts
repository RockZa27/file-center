import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { log } from './logger'

/** write all of `text` to `file` and fsync it, so the rename that follows never publishes a file whose bytes are still in the page cache */
function writeDurableSync(file: string, text: string) {
  const bytes = Buffer.from(text)
  const fd = openSync(file, 'w')
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * A tiny JSON-file store. Writes are atomic (temp file, fsync, rename) and serialised
 * so concurrent requests cannot corrupt the file. A write that fails (disk full...) is retried with a pause, and when
 * it still fails the admin is told (onWriteFailed) and the store tries again later: a change is never silently dropped.
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
  /** pauses before each retry of a failed write, and the wait before a store whose retries ran out tries again; tests make them short */
  static retry = { delaysMs: [200, 1000, 3000], laterMs: 30_000 }
  /** told once per run of failed attempts (alerts.ts sets it: a log line alone is not seen by anyone) */
  static onWriteFailed: (file: string, error: unknown) => void = () => {}

  /** write what is only in memory (changes waiting for their timer or for a retry), now and synchronously: the last chance before the process exits */
  static flushAllSync(): void {
    for (const s of JsonStore.all) {
      if (!s.timer && !s.unsaved && !s.pending) continue
      try { s.flushSync() } catch (err) { log.error('store-write-failed', { file: s.file, error: err, final: true }) }
    }
  }

  static frozen = false
  static freeze() {
    JsonStore.frozen = true
  }

  private data: T
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** the last write failed for good: memory holds what the file does not */
  private unsaved = false
  /** writes queued or running */
  private pending = 0
  private laterTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * onCorrupt: "reset" starts fresh (fine for data that can be rebuilt, like sessions),
   * "fail" refuses to start so a broken users or settings file is never silently replaced.   */
  constructor(private file: string, private fallback: () => T, options: { onCorrupt?: 'reset' | 'fail' } = {}) {
    JsonStore.all.add(this)
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8')) as T
      } catch (err) {
        if (options.onCorrupt === 'fail') {
          // the file stays where it is (nothing is written over it); one copy is kept next to it for whoever repairs it
          let kept = file
          try {
            const mine = `${basename(file)}.broken-`
            const old = readdirSync(dirname(file)).find(n => n.startsWith(mine))
            kept = old ? `${file}${old.slice(basename(file).length)}` : `${file}.broken-${Date.now()}`
            if (!old) copyFileSync(file, kept)
          } catch { /* the original is still there */ }
          const message =
            `\n[store] อ่านไฟล์ข้อมูล ${file} ไม่ได้ (ไฟล์เสียหาย: ${(err as Error).message}) ระบบหยุดเพื่อไม่ให้ข้อมูลถูกเขียนทับหรือถูกล้างเป็นค่าว่าง\n` +
            `  วิธีแก้: แก้ JSON ในไฟล์นั้นให้ถูกต้อง หรือนำไฟล์ ${basename(file)} จากไฟล์สำรองข้อมูล (zip ในโฟลเดอร์สำรอง) มาวางแทน ` +
            `หรือลบไฟล์นั้นถ้าต้องการเริ่มจากค่าว่าง แล้วเริ่มระบบใหม่ (สำเนาของไฟล์เสียเก็บไว้ที่ ${kept})\n` +
            `[store] Cannot read ${file} (the file is damaged: ${(err as Error).message}). The app stops so the data is neither overwritten nor reset to empty.\n` +
            `  To recover: fix the JSON in that file, or put ${basename(file)} from a backup zip (in the backup folder) in its place, ` +
            `or delete the file to start empty, then start the app again. A copy of the damaged file is kept at ${kept}.\n`
          // docker logs: the line is on stderr before the crash trace, which only repeats the message
          console.error(message)
          throw new Error(message.trim())
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

  /**
   * mutate now, persist within `ms`: for data changed on almost every request (recent files), where many changes
   * become one write. A plain save()/update() in between writes everything at once; idle()/flushAll() (shutdown,
   * backups) and flushSync() write what is waiting, so nothing is lost on a normal stop.
   */
  updateSoon(fn: (draft: T) => void, ms: number): void {
    fn(this.data)
    if (JsonStore.frozen) return
    this.timer ??= setTimeout(() => this.writeNow(), ms).unref()
  }

  replace(next: T): void {
    this.data = next
    this.save()
  }

  save(): void {
    if (JsonStore.frozen) return
    this.writeNow()
  }

  private writeNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (JsonStore.frozen) return
    const snapshot = JSON.stringify(this.data, null, 2)
    this.pending++
    this.queue = this.queue.then(() => this.persist(snapshot)).finally(() => { this.pending-- })
  }

  /** one write with retries; never rejects (the queue must go on), a final failure is reported and tried again later */
  private async persist(snapshot: string): Promise<void> {
    const delays = JsonStore.retry.delaysMs
    for (let attempt = 0; ; attempt++) {
      // a restore may have frozen the stores while this write waited: the files on disk are the truth now
      if (JsonStore.frozen) return
      try {
        const tmp = `${this.file}.tmp`
        // synchronous on purpose: the file is on disk before the next request is looked at (as it was when the write was
        // a plain Bun.write + rename), at the price of the loop standing still for the fsync of a few KB
        writeDurableSync(tmp, snapshot)
        renameSync(tmp, this.file)
        if (this.unsaved) log.info('store-write-recovered', { file: this.file })
        this.unsaved = false
        return
      } catch (err) {
        if (attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]))
          continue
        }
        this.unsaved = true
        log.error('store-write-failed', { file: this.file, error: err, attempts: attempt + 1 })
        try { JsonStore.onWriteFailed(this.file, err) } catch { /* reporting must not break the queue */ }
        // nothing else may write this file soon: look again later, with whatever the memory holds by then
        this.laterTimer ??= setTimeout(() => {
          this.laterTimer = null
          if (this.unsaved) this.writeNow()
        }, JsonStore.retry.laterMs).unref()
        return
      }
    }
  }

  flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (JsonStore.frozen) return
    const tmp = `${this.file}.tmp`
    writeDurableSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
    this.unsaved = false
  }

  async idle(): Promise<void> {
    if (this.timer) this.writeNow()
    await this.queue
  }
}
