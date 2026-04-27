import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../utils/api-error";

export const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      message: err.message,
      details: err.details
    });
  }

  if (err instanceof ZodError) {
    return res.status(422).json({
      message: "Validation error",
      details: err.flatten()
    });
  }

  const fallback = err as Error;
  return res.status(500).json({
    message: "Internal server error",
    details: fallback.message
  });
};
