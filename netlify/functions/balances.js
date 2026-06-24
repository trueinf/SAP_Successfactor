/**
 * Netlify serverless function — GET /api/balances.
 *
 * Returns the user's leave accounts directly (no chat / no LLM), so the Fiori
 * dashboard can render KPI cards + table on load. Mirrors the CAP route in
 * srv/server.js so the frontend uses one path in both environments.
 */
const { getLeaveBalances, sfInfo } = require('../../srv/lib/successfactors')

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
}

exports.handler = async () => {
  const userId = process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'
  try {
    const accounts = await getLeaveBalances(userId)
    return json(200, { accounts, source: sfInfo(), userId })
  } catch (err) {
    return json(502, { error: `Could not load balances: ${err.message}` })
  }
}
