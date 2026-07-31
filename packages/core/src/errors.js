export class LlmWikiError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = "LlmWikiError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.taskId = options.taskId
    this.details = options.details
    this.suggestedAction = options.suggestedAction
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.taskId ? { task_id: this.taskId } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.suggestedAction ? { suggested_action: this.suggestedAction } : {}),
    }
  }
}

export function fail(code, message, options) {
  throw new LlmWikiError(code, message, options)
}

export function asLlmWikiError(error, fallbackCode = "TRANSACTION_FAILED") {
  if (error instanceof LlmWikiError) return error
  return new LlmWikiError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
  )
}
