import type { ErrorRequestHandler } from "express";

export class HttpProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly errors?: {
      pointer: string;
      code: string;
      message: string;
    }[],
  ) {
    super(code);
  }
}
export class RateLimitProblem extends HttpProblem {
  constructor(public readonly retryAfter: number) {
    super(429, "RATE_LIMITED");
  }
}

export const problemHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  let problem: HttpProblem;
  if (error instanceof HttpProblem) problem = error;
  else if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    (error.type === "entity.parse.failed" || error.type === "entity.too.large")
  ) {
    problem = new HttpProblem(400, "INVALID_REQUEST");
  } else problem = new HttpProblem(500, "INTERNAL_ERROR");
  if (typeof error === "object" && error !== null && "type" in error &&
    (error.type === "charset.unsupported" || error.type === "encoding.unsupported"))
    problem = new HttpProblem(415, "INVALID_REQUEST");
  if (problem instanceof RateLimitProblem)
    res.setHeader("Retry-After", String(problem.retryAfter));
  res
    .status(problem.status)
    .type("application/problem+json")
    .json({
      type: `urn:inquote:problem:${problem.code}`,
      title: problem.code,
      status: problem.status,
      code: problem.code,
      detail: "The request could not be completed.",
      requestId: res.locals.requestId,
      ...(problem.errors ? { errors: problem.errors } : {}),
    });
};
