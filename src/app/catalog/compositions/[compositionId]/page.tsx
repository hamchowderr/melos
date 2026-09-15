import { SongPage } from '@/app/catalog/song-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ compositionId: string }> };

export default async function CompositionPage({ params }: Props) {
  const { compositionId } = await params;
  return <SongPage focus={{ entityType: 'composition', entityId: compositionId }} />;
}
