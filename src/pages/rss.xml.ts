import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const posts = await getCollection('blog', ({ data }) => data.published);
  const items = posts
    .sort((a, b) => new Date(b.data.pubDate).getTime() - new Date(a.data.pubDate).getTime())
    .map(post => ({
      title: post.data.title,
      pubDate: new Date(post.data.pubDate),
      description: post.data.description ?? '',
      link: `/blog/${post.slug}`,
    }));

  return rss({
    title: 'anuraag — notes',
    description: 'Writeups on systems, ML, and GPU work.',
    site: context.site ?? 'https://anuraagw.me',
    items,
    customData: '<language>en</language>',
  });
}
