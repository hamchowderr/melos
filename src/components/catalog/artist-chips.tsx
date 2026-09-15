import { Badge } from '@/components/ui/badge';
import type { RecordingArtistDTO } from '@/lib/dto/catalog';

/** A recording's artists in billing order (§2.3, CAT-003); a featured artist reads "feat.". */
export function ArtistChips({ artists }: { artists: RecordingArtistDTO[] }) {
  if (artists.length === 0) return null;
  return (
    <ul aria-label="Artists" className="flex flex-wrap gap-1">
      {artists.map(({ partyId, role, displayName }) => (
        <li key={`${partyId}:${role}`} data-role={role}>
          <Badge variant={role === 'primary' ? 'default' : 'secondary'}>
            {role === 'featured' ? `feat. ${displayName}` : displayName}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
