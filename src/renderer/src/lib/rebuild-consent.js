// Declining the source rebuild is a decision to do NOTHING — not a request
// for the next exit. Both fail-closed boundaries (save, source toggle) ask on
// their own path but offer the follow-up recovery copy from another place, so
// the answer is recorded here and consumed by whoever would otherwise open a
// second dialog the user never asked for.
//
// The value is consumed (and cleared) at the point of use, so it only ever
// describes the decision the user just made.
let declined = false

export const askRebuildConsent = (message, confirmFn) => {
  const ask = typeof confirmFn === 'function'
    ? confirmFn
    : (text) => window.confirm(text)
  const accepted = ask(message) === true
  declined = !accepted
  return accepted
}

export const consumeRebuildDeclined = () => {
  const value = declined
  declined = false
  return value
}
