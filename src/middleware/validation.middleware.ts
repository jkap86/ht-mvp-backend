import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Validation middleware factory that validates request data against a Zod schema
 */
export function validateRequest(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req[source];
      const validated = await schema.parseAsync(data);

      if (source === 'query') {
        Object.keys(req.query).forEach((key) => delete req.query[key]);
        Object.assign(req.query, validated);
      } else {
        req[source] = validated;
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Use first error message for simpler client handling
        const firstError = error.issues[0];
        const errorMessage = firstError ? firstError.message : 'Validation failed';
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: errorMessage,
          },
        });
      }

      console.error('Validation middleware error:', error);
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error during validation',
        },
      });
    }
  };
}
