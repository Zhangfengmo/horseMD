export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function connectCdp({
  port = Number(process.env.CDP_PORT || 9222),
  attempts = 40,
  intervalMs = 250
} = {}) {
  const base = `http://127.0.0.1:${port}`
  let targets = []
  for (let i = 0; i < attempts; i += 1) {
    try {
      targets = await (await fetch(`${base}/json/list`)).json()
      if (targets.some((target) => target.type === 'page')) break
    } catch {}
    await sleep(intervalMs)
  }

  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error(`No Electron page found on CDP port ${port}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  // Native window.confirm/alert dialogs block the renderer's JS loop, which
  // deadlocks every later Runtime.evaluate. Auto-answer them: decline by
  // default (matches the app's abort-on-decline paths) and let a test opt into
  // accepting via setDialogResponse(true). Every dialog is recorded so tests
  // can assert one appeared.
  const dialogs = []
  let dialogAccept = false
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      if (message.method === 'Page.javascriptDialogOpening') {
        dialogs.push(message.params)
        send('Page.handleJavaScriptDialog', { accept: dialogAccept }).catch(() => {})
      }
      return
    }
    if (!pending.has(message.id)) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      return
    }
    request.resolve(message)
  })
  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'))
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id
    pending.set(callId, { resolve, reject })
    ws.send(JSON.stringify({ id: callId, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description ||
        response.result.exceptionDetails.text || 'CDP evaluation failed')
    }
    return response.result?.result?.value
  }

  await send('Page.enable').catch(() => {})

  return {
    ws,
    send,
    evaluate,
    dialogs,
    setDialogResponse: (accept) => { dialogAccept = !!accept }
  }
}
