/** An error with a client-facing status and the standard `{error:{type,code,message}}` body. */
export class GatewayError extends Error {
  constructor(
    public status: number,
    public type: string,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody() {
    return { error: { type: this.type, code: this.code, message: this.message, ...(this.extra ?? {}) } };
  }
}

export const errorBody = (type: string, code: string, message: string) => ({ error: { type, code, message } });
