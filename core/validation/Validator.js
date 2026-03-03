// src/core/validation/Validator.js
const { ZodError } = require("zod");
const { ValidationError } = require("../http/ApiError");

class Validator {
  static parse(schema, input) {
    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Validation failed", {
          issues: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
            code: i.code,
          })),
        });
      }
      throw err;
    }
  }
}

module.exports = { Validator };