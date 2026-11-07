import type { WorkspaceType } from '../workspace-type';

/** A getting-started item (CONTRACT §5.10). `done` is derived from workspace data (ONB-004). */
export type OnboardingItem = { key: string; label: string; href: string; done: boolean };

/** OnboardingChecklistDTO (CONTRACT §5.10). */
export type OnboardingChecklistDTO = {
  workspaceType: WorkspaceType;
  items: OnboardingItem[];
  doneCount: number;
  total: number;
  dismissed: boolean;
};
