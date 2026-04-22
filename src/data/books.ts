export interface BookStageConfig {
  title: string;
  chapters: string[];
}

export interface BookConfig {
  id: string;
  title: string;
  description: string;
  shortDescription?: string;
  stages: BookStageConfig[];
}

export const BOOKS: Record<string, BookConfig> = {
  'blackhole-emulator': {
    id: 'blackhole-emulator',
    title: 'blackhole emulator',
    description: 'A guided reading order for the Blackhole emulator specs, from the machine model and boot flow through the data path, hardware units, and advanced synchronization details.',
    shortDescription: 'Ordered Blackhole emulator specs with chapter navigation.',
    stages: [
      {
        title: 'Stage 1 — What Is This Machine?',
        chapters: ['device-grid', 'execution-model', 'address-space'],
      },
      {
        title: 'Stage 2 — The Five RISC-V Cores and Boot',
        chapters: ['registers', 'ldm-layouts', 'firmware-upload', 'logical-to-virtual-coordinates'],
      },
      {
        title: 'Stage 3 — Tensix Coprocessor Frontend',
        chapters: ['tensix-coprocessor-pipeline', 'instruction-push', 'mop-and-replay-expanders', 'stallwait-conditions', 'semaphores'],
      },
      {
        title: 'Stage 4 — Data Path: Registers, Addressing, CBs',
        chapters: ['data-types-and-conversions', 'dest-srca-srcb-registers', 'rwc-and-addressing', 'pack-unpack-registers', 'circular-buffers', 'pcbufs'],
      },
      {
        title: 'Stage 5 — Hardware Unit Deep-Dives',
        chapters: ['fpu-operations', 'unpack-data-path', 'pack-data-path', 'sfpu-operations', 'niu', 'dram'],
      },
      {
        title: 'Stage 6 — Cross-Cutting Infrastructure',
        chapters: ['stream-registers', 'gpr-and-dma-instructions', 'noc-atomics', 'mutexes', 'xmov-and-tdma-mover'],
      },
      {
        title: 'Stage 7 — Niche / Advanced',
        chapters: ['specialty-fpu-operations', 'sfploadmacro-and-sfptransp', 'additional-scalar-unit-instructions', 'config-sync-instructions'],
      },
    ],
  },
};

export const getBookConfig = (bookId: string) => BOOKS[bookId];

export const getBookConfigs = () => Object.values(BOOKS);

export const getOrderedChapterSlugs = (book: BookConfig) =>
  book.stages.flatMap((stage) => stage.chapters);
