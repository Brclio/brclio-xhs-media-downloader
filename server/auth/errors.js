export class AccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}
export function fail(code, message, status = 400) { throw new AccountError(code, message, status); }
