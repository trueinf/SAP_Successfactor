const cds = require('@sap/cds')
const { answer } = require('./lib/assistant')

/**
 * Implementation of LeaveService.chat.
 *
 * All the work (intent -> SuccessFactors -> phrasing, plus the trace) lives in
 * ./lib/assistant.js so the CAP server and the Netlify function share one
 * implementation. This handler just resolves the user and delegates.
 */
module.exports = class LeaveService extends cds.ApplicationService {
  init() {
    this.on('chat', async (req) => {
      const message = (req.data.message || '').trim()
      if (!message) {
        return { reply: 'Please type a question, e.g. "How many vacation days do I have left?"', intent: 'empty', totalMs: 0, trace: [] }
      }

      // In production this comes from the logged-in user (XSUAA); locally we
      // fall back to a mock/sandbox user so you can test immediately.
      const authUser = req.user && req.user.id
      const userId =
        authUser && authUser !== 'anonymous' ? authUser : process.env.SF_USER_ID || process.env.MOCK_USER_ID || 'jdoe'

      try {
        return await answer(message, userId)
      } catch (err) {
        req.error(502, `Sorry, I couldn't reach the HR system: ${err.message}`)
      }
    })

    return super.init()
  }
}
