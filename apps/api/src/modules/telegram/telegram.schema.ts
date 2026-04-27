import { z } from "zod";

export const requestOtpSchema = z.object({
  phone: z.string().min(8),
  label: z.string().min(1)
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(8),
  code: z.string().min(3)
});
