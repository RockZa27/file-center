/**
 * Not a test: a File Center server in a process of its own, for tests/webdav.test.ts. A test that measures the memory
 * of a server can not do it in the process that also plays the client. STORAGE_DIR, DATA_DIR and ADMIN_PASSWORD come
 * from the test. Prints one line, "READY <json>", when it listens.
 */
const { app } = await import('../src/index')
const { createAppPassword } = await import('../src/app-passwords')
const { findUser } = await import('../src/auth')

const { secret } = await createAppPassword(findUser('admin')!, 'memory test', 'readwrite')
app.listen({ port: 0, hostname: '127.0.0.1' })
console.log(`READY ${JSON.stringify({ pid: process.pid, port: app.server!.port, secret })}`)
setInterval(() => {}, 1 << 30)
