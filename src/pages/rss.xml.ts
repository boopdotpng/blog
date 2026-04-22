import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const site = context.site ?? 'https://anuraagw.me';
  const posts = await getCollection('blog', ({ data }) => data.published);
  const bookDocs = await getCollection('books', ({ data }) => data.published);

  const blogItems = posts.map(post => ({
    title: post.data.title,
    pubDate: new Date(post.data.pubDate),
    description: post.data.description ?? '',
    link: new URL(`/blog/${post.id}`, site).href,
    categories: post.data.cat ? [post.data.cat] : undefined,
  }));

  const bookItems = bookDocs.map(doc => {
    const [bookId, ...slugParts] = doc.id.split('/');
    const slug = slugParts.join('/');
    const bookName = bookId.replace(/-/g, ' ');
    return {
      title: `${doc.data.title} — ${bookName}`,
      pubDate: new Date(doc.data.pubDate),
      description: doc.data.description ?? '',
      link: new URL(`/book/${bookId}/${slug}`, site).href,
      categories: [bookName],
    };
  });

  const items = [...blogItems, ...bookItems]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  return rss({
    title: 'anuraag — notes',
    description: 'Writeups on systems, ML, and GPU work.',
    site,
    items,
    customData: '<language>en</language>',
  });
}
