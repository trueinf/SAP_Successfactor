/**
 * Netlify serverless function — POST /api/request.
 * Submits a leave request (simulated in sandbox/mock; real POST in real mode).
 */
const { submitLeave } = require('../../srv/lib/successfactors')

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, message: 'Use POST.' })
  const userId = process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'
  let payload = {}
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { ok: false, message: 'Invalid JSON body.' })
  }
  try {
    return json(200, await submitLeave(userId, payload))
  } catch (err) {
    return json(502, { ok: false, message: err.message })
  }
}
