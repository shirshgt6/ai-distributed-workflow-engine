import { ValidationError } from "../utils/errors.js";

/**
 * Validate (and normalise) request parts with zod schemas.
 *
 * The PARSED values go to req.valid.{body,params,query}. Controllers read
 * only from req.valid, never from raw req.body — so unknown fields (like a
 * smuggled `role`) have already been stripped by the time a controller runs.
 *
 * All failing fields are reported at once, so a client can fix them in one go.
 *
 * @param {{ body?: import('zod').ZodType, params?: import('zod').ZodType, query?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const details = [];

    for (const part of ["params", "query", "body"]) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        valid[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ location: part, path: issue.path.join("."), message: issue.message });
        }
      }
    }

    if (details.length > 0) {
      return next(new ValidationError("Request validation failed", { details }));
    }
    req.valid = valid;
    next();
  };
}
