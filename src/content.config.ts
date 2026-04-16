import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

const requireDescriptionWhenPublished = (label: string) =>
  (data: { published?: boolean; description?: string }, ctx: z.RefinementCtx) => {
    if (data.published && !data.description?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Published ${label} must include a description for SEO.`,
        path: ['description'],
      });
    }
  };

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    pubDate: isoDate,
    updatedDate: isoDate.optional(),
    published: z.boolean().optional().default(true),
    description: z.string().min(1).optional(),
    cat: z.string().optional(),
    useKatex: z.boolean().optional().default(false),
  }).superRefine(requireDescriptionWhenPublished('posts')),
});

const folders = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/folders', ignore: ['**/CLAUDE.md'] }),
  schema: z.object({
    title: z.string(),
    pubDate: isoDate,
    updatedDate: isoDate.optional(),
    published: z.boolean().optional().default(true),
    description: z.string().min(1).optional(),
    useKatex: z.boolean().optional().default(false),
  }).superRefine(requireDescriptionWhenPublished('documents')),
});

export const collections = { blog, folders };
