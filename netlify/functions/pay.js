const sf = require('../../srv/lib/successfactors')
const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })

exports.handler = async () => {
  const userId = process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'
  try {
    return json(200, await sf.getPay(userId))
  } catch (err) {
    return json(502, { error: err.message })
  }
}
