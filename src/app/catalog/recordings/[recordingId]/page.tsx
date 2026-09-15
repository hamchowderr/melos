import { SongPage } from '@/app/catalog/song-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ recordingId: string }> };

export default async function RecordingPage({ params }: Props) {
  const { recordingId } = await params;
  return <SongPage focus={{ entityType: 'recording', entityId: recordingId }} />;
}
