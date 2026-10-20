// The link in the verification mail lands on `/?emailVerified=1` (or 0). Read it once when the script loads, before the
// router redirects, and clean the address bar so a reload does not show the message again.
export const urlNotice = (() => {
  try {
    const q = new URLSearchParams(location.search)
    const v = q.get('emailVerified')
    if (v !== '1' && v !== '0') return null
    q.delete('emailVerified')
    const rest = q.toString()
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + location.hash)
    return v === '1' ? 'emailVerified' : 'emailVerifyFailed'
  } catch { return null }
})()
