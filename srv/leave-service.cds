/**
 * LeaveService — the only public API of this app.
 *
 * It exposes a single unbound action `chat` that the standalone frontend
 * calls with the user's free-text question. All the real work (intent
 * detection, SuccessFactors query, answer phrasing) happens in the handler
 * implementation in ./leave-service.js (delegating to ./lib/assistant.js).
 *
 * Invoked over OData v4 as:  POST /api/chat   body: { "message": "..." }
 */

// One step in the "how I got this" trace. (Icons are added by the frontend
// per `step` id, keeping this payload ASCII-only.)
type TraceStep {
  step   : String;   // machine id: intent | fetch | phrase
  title  : String;   // human-readable step name
  detail : String;   // what happened / what was found
  engine : String;   // which engine ran this step
  ms     : Integer;  // duration in milliseconds
}

type ChatResult {
  reply   : String;          // human-readable answer to show in the chat UI
  intent  : String;          // classified intent (analytics/debugging)
  totalMs : Integer;         // total time to produce the answer
  trace   : many TraceStep;  // ordered steps the answer went through
}

service LeaveService @(path: '/api') {

  // @requires: 'authenticated-user'  // <- enable in production once XSUAA is bound
  action chat(message : String) returns ChatResult;
}
