import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    pubDate: z.string(),
    published: z.boolean().optional().default(true),
    contents_table: z.boolean().optional().default(false),
    pinned: z.boolean().optional().default(false),
    description: z.string().optional(),
    cat: z.string().optional(),
  }),
});

export const collections = { blog };
