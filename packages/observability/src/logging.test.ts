import { expect, it } from 'vitest';
import { createLogger } from './index';

it('does not serialize unapproved request or exception payloads', () => {
  const lines: string[] = [];
  const log = createLogger(line => lines.push(line));
  log({ event: 'request.finished', level: 'info', environment: 'development', status: 200 });
  const unsafe = { event: 'request.failed', level: 'error' as const, environment: 'development' as const, authorization: 'Bearer sensitive-fixture', payload: { email: 'private@example.invalid' } };
  log(unsafe);
  expect(lines[0]).toContain('request.finished');
  expect(lines[1]).toContain('logging.invalid_metadata');
  expect(lines.join('')).not.toMatch(/sensitive-fixture|private@example/);
});
