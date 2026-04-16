import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const site = context.site ?? 'https://anuraagw.me';
  const posts = await getCollection('blog', ({ data }) => data.published);
  const folderDocs = await getCollection('folders', ({ data }) => data.published);

  const blogItems = posts.map(post => ({
    title: post.data.title,
    pubDate: new Date(post.data.pubDate),
    description: post.data.description ?? '',
    link: new URL(`/blog/${post.id}`, site).href,
    categories: post.data.cat ? [post.data.cat] : undefined,
  }));

  const folderItems = folderDocs.map(doc => {
    const [folderId, ...slugParts] = doc.id.split('/');
    const slug = slugParts.join('/');
    const folderName = folderId.replace(/-/g, ' ');
    return {
      title: `${doc.data.title} — ${folderName}`,
      pubDate: new Date(doc.data.pubDate),
      description: doc.data.description ?? '',
      link: new URL(`/folder/${folderId}/${slug}`, site).href,
      categories: [folderName],
    };
  });

  const items = [...blogItems, ...folderItems]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  return rss({
    title: 'anuraag — notes',
    description: 'Writeups on systems, ML, and GPU work.',
    site,
    items,
    customData: '<language>en</language>',
  });
}
