/**
 * LeaveService — the only public API of this app.
 *
 * It exposes a single unbound action `chat` that the standalone frontend
 * calls with the user's free-text question. All the real work (intent
 * detection, SuccessFactors query, answer phrasing) happens in the handler
 * implementation in ./leave-service.js.
 *
 * Invoked over OData v4 as:  POST /api/chat   body: { "message": "..." }
 */
type ChatResult {
  reply  : String;   // human-readable answer to show in the chat UI
  intent : String;   // classified intent, useful for debugging/analytics
}

service LeaveService @(path: '/api') {

  // @requires: 'authenticated-user'  // <- enable in production once XSUAA is bound
  action chat(message : String) returns ChatResult;
}
