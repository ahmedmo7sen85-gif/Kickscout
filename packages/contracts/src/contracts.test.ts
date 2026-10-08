import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateAnalysisRequest, CreateUploadRequest, RegisterRequest, buildOpenApi } from './index.js';

describe('contracts', () => {
  it('rejects a selection box that leaves the frame', () => {
    expect(CreateAnalysisRequest.safeParse({ frameMs: 0, box: { x: 0.9, y: 0, w: 0.2, h: 0.2 } }).success).toBe(false);
    expect(CreateAnalysisRequest.parse({ frameMs: 0, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } }).tier).toBe('basic');
  });

  it('accepts only the supported video formats and sizes', () => {
    const base = { sizeBytes: 1000, videoType: 'match', subject: 'me' };
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/mp4' }).success).toBe(true);
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/x-msvideo' }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/mp4', sizeBytes: 10 ** 10 }).success).toBe(false);
  });

  it('does not let sign-up pick privileged roles', () => {
    const r = { handle: 'abc', displayName: 'A', dob: '2000-01-01', countryCode: 'EG' };
    expect(RegisterRequest.safeParse({ ...r, roles: ['player'] }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...r, roles: ['scout'] }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...r, roles: ['admin'] }).success).toBe(false);
  });

  it('builds OpenAPI paths with path and query parameters', () => {
    const doc = buildOpenApi(
      [{ method: 'get', path: '/v1/things/:thingId', summary: 's', tag: 't', auth: true, query: z.object({ limit: z.number().optional() }), response: z.object({ id: z.string() }) }],
      { title: 'x', version: '1' },
    );
    const op = (doc.paths['/v1/things/{thingId}'] as Record<string, any>).get;
    expect(op.parameters.map((p: { name: string }) => p.name)).toEqual(['thingId', 'limit']);
    expect(op.security).toEqual([{ bearer: [] }]);
  });
});
