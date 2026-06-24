/**
 * Netlify serverless function — GET /api/history.
 * Returns the user's recent leave/absence records (EmployeeTime).
 */
const { getLeaveHistory } = require('../../srv/lib/successfactors')

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
}

exports.handler = async () => {
  const userId = process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'
  try {
    return json(200, { history: await getLeaveHistory(userId), userId })
  } catch (err) {
    return json(502, { error: `Could not load history: ${err.message}` })
  }
}
