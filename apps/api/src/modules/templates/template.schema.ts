import { z } from "zod";

export const createTemplateSchema = z.object({
  name: z.string().min(2),
  text: z.string().min(1),
  mediaUrl: z.string().url().optional(),
  spinEnabled: z.boolean().default(false),
  isActive: z.boolean().default(true)
});

export const updateTemplateSchema = z.object({
  name: z.string().min(2).optional(),
  text: z.string().min(1).optional(),
  mediaUrl: z.string().url().nullable().optional(),
  spinEnabled: z.boolean().optional(),
  isActive: z.boolean().optional()
});
