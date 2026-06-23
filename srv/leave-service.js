const cds = require('@sap/cds')
const { extractIntent, phraseAnswer } = require('./lib/llm')
const { getLeaveBalances } = require('./lib/successfactors')

/**
 * Implementation of LeaveService.chat.
 *
 * Pipeline (see README "How a question flows"):
 *   1. Figure out WHO is asking  -> userId
 *   2. Ask Claude WHAT they want  -> intent  (keyword fallback if no API key)
 *   3. Query SuccessFactors for the verified numbers
 *   4. Ask Claude to PHRASE those numbers into a friendly reply
 *
 * The LLM never invents numbers — it only classifies the question and
 * phrases data that step 3 retrieved. This is the key safety property.
 */
module.exports = class LeaveService extends cds.ApplicationService {
  init() {
    this.on('chat', async (req) => {
      const message = (req.data.message || '').trim()
      if (!message) {
        return { reply: 'Please type a question, e.g. "How many vacation days do I have left?"', intent: 'empty' }
      }

      // 1. WHO — in production this comes from the logged-in user (XSUAA).
      //    Locally we fall back to a mock user so you can test immediately.
      const authUser = req.user && req.user.id
      const userId = authUser && authUser !== 'anonymous'
        ? authUser
        : (process.env.MOCK_USER_ID || 'jdoe')

      try {
        // 2. WHAT
        const intent = await extractIntent(message)

        if (intent.type === 'leave_balance') {
          // 3. Verified data from SuccessFactors (mock or real)
          const accounts = await getLeaveBalances(userId, intent.leaveType)
          // 4. Phrase it
          const reply = await phraseAnswer(message, accounts)
          return { reply, intent: intent.type }
        }

        return {
          reply: 'I can help you check your leave balance. Try asking: "How many vacation days do I have left?"',
          intent: intent.type || 'unsupported',
        }
      } catch (err) {
        req.error(502, `Sorry, I couldn't reach the HR system: ${err.message}`)
      }
    })

    return super.init()
  }
}
