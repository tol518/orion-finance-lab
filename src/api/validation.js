export class FinanceError extends Error {
  constructor(message, { code = "FINANCE_ERROR", status = 400, details } = {}) {
    super(message);
    this.name = "FinanceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function requiredString(value, name, { max = 5000, pattern } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FinanceError(`${name} is required`, { code: "INVALID_INPUT" });
  }
  const normalized = value.trim();
  if (normalized.length > max || (pattern && !pattern.test(normalized))) {
    throw new FinanceError(`${name} is invalid`, { code: "INVALID_INPUT" });
  }
  return normalized;
}

export function optionalString(value, name, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name, options);
}

export function normalizeSymbol(value) {
  const symbol = requiredString(value, "symbol", { max: 16 }).toUpperCase();
  if (!/^\^?[A-Z][A-Z0-9.=\-]{0,14}$/.test(symbol)) {
    throw new FinanceError("symbol is invalid", { code: "INVALID_SYMBOL" });
  }
  return symbol;
}

export function normalizeAgentId(value) {
  return requiredString(value, "agentId", {
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
  });
}

export function positiveNumber(value, name, { max = Number.MAX_SAFE_INTEGER, allowZero = false } = {}) {
  const number = Number(value);
  const minimumAccepted = allowZero ? number >= 0 : number > 0;
  if (!Number.isFinite(number) || !minimumAccepted || number > max) {
    throw new FinanceError(`${name} must be ${allowZero ? "non-negative" : "positive"}`, {
      code: "INVALID_INPUT",
    });
  }
  return number;
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new FinanceError(`${name} must be an integer between ${min} and ${max}`, {
      code: "INVALID_INPUT",
    });
  }
  return number;
}

export function enumValue(value, name, values) {
  const normalized = requiredString(value, name, { max: 40 }).toUpperCase();
  if (!values.includes(normalized)) {
    throw new FinanceError(`${name} must be one of ${values.join(", ")}`, {
      code: "INVALID_INPUT",
    });
  }
  return normalized;
}

export function isoDate(value, name) {
  const normalized = requiredString(value, name, { max: 40 });
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new FinanceError(`${name} must be an ISO date`, { code: "INVALID_INPUT" });
  }
  return date.toISOString();
}

export function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function jsonObject(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FinanceError(`${name} must be an object`, { code: "INVALID_INPUT" });
  }
  return value;
}

export function stringArray(value, name, { maxItems = 30, maxLength = 1000 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new FinanceError(`${name} must be an array with at most ${maxItems} items`, {
      code: "INVALID_INPUT",
    });
  }
  return value.map((item, index) => requiredString(item, `${name}[${index}]`, { max: maxLength }));
}

export function serializeError(error) {
  if (error instanceof FinanceError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Finance Lab request failed" };
}
