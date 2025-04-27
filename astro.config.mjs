import { defineConfig } from 'astro/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import sitemap from '@astrojs/sitemap';
import { visit } from 'unist-util-visit';

/** @type {import('unified').Plugin<[], import('hast').Root>} */
function wrapCodeBlocks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'pre') {
        node.properties = node.properties || {};
        node.properties.style = (node.properties.style || '') + 'overflow-x:auto;max-width:100%;';
      }
    });
  };
}

/** @type {import('unified').Plugin<[], import('hast').Root>} */
function styleLinks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'a') {
        node.properties = node.properties || {};
        node.properties.style = (node.properties.style || '') + 'color:#1e90ff;text-decoration:none;';
      }
    });
  };
}

export default defineConfig({
  site: 'https://anuraagw.me',
  trailingSlash: 'never',
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex, wrapCodeBlocks, styleLinks],
  },
});
