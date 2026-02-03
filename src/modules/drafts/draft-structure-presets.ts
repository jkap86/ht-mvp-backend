import { PlayerPoolType } from './drafts.model';

export interface DraftPreset {
  playerPool: PlayerPoolType[];
  defaultRounds?: number; // Override for rookie/college drafts
}

export interface DraftStructureOption {
  id: string;
  label: string;
  description: string;
  drafts: DraftPreset[];
}

export const STANDARD_DRAFT_STRUCTURES: DraftStructureOption[] = [
  {
    id: 'combined',
    label: '1 Draft - Combined',
    description: 'Veterans and rookies in a single draft',
    drafts: [{ playerPool: ['veteran', 'rookie'] }],
  },
  {
    id: 'split',
    label: '2 Drafts - Separate',
    description: 'Separate veteran and rookie drafts',
    drafts: [{ playerPool: ['veteran'] }, { playerPool: ['rookie'], defaultRounds: 5 }],
  },
];

export const DEVY_DRAFT_STRUCTURES: DraftStructureOption[] = [
  {
    id: 'combined',
    label: '1 Draft - Combined',
    description: 'All players in a single draft',
    drafts: [{ playerPool: ['veteran', 'rookie', 'college'] }],
  },
  {
    id: 'nfl_college',
    label: '2 Drafts - NFL + College',
    description: 'NFL players and college players separately',
    drafts: [{ playerPool: ['veteran', 'rookie'] }, { playerPool: ['college'], defaultRounds: 5 }],
  },
  {
    id: 'vet_future',
    label: '2 Drafts - Veterans + Future',
    description: 'Veterans only, rookies and college together',
    drafts: [{ playerPool: ['veteran'] }, { playerPool: ['rookie', 'college'], defaultRounds: 5 }],
  },
  {
    id: 'split_three',
    label: '3 Drafts - Full Split',
    description: 'Veterans, rookies, and college separately',
    drafts: [
      { playerPool: ['veteran'] },
      { playerPool: ['rookie'], defaultRounds: 5 },
      { playerPool: ['college'], defaultRounds: 5 },
    ],
  },
];

export function getDraftStructures(mode: string): DraftStructureOption[] {
  return mode === 'devy' ? DEVY_DRAFT_STRUCTURES : STANDARD_DRAFT_STRUCTURES;
}

export function getDraftStructure(mode: string, structureId: string): DraftStructureOption | undefined {
  const structures = getDraftStructures(mode);
  return structures.find((s) => s.id === structureId);
}
