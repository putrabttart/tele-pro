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

export const batchUpdateGroupStatusSchema = z.object({
  groupIds: z.array(z.string().min(1)).min(1),
  isActive: z.boolean()
});

export const syncGroupSchema = z.object({
  accountId: z.string().min(1)
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

export const addGroupBatchSchema = z.object({
  usernames: z.array(z.string().min(1)).min(1),
  target: z.enum(["single", "all"]).default("single"),
  accountId: z.string().optional()
}).refine((val) => (val.target === "all" ? true : Boolean(val.accountId)), {
  message: "accountId is required when target=single"
});
