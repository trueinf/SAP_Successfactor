/**
 * Assistant orchestrator — the single source of truth for answering a chat
 * message. Used by BOTH the CAP service (srv/leave-service.js) and the Netlify
 * function (netlify/functions/chat.js) so they behave identically.
 *
 * Returns { reply, intent, totalMs, trace } where `trace` is an ordered list of
 * the steps taken to produce the answer (what ran, on which engine, how long,
 * and what it found) — this is what the UI's "How I got this" panel shows.
 */
const { extractIntent, phraseAnswer, llmInfo } = require('./llm')
const { getLeaveBalances, sfInfo } = require('./successfactors')

// NOTE: keep all trace strings ASCII-only. Emoji icons are added by the
// frontend (which is UTF-8 HTML) based on each step's `step` id, so the JSON
// payload stays free of multi-byte characters that can get mangled in transit.
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', 'genai-hub': 'SAP Generative AI Hub' }

function engineLabel(info) {
  if (!info.usingLLM) return 'Keyword fallback (no LLM)'
  const name = PROVIDER_NAMES[info.provider] || info.provider
  return `${name} (${info.model})`
}
function summariseAccounts(accounts) {
  if (!accounts || !accounts.length) return 'no accounts found'
  return accounts.map((a) => `${a.accountType}: ${a.balance} ${a.unit}`).join(', ')
}

async function answer(message, userId) {
  const trace = []
  const started = Date.now()

  // ---- Step 1: understand the question -------------------------------------
  let t = Date.now()
  const intent = await extractIntent(message)
  trace.push({
    step: 'intent',
    title: 'Understood the question',
    detail:
      intent.type === 'leave_balance'
        ? `Detected intent: leave_balance${intent.leaveType ? ` (type: ${intent.leaveType})` : ''}`
        : `Detected intent: ${intent.type}`,
    engine: engineLabel(llmInfo()),
    ms: Date.now() - t,
  })

  // Out-of-scope questions stop here.
  if (intent.type !== 'leave_balance') {
    return {
      reply: 'I can help you check your leave balance. Try asking: "How many vacation days do I have left?"',
      intent: intent.type || 'unsupported',
      totalMs: Date.now() - started,
      trace,
    }
  }

  // ---- Step 2: fetch verified data from SuccessFactors ---------------------
  t = Date.now()
  const accounts = await getLeaveBalances(userId, intent.leaveType)
  const info = sfInfo()
  trace.push({
    step: 'fetch',
    title: 'Queried SAP SuccessFactors',
    detail: `${accounts.length} account(s) from ${info.entity}: ${summariseAccounts(accounts)}`,
    engine: `SuccessFactors OData (${info.source})`,
    ms: Date.now() - t,
  })

  // ---- Step 3: phrase the verified numbers into a reply --------------------
  t = Date.now()
  const reply = await phraseAnswer(message, accounts)
  trace.push({
    step: 'phrase',
    title: 'Composed the answer',
    detail: 'Phrased the verified numbers into a natural reply (numbers never invented by the model)',
    engine: engineLabel(llmInfo()),
    ms: Date.now() - t,
  })

  return { reply, intent: intent.type, totalMs: Date.now() - started, trace }
}

module.exports = { answer }
