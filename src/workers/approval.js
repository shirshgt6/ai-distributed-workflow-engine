/**
 * Returned by a handler to say "stop here and ask a human". The worker
 * doesn't block or poll while waiting: it hands the task to the engine
 * (WAITING_FOR_APPROVAL + an ApprovalRequest row) and moves on to other work.
 */
export class AwaitApproval {
  /** @param {{ title: string, message?: string, context?: object, timeoutMs: number }} request */
  constructor(request) {
    this.request = request;
  }
}
