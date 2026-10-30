/** `assets.asset_type` (§4.3). */
export const ASSET_TYPES = [
  'audio',
  'image',
  'document',
  'agreement_pdf',
  'report_pdf',
  'import_source',
  'other',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** The relationships each link table allows (§4.3). */
export const ASSET_RELATIONSHIPS = {
  composition: ['lyrics_sheet', 'lead_sheet', 'other'],
  recording: ['audio_master', 'audio_preview', 'instrumental', 'stems', 'artwork', 'other'],
  release: ['cover_art', 'back_cover', 'booklet', 'other'],
} as const;
export type AssetTargetType = keyof typeof ASSET_RELATIONSHIPS;

const AUDIO = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac', 'audio/mp4'];
const IMAGE = ['image/jpeg', 'image/png', 'image/webp'];
const PDF = ['application/pdf'];
const DOCUMENT = [...PDF, 'text/plain'];

/**
 * The content types each asset type accepts (PROPOSED, from the rpr.8 review): a stored type is
 * always one of these plain values, so it is safe as a response header.
 */
export const ASSET_CONTENT_TYPES: Record<AssetType, readonly string[]> = {
  audio: AUDIO,
  image: IMAGE,
  document: DOCUMENT,
  agreement_pdf: PDF,
  report_pdf: PDF,
  import_source: ['text/csv'],
  other: [...AUDIO, ...IMAGE, ...DOCUMENT, 'text/csv', 'application/zip'],
};

/** Every content type some asset type accepts. */
export const ALLOWED_CONTENT_TYPES = new Set(Object.values(ASSET_CONTENT_TYPES).flat());

/** The largest asset Melos stores: 200 MiB, enough for a WAV master (PROPOSED). */
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

/** What the client sends to start or complete an upload; the server derives the storage key. */
export type UploadInput = { assetType: AssetType; fileName: string; contentType: string };

/** A signed upload: PUT the file to `url` with `contentType`, then complete it with `assetId`. */
export type UploadTicketDTO = {
  assetId: string;
  url: string;
  contentType: string;
  expiresInSeconds: number;
};

/** A registered asset (§4.3), without its storage key. */
export type AssetDTO = {
  id: string;
  assetType: AssetType;
  fileName: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
};

/** The catalog record an asset is attached to, by one of its ids. */
export type AssetTarget =
  | { compositionId: string }
  | { recordingId: string }
  | { releaseId: string };

export type AddAssetInput = { assetId: string; target: AssetTarget; relationship: string };

/** One link row an addAsset call holds. */
export type AssetLinkDTO = {
  assetId: string;
  entityType: AssetTargetType;
  entityId: string;
  relationship: string;
};

/** An audio asset attached to a recording (CAT-005), newest first. */
export type RecordingAudioDTO = {
  recordingId: string;
  assetId: string;
  fileName: string;
  relationship: string;
};
