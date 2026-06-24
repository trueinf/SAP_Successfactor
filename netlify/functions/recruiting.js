const sf = require('../../srv/lib/successfactors')
const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })

exports.handler = async () => {
  try {
    return json(200, await sf.getRecruiting())
  } catch (err) {
    return json(502, { error: err.message })
  }
}
