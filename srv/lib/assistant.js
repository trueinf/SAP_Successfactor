/**
 * Assistant orchestrator — answers a chat message across MANY HR topics, not
 * just leave. Used by the CAP service and the Netlify function.
 *
 * Flow: classify topic (LLM tool-use or keyword fallback) -> fetch the matching
 * verified data from SuccessFactors -> phrase it (LLM or template). Returns
 * { reply, intent, totalMs, trace } — the trace powers the "How I got this" UI.
 */
const { extractIntent, phraseAnswer, llmInfo } = require('./llm')
const sf = require('./successfactors')

const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', 'genai-hub': 'SAP Generative AI Hub' }
function engineLabel(info) {
  if (!info.usingLLM) return 'Keyword fallback (no LLM)'
  return `${PROVIDER_NAMES[info.provider] || info.provider} (${info.model})`
}
function summAccounts(accounts) {
  if (!accounts || !accounts.length) return 'no accounts'
  return accounts.map((a) => `${a.accountType}: ${a.balance} ${a.unit}`).join(', ')
}

async function answer(message, userId) {
  const trace = []
  const started = Date.now()

  // 1) Classify the topic
  let t = Date.now()
  const intent = await extractIntent(message)
  const type = intent.type || 'unsupported'
  trace.push({
    step: 'intent',
    title: 'Understood the question',
    detail: `Detected topic: ${type}${intent.leaveType ? ` (${intent.leaveType})` : ''}`,
    engine: engineLabel(llmInfo()),
    ms: Date.now() - t,
  })

  if (type === 'unsupported') {
    return {
      reply:
        'I can help with your leave balance, leave history, profile, pay, payroll, recruiting, and team. ' +
        'Try: "How many leaves do I have?", "Who is my manager?", or "Show my pay components."',
      intent: type,
      totalMs: Date.now() - started,
      trace,
    }
  }

  // 2) Fetch the verified data for the topic
  t = Date.now()
  const info = sf.sfInfo()
  let data
  let fetchDetail
  switch (type) {
    case 'leave_balance':
      data = await sf.getLeaveBalances(userId, intent.leaveType)
      fetchDetail = `${data.length} account(s): ${summAccounts(data)}`
      break
    case 'leave_history':
      data = await sf.getLeaveHistory(userId)
      fetchDetail = `${data.length} leave record(s)`
      break
    case 'profile':
      data = await sf.getProfile(userId)
      fetchDetail = `${data.name} — ${data.jobTitle}`
      break
    case 'pay': {
      const d = await sf.getPay(userId)
      data = d.components
      fetchDetail = `${data.length} pay component(s)`
      break
    }
    case 'payroll': {
      const d = await sf.getPayroll(userId)
      data = d.runs
      fetchDetail = `${data.length} pay statement(s)`
      break
    }
    case 'recruiting':
      data = await sf.getRecruiting()
      fetchDetail = `${data.requisitions.length} requisition(s), ${data.candidates.length} candidate(s)`
      break
    case 'team':
      data = await sf.getTeam(userId)
      fetchDetail = `manager + ${(data.members || []).length} team member(s)`
      break
    default:
      data = null
      fetchDetail = '—'
  }
  trace.push({
    step: 'fetch',
    title: 'Queried SAP SuccessFactors',
    detail: fetchDetail,
    engine: `SuccessFactors OData (${info.source})`,
    ms: Date.now() - t,
  })

  // 3) Phrase the verified data
  t = Date.now()
  const reply = await phraseAnswer(message, data, type)
  trace.push({
    step: 'phrase',
    title: 'Composed the answer',
    detail: 'Phrased the verified data into a natural reply (numbers never invented by the model)',
    engine: engineLabel(llmInfo()),
    ms: Date.now() - t,
  })

  return { reply, intent: type, totalMs: Date.now() - started, trace }
}

module.exports = { answer }
