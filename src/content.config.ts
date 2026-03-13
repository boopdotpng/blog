import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    pubDate: isoDate,
    updatedDate: isoDate.optional(),
    published: z.boolean().optional().default(true),
    contents_table: z.boolean().optional().default(false),
    pinned: z.boolean().optional().default(false),
    description: z.string().min(1).optional(),
    cat: z.string().optional(),
  }).superRefine((data, ctx) => {
    if (data.published && !data.description?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Published posts must include a description for SEO.',
        path: ['description'],
      });
    }
  }),
});

export const collections = { blog };
