import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';

/** Maps database errors to HTTP responses without leaking SQL to clients. */
@Catch(QueryFailedError, EntityNotFoundError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  catch(err: QueryFailedError | EntityNotFoundError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof EntityNotFoundError) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ statusCode: 404, error: 'Not Found', message: 'Resource not found' });
    }
    const code = (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code;
    if (code === '23505') {
      return res
        .status(HttpStatus.CONFLICT)
        .json({ statusCode: 409, error: 'Conflict', message: 'Record already exists' });
    }
    if (code === '23503') {
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Referenced record does not exist',
      });
    }
    this.logger.error(err.message, err.stack);
    return res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, error: 'Internal Server Error', message: 'Database error' });
  }
}
