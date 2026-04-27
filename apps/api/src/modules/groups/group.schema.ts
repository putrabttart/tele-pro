import { z } from "zod";

export const createGroupSchema = z.object({
  telegramId: z.string().optional(),
  username: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
  isActive: z.boolean().default(true)
}).refine((val) => Boolean(val.telegramId || val.username), {
  message: "telegramId or username is required"
});

export const updateGroupSchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  isActive: z.boolean().optional()
});

export const importGroupTextSchema = z.object({
  content: z.string().min(1),
  defaultTags: z.array(z.string().min(1)).default([])
});

export const importGroupFolderLinkSchema = z.object({
  link: z.string().min(1),
  defaultTags: z.array(z.string().min(1)).default([]),
  accountId: z.string().optional()
});

export const addGroupByLinkSchema = z.object({
  input: z.string().min(1),
  accountId: z.string().optional()
});
