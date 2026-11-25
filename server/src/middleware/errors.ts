import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ServiceError } from '../services/errors.js';

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Input tidak valid', details: error.issues.map((issue) => ({
      path: issue.path.join('.'), message: issue.message
    })) });
    return;
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    res.status(409).json({ error: 'Data sudah terdaftar' });
    return;
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Format JSON tidak valid' });
    return;
  }
  console.error('Unhandled request error:', error);
  res.status(500).json({ error: 'Terjadi kesalahan internal' });
};
