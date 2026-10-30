import { HolderSplitEditor, type Option } from '@/components/rights/holder-split-editor';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RightsSummaryDTO } from '@/lib/dto/rights';
import type { HolderHashes } from '@/server/services/rights/holder-shares';

type Props = {
  compositionId: string;
  publishing: RightsSummaryDTO['publishing'];
  hashes: HolderHashes;
  parties: Option[];
  agreements: Option[];
};

/**
 * The publishing split editor (RGT-002, RGT-007): a tab per territory set, and a tab to add one.
 * WORLD and country sets never mix on one song (P-05); the service refuses that on save.
 */
export function PublishingEditor({ compositionId, publishing, hashes, ...options }: Props) {
  return (
    <Tabs defaultValue={publishing[0]?.territory ?? 'new'}>
      <TabsList>
        {publishing.map(({ territory }) => (
          <TabsTrigger key={territory} value={territory}>
            {territory}
          </TabsTrigger>
        ))}
        <TabsTrigger value="new">New territory</TabsTrigger>
      </TabsList>
      {publishing.map(({ territory, holders }) => (
        <TabsContent key={territory} value={territory} className="flex flex-col pt-2">
          <HolderSplitEditor
            {...options}
            target={{ side: 'publishing', compositionId, territory }}
            label={`Edit publishing ${territory}`}
            beforeHash={hashes.publishing[territory] ?? hashes.empty}
            holders={holders}
          />
        </TabsContent>
      ))}
      <TabsContent value="new" className="flex flex-col pt-2">
        <HolderSplitEditor
          {...options}
          target={{ side: 'publishing', compositionId, territory: null }}
          label="Add publishing set"
          beforeHash={hashes.empty}
          holders={[]}
        />
      </TabsContent>
    </Tabs>
  );
}
