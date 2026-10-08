/** Turn a drop event's data into [{ file, relativeDir }]. Must be called synchronously from the drop handler. */
export function collectDropped(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
  const loose = [...(dataTransfer.files || [])]
  if (!entries.length) return Promise.resolve(loose.map(file => ({ file, relativeDir: '' })))

  const out = []
  const readAll = reader => new Promise((resolve, reject) => {
    const all = []
    const next = () => reader.readEntries(batch => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject)
    next()
  })
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej))
      out.push({ file, relativeDir: dir })
    } else if (entry.isDirectory) {
      const here = dir ? `${dir}/${entry.name}` : entry.name
      for (const child of await readAll(entry.createReader())) await walk(child, here)
    }
  }
  return (async () => {
    for (const e of entries) await walk(e, '')
    return out
  })()
}

/** <input type=file webkitdirectory> gives webkitRelativePath = "folder/sub/name.ext" */
export function fromInput(fileList) {
  return [...fileList].map(file => {
    const rel = file.webkitRelativePath || ''
    const i = rel.lastIndexOf('/')
    return { file, relativeDir: i > 0 ? rel.slice(0, i) : '' }
  })
}
