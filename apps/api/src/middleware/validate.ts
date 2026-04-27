import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

export const validateBody = <T>(schema: ZodSchema<T>) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
};
