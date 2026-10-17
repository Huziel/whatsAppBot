export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly expose = true,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') { super(400, code, message) }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Inicia sesión para continuar.', code = 'AUTHENTICATION_REQUIRED') { super(401, code, message) }
}

export class AuthorizationError extends AppError {
  constructor(message = 'No tienes autorización para realizar esta operación.', code = 'FORBIDDEN') { super(403, code, message) }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado.', code = 'NOT_FOUND') { super(404, code, message) }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') { super(409, code, message) }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'La solicitud supera el tamaño permitido.') { super(413, 'PAYLOAD_TOO_LARGE', message) }
}

export class RateLimitError extends AppError {
  constructor(message: string, code = 'RATE_LIMITED') { super(429, code, message) }
}

export class ExternalServiceError extends AppError {
  constructor(message = 'Un servicio necesario no está disponible.', code = 'EXTERNAL_SERVICE_UNAVAILABLE') { super(503, code, message) }
}

export class InternalError extends AppError {
  constructor(message = 'Ocurrió un error interno.', code = 'INTERNAL_ERROR') { super(500, code, message, false) }
}
