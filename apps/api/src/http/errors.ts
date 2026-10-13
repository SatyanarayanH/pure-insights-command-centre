import type { Problem } from '@picc/contracts';

/** An error with an HTTP status. Rendered as RFC 9457 problem+json by the error middleware. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: Problem['errors'],
  ) {
    super(detail ?? title);
  }

  toProblem(requestId?: string): Problem {
    return {
      type: `https://pure-insights.example/problems/${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(requestId ? { requestId } : {}),
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

export const badRequest = (detail: string, errors?: Problem['errors']) =>
  new HttpError(400, 'validation_failed', 'Request validation failed', detail, errors);
export const unauthorized = (detail = 'Authentication is required.') =>
  new HttpError(401, 'unauthorized', 'Unauthorized', detail);
export const forbidden = (detail = 'You do not have permission to do this.') =>
  new HttpError(403, 'forbidden', 'Forbidden', detail);
export const notFound = (what: string) =>
  new HttpError(404, 'not_found', 'Not found', `${what} was not found.`);
export const conflict = (detail: string) => new HttpError(409, 'conflict', 'Conflict', detail);
