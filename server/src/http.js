import { ObjectId } from 'mongodb';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Validates input against a zod schema; the first problem becomes a 400 with a readable message.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.join('.');
  throw new HttpError(400, field ? `${field}: ${issue.message}` : issue.message);
}

export function parseObjectId(value, what = 'id') {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || value.length !== 24) {
    throw new HttpError(400, `Invalid ${what}`);
  }
  return new ObjectId(value);
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
