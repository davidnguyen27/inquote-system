import { isEmail } from "class-validator";

export type ValidationReason =
  | "INVALID_TYPE"
  | "REQUIRED"
  | "INVALID_UNICODE"
  | "TOO_LONG"
  | "INVALID_EMAIL";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ValidationReason };

export function validateText(
  value: unknown,
  { maxCodePoints, required = false }: { maxCodePoints: number; required?: boolean },
): ValidationResult<string | null> {
  if (value !== null && typeof value !== "string")
    return { ok: false, reason: "INVALID_TYPE" };
  const normalized = value?.trim() || null;
  if (normalized === null)
    return required ? { ok: false, reason: "REQUIRED" } : { ok: true, value: null };
  // Encoding replaces lone surrogates; PostgreSQL cannot store NUL.
  if (normalized.includes("\u0000") || /[\uD800-\uDFFF]/u.test(normalized))
    return { ok: false, reason: "INVALID_UNICODE" };
  if ([...normalized].length > maxCodePoints)
    return { ok: false, reason: "TOO_LONG" };
  return { ok: true, value: normalized };
}

// Quota identity still normalizes rejected strings without accepting them as email.
export function accountEmailIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateEmail(value: unknown, profile: "account"): ValidationResult<string>;
export function validateEmail(value: unknown, profile: "contact"): ValidationResult<string | null>;
export function validateEmail(
  value: unknown,
  profile: "account" | "contact",
): ValidationResult<string | null> {
  if (profile === "account" && value == null)
    return { ok: false, reason: "REQUIRED" };
  const text = validateText(
    profile === "account" && typeof value === "string" ? accountEmailIdentity(value) : value,
    { maxCodePoints: 254, required: profile === "account" },
  );
  if (!text.ok || text.value === null) return text;
  // Keep the validator's existing syntax, UTF-16 and UTF-8 restrictions.
  if (!isEmail(text.value)) return { ok: false, reason: "INVALID_EMAIL" };
  return text;
}
