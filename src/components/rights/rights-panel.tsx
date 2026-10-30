import type { ReactNode } from 'react';
import { IssueItem } from '@/components/rights/issue-item';
import { RepresentationControls } from '@/components/rights/representation-controls';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RightsHolderDTO, RightsSummaryDTO } from '@/lib/dto/rights';
import { formatShare } from '@/lib/shares';
import { words } from '@/lib/words';

type Props = {
  rights: RightsSummaryDTO;
  recordingTitles: Map<string, string>;
  /** The writer split editor, for a role with rights:update (§6.2). */
  writerEditor?: ReactNode;
  /** The publishing editor, and each recording's master editor by id, for rights:update. */
  publishingEditor?: ReactNode;
  masterEditors?: Map<string, ReactNode>;
  /** Attest controls on other holders' shares, and the licensing contacts editor (RGT-005). */
  representable?: boolean;
  contactsEditor?: ReactNode;
  /** The agreements an attestation can cite, and the form that records one (RGT-006). */
  agreements?: { value: string; label: string }[];
  agreementForm?: ReactNode;
};

type Agreements = Props['agreements'];

/** A share table with its §4.3 view total in the footer. */
function ShareTable({
  label,
  rows,
  totalBp,
}: {
  label: string;
  rows: { key: string; name: string; detail: ReactNode; shareBp: number | null }[];
  totalBp: number;
}) {
  return (
    <GridFrame>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Holder</TableHead>
            <TableHead>Details</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, name, detail, shareBp }) => (
            <TableRow key={key}>
              <TableCell className="whitespace-normal">{name}</TableCell>
              <TableCell className="whitespace-normal">{detail}</TableCell>
              <TableCell className="text-right tabular-nums">
                {shareBp === null ? 'Not set' : formatShare(shareBp)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total</TableCell>
            <TableCell className="text-right tabular-nums" data-testid="share-total">
              {formatShare(totalBp)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </GridFrame>
  );
}

/**
 * A publishing or master holder's badges: the side's self party, and an attested representation
 * with the agreement that backs it.
 */
const holderBadges = (holder: RightsHolderDTO, agreements: Agreements) => {
  const backing = agreements?.find(({ value }) => value === holder.agreementId)?.label;
  return (
    <span className="inline-flex gap-1">
      {holder.isSelf ? <Badge variant="secondary">Self</Badge> : null}
      {holder.representationAttested ? <Badge variant="outline">Attested</Badge> : null}
      {holder.representationAttested && backing ? (
        <Badge variant="outline">{`Backed by ${backing}`}</Badge>
      ) : null}
    </span>
  );
};

const holderRows = (
  holders: RightsHolderDTO[],
  interestType: 'publishing' | 'master',
  representable?: boolean,
  agreements?: Agreements,
) =>
  holders.map((holder) => ({
    key: holder.interestId,
    name: holder.displayName,
    detail: (
      <span className="inline-flex flex-wrap items-center gap-2">
        {holderBadges(holder, agreements)}
        {representable ? (
          <RepresentationControls
            interestType={interestType}
            holder={holder}
            agreements={agreements}
          />
        ) : null}
      </span>
    ),
    shareBp: holder.shareBp,
  }));

/**
 * A song's rights (§2.3 RightsPanel, RGT-004, RGT-005): writers, publishing per territory and
 * masters per recording with their totals, licensing contacts and the readiness issues.
 */
export function RightsPanel(props: Props) {
  const { rights, recordingTitles, writerEditor, publishingEditor, masterEditors } = props;
  const { representable, contactsEditor, agreements, agreementForm } = props;
  const writers = rights.writers.map((writer) => ({
    key: writer.contributorId,
    name: writer.displayName,
    detail: writer.roles.map(words).join(', '),
    shareBp: writer.shareBp,
  }));
  const titled = recordingTitles.size > 1;

  return (
    <section aria-label="Rights">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Rights</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {rights.compositionId ? (
            <>
              <div className="flex flex-col gap-2">
                <h3 className="font-medium">Writers</h3>
                <ShareTable label="Writers" rows={writers} totalBp={rights.writerTotalBp} />
                {writerEditor}
              </div>
              {rights.publishing.map(({ territory, totalBp, holders }) => (
                <div key={territory} className="flex flex-col gap-2">
                  <h3 className="font-medium">{`Publishing ${territory}`}</h3>
                  <ShareTable
                    label={`Publishing ${territory}`}
                    rows={holderRows(holders, 'publishing', representable, agreements)}
                    totalBp={totalBp}
                  />
                </div>
              ))}
              {publishingEditor}
            </>
          ) : null}
          {rights.masters.map(({ recordingId, totalBp, holders }) => {
            const label = titled ? `Master ${recordingTitles.get(recordingId)}` : 'Master';
            return (
              <div key={recordingId} className="flex flex-col gap-2">
                <h3 className="font-medium">{label}</h3>
                <ShareTable
                  label={label}
                  rows={holderRows(holders, 'master', representable, agreements)}
                  totalBp={totalBp}
                />
                {masterEditors?.get(recordingId)}
              </div>
            );
          })}
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Licensing contacts</h3>
            {rights.licensingContacts.length === 0 ? (
              <p className="text-muted-foreground">None</p>
            ) : (
              <ul aria-label="Licensing contacts" className="flex flex-col gap-1">
                {rights.licensingContacts.map(({ partyId, displayName, implicit }) => (
                  <li key={partyId} className="flex items-center gap-2">
                    {displayName}
                    {/* The master self party stands in when no contact is set (P-28). */}
                    {implicit ? <Badge variant="outline">Implicit</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
            {contactsEditor}
          </div>
          {agreementForm}
          {rights.issues.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">Issues</h3>
              <ul aria-label="Issues" className="flex flex-col gap-2">
                {rights.issues.map((issue) => (
                  <IssueItem
                    key={`${issue.recordingId} ${issue.code}`}
                    issue={issue}
                    context={titled ? `${recordingTitles.get(issue.recordingId)}: ` : null}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
