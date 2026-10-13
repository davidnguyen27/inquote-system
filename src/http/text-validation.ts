import { validateEmail, validateText } from "../domain/text.js";
import { HttpProblem } from "./problem.js";

export function textField(
  value: unknown,
  pointer: string,
  maxCodePoints: number,
  required = false,
): string | null {
  const result = validateText(value, { maxCodePoints, required });
  if (result.ok) return result.value;
  if (result.reason === "INVALID_TYPE") throw new HttpProblem(400, "INVALID_REQUEST");
  throw new HttpProblem(422, "VALIDATION_FAILED", [{
    pointer, code: "INVALID_TEXT",
    message: `Use ${required ? "1" : "0"}–${maxCodePoints} characters.`,
  }]);
}

export function emailField(value: unknown, pointer: string, profile: "account", syntaxMessage?: string): string;
export function emailField(value: unknown, pointer: string, profile: "contact", syntaxMessage?: string): string | null;
export function emailField(
  value: unknown,
  pointer: string,
  profile: "account" | "contact",
  syntaxMessage = "Use a valid email address.",
): string | null {
  const result = profile === "account" ? validateEmail(value, "account") : validateEmail(value, "contact");
  if (result.ok) return result.value;
  if (result.reason === "INVALID_TYPE") throw new HttpProblem(400, "INVALID_REQUEST");
  const emailError = profile === "account" || result.reason === "INVALID_EMAIL";
  throw new HttpProblem(422, "VALIDATION_FAILED", [{
    pointer,
    code: emailError ? "INVALID_EMAIL" : "INVALID_TEXT",
    message: emailError ? syntaxMessage : "Use 0–254 characters.",
  }]);
}
