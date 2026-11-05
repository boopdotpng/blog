import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => data.published);
  const sortedPosts = posts.sort((a, b) => b.data.pubDate.localeCompare(a.data.pubDate));

  return rss({
    title: 'anuraag',
    description: 'thoughts on neural nets, chips, and kernels',
    site: context.site ?? 'https://anuraagw.me',
    trailingSlash: false,
    items: sortedPosts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: new Date(`${post.data.pubDate}T00:00:00.000Z`),
      link: `/blog/${post.id}`,
      categories: post.data.cat ? [post.data.cat] : undefined,
    })),
    customData: '<language>en-us</language>',
  });
}
