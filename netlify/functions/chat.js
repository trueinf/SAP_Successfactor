/**
 * Netlify serverless function — the Netlify equivalent of the CAP `chat` action.
 *
 * The CAP server (srv/leave-service.js) can't run on Netlify (Netlify hosts
 * static sites + functions, not long-lived Node servers), so this function
 * reuses the SAME business logic modules to answer chat requests.
 *
 * Frontend posts to /api/chat -> redirected (netlify.toml) to this function.
 * Returns: { reply, intent } or { error }.
 *
 * Configure secrets as Netlify environment variables (NOT in code):
 *   LLM_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL,
 *   SF_MODE (use "sandbox" on Netlify), SF_API_KEY, SF_USER_ID
 */
const { answer } = require('../../srv/lib/assistant')

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' })
  }

  let message = ''
  try {
    message = (JSON.parse(event.body || '{}').message || '').trim()
  } catch {
    return json(400, { error: 'Invalid JSON body.' })
  }
  if (!message) {
    return json(200, { reply: 'Please type a question, e.g. "How many vacation days do I have left?"', intent: 'empty' })
  }

  // No XSUAA on Netlify, so use a configured/default user.
  const userId = process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'

  try {
    const result = await answer(message, userId)
    return json(200, result)
  } catch (err) {
    return json(502, { error: `Could not reach the HR system: ${err.message}` })
  }
}
