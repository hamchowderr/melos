/** Report DTOs (docs/CONTRACT.md §3.3, §3.4, §6.12, §7.7). No server import. */

/** The fixed section order (§6.12); lyrics are always last. */
export const REPORT_SECTIONS = [
  'core',
  'rights',
  'creators',
  'composition',
  'recording',
  'metadata',
  'listen',
  'licensing',
  'lyrics',
] as const;

export type ReportSectionId = (typeof REPORT_SECTIONS)[number];

export const REPORT_PRESETS = ['full', 'sans_lyrics', 'just_lyrics', 'disco_track_info'] as const;

export type ReportPreset = (typeof REPORT_PRESETS)[number];

export type ReportSection = { id: ReportSectionId; enabled: boolean };

export type ReportTemplateSummary = {
  templateId: string;
  name: string;
  reportType: string;
  presetKey: string | null;
  isSystem: boolean;
  sections: ReportSection[];
};

/** One song in a report: exactly one of the two ids (§3.7). */
export type ReportItemInput = { recordingId?: string; compositionId?: string };

/** A resolved item: a composition item names its primary recording, or null without one (P-37). */
export type ReportItemDTO = { recordingId: string | null; compositionId: string | null };

/** previewReport input (§3.3): `templateId` or `preset`, 1–50 ordered items, section overrides. */
export type ReportPreviewInput = {
  templateId?: string;
  preset?: ReportPreset;
  items: ReportItemInput[];
  sections?: Partial<Record<ReportSectionId, boolean>>;
};

export type ReportPreviewDTO = {
  templateId: string;
  items: ReportItemDTO[];
  sections: ReportSection[];
  text: string;
};

/** A report holds at most this many songs (§7.7, RPT-005). */
export const MAX_REPORT_ITEMS = 50;
