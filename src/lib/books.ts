import type { CollectionEntry } from 'astro:content';
import { getBookConfig, getOrderedChapterSlugs, type BookConfig } from '../data/books';

export type BookChapterEntry = CollectionEntry<'books'>;

export interface ResolvedBookChapter {
  doc: BookChapterEntry;
  slug: string;
  order: number;
  href: string;
  stageTitle: string;
}

export interface ResolvedBookStage {
  title: string;
  chapters: ResolvedBookChapter[];
}

export interface ResolvedBook {
  config: BookConfig;
  chapters: ResolvedBookChapter[];
  stages: ResolvedBookStage[];
}

export const getBookIdFromDoc = (doc: BookChapterEntry) => {
  const [bookId] = doc.id.split('/');
  return bookId;
};

export const getChapterSlugFromDoc = (doc: BookChapterEntry) =>
  doc.id.split('/').slice(1).join('/');

export function resolveBookFromDocs(bookId: string, docs: BookChapterEntry[]): ResolvedBook {
  const config = getBookConfig(bookId);
  if (!config) {
    throw new Error(`Unknown book "${bookId}"`);
  }

  const docsInBook = docs.filter((doc) => getBookIdFromDoc(doc) === bookId);
  const docBySlug = new Map(docsInBook.map((doc) => [getChapterSlugFromDoc(doc), doc]));
  const orderedSlugs = getOrderedChapterSlugs(config);
  const orderedSlugSet = new Set(orderedSlugs);

  const missingChapters = orderedSlugs.filter((slug) => !docBySlug.has(slug));
  if (missingChapters.length > 0) {
    throw new Error(`Book "${bookId}" is missing configured chapters: ${missingChapters.join(', ')}`);
  }

  const extraChapters = docsInBook
    .map((doc) => getChapterSlugFromDoc(doc))
    .filter((slug) => !orderedSlugSet.has(slug));
  if (extraChapters.length > 0) {
    throw new Error(`Book "${bookId}" has unpublished or unordered chapters: ${extraChapters.join(', ')}`);
  }

  let order = 0;
  const stages = config.stages.map((stage) => ({
    title: stage.title,
    chapters: stage.chapters.map((slug) => {
      const doc = docBySlug.get(slug)!;
      order += 1;
      return {
        doc,
        slug,
        order,
        href: `/book/${bookId}/${slug}`,
        stageTitle: stage.title,
      };
    }),
  }));

  return {
    config,
    stages,
    chapters: stages.flatMap((stage) => stage.chapters),
  };
}
