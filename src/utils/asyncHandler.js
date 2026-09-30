/**
 * Express 4 no atrapa las promesas rechazadas de un handler async: sin esto,
 * un await que falla queda como unhandledRejection y la request se cuelga.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
