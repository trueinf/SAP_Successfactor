/**
 * LLM integration: the natural-language layer (provider-agnostic).
 *
 *   extractIntent(message) -> { type: 'leave_balance' | 'unsupported', leaveType? }
 *   phraseAnswer(question, accounts) -> friendly string
 *
 * Provider is chosen by LLM_PROVIDER:
 *   "openai"    (default) : uses OPENAI_API_KEY  (gpt-4o-mini by default)
 *   "anthropic"           : uses ANTHROPIC_API_KEY (claude-sonnet-4-6 by default)
 *   "genai-hub"           : SAP Generative AI Hub via SAP AI Core — the
 *                           compliant, SAP-native option for HR/PII (no data
 *                           used for training). Resolves AI Core credentials
 *                           from the bound `aicore` service or the
 *                           AICORE_SERVICE_KEY env var; model via GENAI_MODEL.
 *                           Requires: npm i @sap-ai-sdk/orchestration
 *
 * If the selected provider isn't ready (no key / SDK / creds), both functions
 * fall back to a deterministic keyword classifier / template so the app still
 * runs end-to-end.
 */
const PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase()

// Lazily-created clients (only constructed if the key + provider are present).
let _openai
let _anthropic

function openaiClient() {
  if (!_openai) {
    const OpenAI = require('openai')
    _openai = new OpenAI() // reads OPENAI_API_KEY
  }
  return _openai
}
function anthropicClient() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk')
    _anthropic = new Anthropic() // reads ANTHROPIC_API_KEY
  }
  return _anthropic
}

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)
// AI Core creds are resolved at call time (binding or AICORE_SERVICE_KEY), so
// treat genai-hub as "ready" and fail-soft to the fallback if the call errors.
const hasGenAI = PROVIDER === 'genai-hub'
const llmReady = (PROVIDER === 'openai' && hasOpenAI) || (PROVIDER === 'anthropic' && hasAnthropic) || hasGenAI

if (!llmReady) {
  console.warn(`[llm] provider="${PROVIDER}" has no API key set — using keyword fallback (no LLM calls).`)
}

// The intent "function"/"tool" both providers fill in. One JSON Schema, shared.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['leave_balance', 'leave_history', 'profile', 'pay', 'payroll', 'recruiting', 'team', 'unsupported'],
    },
    leaveType: {
      type: 'string',
      description: "For leave_balance only: specific type if mentioned, e.g. 'annual', 'sick', 'casual'. Omit otherwise.",
    },
  },
  required: ['type'],
}
const INTENT_DESCRIPTION =
  "Classify an employee's HR question into one topic: " +
  "leave_balance (how much leave/PTO is left), leave_history (past/upcoming absences), " +
  "profile (their job, department, manager, hire date — Core HR), pay (pay components / compensation), " +
  "payroll (payslips / pay statements / payroll runs), recruiting (job requisitions, candidates), " +
  "team (their manager, peers, who reports to whom). Use 'unsupported' if none fit."

const PHRASE_SYSTEM =
  'You are a concise, friendly HR assistant. Answer the user using ONLY the leave ' +
  'data provided. NEVER invent or estimate numbers. If the data is empty, say you ' +
  'could not find any leave records.'

// ---- Public API ------------------------------------------------------------

async function extractIntent(message) {
  try {
    if (PROVIDER === 'genai-hub') return await genaiIntent(message)
    if (PROVIDER === 'openai' && hasOpenAI) return await openaiIntent(message)
    if (PROVIDER === 'anthropic' && hasAnthropic) return await anthropicIntent(message)
  } catch (err) {
    console.warn('[llm] intent extraction failed, using fallback:', err.message)
  }
  return fallbackIntent(message)
}

async function phraseAnswer(question, data, kind) {
  try {
    if (PROVIDER === 'genai-hub') return await genaiPhrase(question, data, kind)
    if (PROVIDER === 'openai' && hasOpenAI) return await openaiPhrase(question, data, kind)
    if (PROVIDER === 'anthropic' && hasAnthropic) return await anthropicPhrase(question, data, kind)
  } catch (err) {
    console.warn('[llm] phrasing failed, using fallback:', err.message)
  }
  return fallbackPhrase(data, kind)
}

// ---- OpenAI implementation -------------------------------------------------

async function openaiIntent(message) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const resp = await openaiClient().chat.completions.create({
    model,
    messages: [{ role: 'user', content: message }],
    tools: [
      { type: 'function', function: { name: 'report_leave_query', description: INTENT_DESCRIPTION, parameters: INTENT_SCHEMA } },
    ],
    tool_choice: { type: 'function', function: { name: 'report_leave_query' } },
  })
  const call = resp.choices[0]?.message?.tool_calls?.[0]
  if (!call) return fallbackIntent(message)
  return JSON.parse(call.function.arguments)
}

async function openaiPhrase(question, data, kind) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const resp = await openaiClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: PHRASE_SYSTEM },
      {
        role: 'user',
        content:
          `The employee asked: "${question}"\n\n` +
          `Verified SuccessFactors data (JSON, authoritative):\n${JSON.stringify(data, null, 2)}\n\n` +
          'Answer their question using only this data.',
      },
    ],
  })
  return (resp.choices[0]?.message?.content || '').trim() || fallbackPhrase(data, kind)
}

// ---- Anthropic implementation ----------------------------------------------

async function anthropicIntent(message) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  const resp = await anthropicClient().messages.create({
    model,
    max_tokens: 512,
    tools: [{ name: 'report_leave_query', description: INTENT_DESCRIPTION, input_schema: INTENT_SCHEMA }],
    tool_choice: { type: 'tool', name: 'report_leave_query' },
    messages: [{ role: 'user', content: message }],
  })
  const toolUse = resp.content.find((c) => c.type === 'tool_use')
  return toolUse ? toolUse.input : fallbackIntent(message)
}

async function anthropicPhrase(question, data, kind) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  const resp = await anthropicClient().messages.create({
    model,
    max_tokens: 512,
    system: PHRASE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `The employee asked: "${question}"\n\n` +
          `Verified SuccessFactors data (JSON, authoritative):\n${JSON.stringify(data, null, 2)}\n\n` +
          'Answer their question using only this data.',
      },
    ],
  })
  const text = resp.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()
  return text || fallbackPhrase(data, kind)
}

// ---- SAP Generative AI Hub implementation (SAP AI Core) --------------------
// Uses @sap-ai-sdk/orchestration, which resolves AI Core credentials from the
// bound `aicore` service (on BTP) or the AICORE_SERVICE_KEY env var. Indirect
// require keeps the SDK out of builds that don't use this provider.
function orchestrationClientFor(template) {
  const pkg = '@sap-ai-sdk/orchestration'
  const { OrchestrationClient } = require(pkg)
  return new OrchestrationClient({
    llm: { model_name: process.env.GENAI_MODEL || 'gpt-4o', model_params: { temperature: 0 } },
    templating: { template },
  })
}

async function genaiIntent(message) {
  const client = orchestrationClientFor([
    {
      role: 'system',
      content:
        'You classify an employee HR question. Respond with ONLY a JSON object, no prose: ' +
        '{"type":"leave_balance"|"unsupported","leaveType"?:"annual"|"sick"|"casual"}. ' +
        "Use leave_balance when they ask how much leave/vacation/time off/PTO they have left.",
    },
    { role: 'user', content: '{{?question}}' },
  ])
  const res = await client.chatCompletion({ inputParams: { question: message } })
  const text = res.getContent() || ''
  const match = text.match(/\{[\s\S]*\}/)
  return match ? JSON.parse(match[0]) : fallbackIntent(message)
}

async function genaiPhrase(question, data, kind) {
  const client = orchestrationClientFor([
    { role: 'system', content: PHRASE_SYSTEM },
    {
      role: 'user',
      content:
        'The employee asked: "{{?question}}"\n\n' +
        'Verified SuccessFactors data (JSON, authoritative):\n{{?data}}\n\n' +
        'Answer their question using only this data.',
    },
  ])
  const res = await client.chatCompletion({
    inputParams: { question, data: JSON.stringify(data, null, 2) },
  })
  return (res.getContent() || '').trim() || fallbackPhrase(data, kind)
}

// ---- Deterministic fallbacks (no API key needed) ---------------------------

function fallbackIntent(message) {
  const m = message.toLowerCase()
  if (/(manager|reports? to|my team|team|peers|colleagues|org chart)/.test(m)) return { type: 'team' }
  if (/(profile|my (role|job|title|department|position)|who am i|hire date|cost center)/.test(m)) return { type: 'profile' }
  if (/(payslip|payroll|pay statement|pay run|gross|net pay)/.test(m)) return { type: 'payroll' }
  if (/(pay|compensation|salary|allowance|bonus|pay component)/.test(m)) return { type: 'pay' }
  if (/(history|past leave|previous leave|absence|took leave|applied for leave|upcoming leave)/.test(m)) return { type: 'leave_history' }
  if (/(requisition|candidate|recruit|job opening|hiring|applicant)/.test(m)) return { type: 'recruiting' }
  if (/(leave|vacation|holiday|time ?off|days off|pto|sick|balance|remaining)/.test(m)) {
    let leaveType
    if (/sick/.test(m)) leaveType = 'sick'
    else if (/casual/.test(m)) leaveType = 'casual'
    else if (/(vacation|annual|holiday|pto)/.test(m)) leaveType = 'annual'
    return { type: 'leave_balance', leaveType }
  }
  return { type: 'unsupported' }
}

// kind-aware template fallback (used when no LLM is configured)
function fallbackPhrase(data, kind) {
  if (kind === 'profile' && data) {
    return `You are ${data.name}, ${data.jobTitle} in ${data.department}. Manager: ${data.managerName}. Hire date: ${data.hireDate}.`
  }
  if (kind === 'team' && data) {
    const names = (data.members || []).map((x) => x.name + (x.isMe ? ' (you)' : '')).join(', ')
    return `Your manager is ${data.manager ? data.manager.name : '—'}. Your team: ${names || '—'}.`
  }
  if (kind === 'pay') {
    const c = data || []
    if (!c.length) return 'No pay components found.'
    return 'Your pay components:\n' + c.map((x) => `• ${x.component}: ${x.value} ${x.currency} (${x.frequency})`).join('\n')
  }
  if (kind === 'payroll') {
    const r = data || []
    if (!r.length) return 'No pay statements found.'
    return 'Recent pay statements:\n' + r.slice(0, 5).map((x) => `• ${x.payDate} (${x.period}) — ${x.status}`).join('\n')
  }
  if (kind === 'recruiting' && data) {
    return `Recruiting: ${data.requisitions.length} job requisition(s) and ${data.candidates.length} candidate(s).`
  }
  if (kind === 'leave_history') {
    const h = data || []
    if (!h.length) return 'No leave records found.'
    return 'Recent leave:\n' + h.slice(0, 6).map((x) => `• ${x.timeType}: ${x.startDate}${x.startDate !== x.endDate ? ' → ' + x.endDate : ''} (${x.days}d) — ${x.status}`).join('\n')
  }
  // default: leave_balance (accounts array)
  const accounts = Array.isArray(data) ? data : []
  if (!accounts.length) return "I couldn't find any matching records."
  return 'Here is your leave balance:\n' + accounts.map((a) => `• ${a.accountType}: ${a.balance} ${a.unit} remaining (as of ${a.asOf})`).join('\n')
}

// Describes the active NLP engine — used by the trace.
function llmInfo() {
  let model
  if (PROVIDER === 'anthropic') model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  else if (PROVIDER === 'genai-hub') model = process.env.GENAI_MODEL || 'gpt-4o'
  else model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  return { provider: PROVIDER, model, usingLLM: llmReady }
}

module.exports = { extractIntent, phraseAnswer, llmInfo }
