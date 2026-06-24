/**
 * LLM integration: the natural-language layer (provider-agnostic).
 *
 *   extractIntent(message) -> { type: 'leave_balance' | 'unsupported', leaveType? }
 *   phraseAnswer(question, accounts) -> friendly string
 *
 * Provider is chosen by LLM_PROVIDER:
 *   "openai"    (default) : uses OPENAI_API_KEY  (gpt-4o-mini by default)
 *   "anthropic"           : uses ANTHROPIC_API_KEY (claude-sonnet-4-6 by default)
 *
 * If the selected provider has no API key, both functions fall back to a
 * deterministic keyword classifier / template so the app still runs end-to-end.
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
const llmReady = (PROVIDER === 'openai' && hasOpenAI) || (PROVIDER === 'anthropic' && hasAnthropic)

if (!llmReady) {
  console.warn(`[llm] provider="${PROVIDER}" has no API key set — using keyword fallback (no LLM calls).`)
}

// The intent "function"/"tool" both providers fill in. One JSON Schema, shared.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['leave_balance', 'unsupported'] },
    leaveType: {
      type: 'string',
      description: "Specific leave type if mentioned, e.g. 'annual', 'sick', 'casual'. Omit if not specified.",
    },
  },
  required: ['type'],
}
const INTENT_DESCRIPTION =
  "Classify an employee's HR question. Use 'leave_balance' when they ask how much " +
  "leave / vacation / time off / PTO they have left. Otherwise use 'unsupported'."

const PHRASE_SYSTEM =
  'You are a concise, friendly HR assistant. Answer the user using ONLY the leave ' +
  'data provided. NEVER invent or estimate numbers. If the data is empty, say you ' +
  'could not find any leave records.'

// ---- Public API ------------------------------------------------------------

async function extractIntent(message) {
  try {
    if (PROVIDER === 'openai' && hasOpenAI) return await openaiIntent(message)
    if (PROVIDER === 'anthropic' && hasAnthropic) return await anthropicIntent(message)
  } catch (err) {
    console.warn('[llm] intent extraction failed, using fallback:', err.message)
  }
  return fallbackIntent(message)
}

async function phraseAnswer(question, accounts) {
  try {
    if (PROVIDER === 'openai' && hasOpenAI) return await openaiPhrase(question, accounts)
    if (PROVIDER === 'anthropic' && hasAnthropic) return await anthropicPhrase(question, accounts)
  } catch (err) {
    console.warn('[llm] phrasing failed, using fallback:', err.message)
  }
  return fallbackPhrase(accounts)
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

async function openaiPhrase(question, accounts) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const resp = await openaiClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: PHRASE_SYSTEM },
      {
        role: 'user',
        content:
          `The employee asked: "${question}"\n\n` +
          `Verified leave data (JSON, authoritative):\n${JSON.stringify(accounts, null, 2)}\n\n` +
          'Answer their question using only this data.',
      },
    ],
  })
  return (resp.choices[0]?.message?.content || '').trim() || fallbackPhrase(accounts)
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

async function anthropicPhrase(question, accounts) {
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
          `Verified leave data (JSON, authoritative):\n${JSON.stringify(accounts, null, 2)}\n\n` +
          'Answer their question using only this data.',
      },
    ],
  })
  return resp.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

// ---- Deterministic fallbacks (no API key needed) ---------------------------

function fallbackIntent(message) {
  const m = message.toLowerCase()
  if (/(leave|vacation|holiday|time ?off|days off|pto|sick|balance|remaining)/.test(m)) {
    let leaveType
    if (/sick/.test(m)) leaveType = 'sick'
    else if (/casual/.test(m)) leaveType = 'casual'
    else if (/(vacation|annual|holiday|pto)/.test(m)) leaveType = 'annual'
    return { type: 'leave_balance', leaveType }
  }
  return { type: 'unsupported' }
}

function fallbackPhrase(accounts) {
  if (!accounts || accounts.length === 0) return "I couldn't find any leave records for you."
  const lines = accounts.map((a) => `• ${a.accountType}: ${a.balance} ${a.unit} remaining (as of ${a.asOf})`)
  return `Here is your leave balance:\n${lines.join('\n')}`
}

// Describes the active NLP engine — used by the trace.
function llmInfo() {
  const model =
    PROVIDER === 'anthropic'
      ? process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
      : process.env.OPENAI_MODEL || 'gpt-4o-mini'
  return { provider: PROVIDER, model, usingLLM: llmReady }
}

module.exports = { extractIntent, phraseAnswer, llmInfo }
