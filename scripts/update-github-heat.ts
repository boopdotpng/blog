import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type GraphConfig = {
  name: string;
  outputPath: string;
  url: string;
};

const graphs: GraphConfig[] = [
  {
    name: 'light',
    outputPath: path.resolve('public/images/github-heat-light.svg'),
    url: 'https://gh-heat.anishroy.com/api/boopdotpng/svg?theme=blue&darkMode=false&transparent=true&showLegend=false',
  },
  {
    name: 'dark',
    outputPath: path.resolve('public/images/github-heat-dark.svg'),
    url: 'https://gh-heat.anishroy.com/api/boopdotpng/svg?darkMode=true&transparent=true&showLegend=false&colors=2a2f3c,2e5752,397a73,52a69d,8bd9cd&textColor=%23b8b2c8',
  },
];

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchSvg(url: string) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'boopdotpng-blog-build',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText})`);
  }

  const body = await response.text();
  if (!body.includes('<svg')) {
    throw new Error('Response was not SVG content');
  }

  return body;
}

async function main() {
  await mkdir(path.resolve('public/images'), { recursive: true });

  let usedFallback = false;

  for (const graph of graphs) {
    try {
      const svg = await fetchSvg(graph.url);
      await writeFile(graph.outputPath, svg);
      console.log(`[github-heat] updated ${graph.name} graph`);
    } catch (error) {
      if (await fileExists(graph.outputPath)) {
        usedFallback = true;
        console.warn(
          `[github-heat] failed to update ${graph.name} graph, using cached file (${(error as Error).message})`,
        );
        continue;
      }

      throw new Error(
        `[github-heat] failed to update ${graph.name} graph and no cached file exists: ${(error as Error).message}`,
      );
    }
  }

  if (usedFallback) {
    console.warn('[github-heat] build continued with one or more cached graph files');
  }
}

await main();
