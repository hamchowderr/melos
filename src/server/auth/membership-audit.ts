import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import type { Member, OrganizationOptions } from 'better-auth/plugins/organization';
import { ulid } from 'ulid';
import { controlDb } from '../db/client';
import { controlAuditLog } from '../db/schema/control';

type MembershipAuditAction =
  | 'member.invited'
  | 'member.added'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.left'
  | 'invitation.accepted'
  | 'invitation.rejected'
  | 'invitation.canceled';

type MembershipAuditEvent = {
  actorUserId: string | null;
  organizationId: string;
  action: MembershipAuditAction;
  targetType: 'invitation' | 'member';
  targetId: string;
  /** The target's role before and after the change; omitted where the target had none. */
  beforeRole?: string;
  afterRole?: string;
};

const roleJson = (role: string | undefined) =>
  role === undefined ? null : JSON.stringify({ role });

/** Appends one control_audit_log row (docs/CONTRACT.md §4.1, ADR-029). */
async function writeMembershipAudit(event: MembershipAuditEvent): Promise<void> {
  await controlDb.insert(controlAuditLog).values({
    id: `cad_${ulid()}`,
    actorUserId: event.actorUserId,
    organizationId: event.organizationId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    beforeJson: roleJson(event.beforeRole),
    afterJson: roleJson(event.afterRole),
    occurredAt: new Date().toISOString(),
  });
}

/** The signed-in user whose request made the change; null for a server call without a session. */
function requestActorId(): string | null {
  return tryGetCurrentAuthEndpointContext()?.context.session?.user.id ?? null;
}

/**
 * Better Auth 1.7.4 calls these after its own write returns and outside any transaction, so a
 * crash between the two loses the row; nothing is written for a refused or failed change (ADR-029).
 */
export const membershipAuditHooks: NonNullable<OrganizationOptions['organizationHooks']> = {
  afterCreateInvitation: ({ invitation, inviter, organization }) =>
    writeMembershipAudit({
      actorUserId: inviter.id,
      organizationId: organization.id,
      action: 'member.invited',
      targetType: 'invitation',
      targetId: invitation.id,
      afterRole: invitation.role,
    }),
  afterAcceptInvitation: ({ member, user, organization }) =>
    writeMembershipAudit({
      actorUserId: user.id,
      organizationId: organization.id,
      action: 'invitation.accepted',
      targetType: 'member',
      targetId: member.id,
      afterRole: member.role,
    }),
  afterRejectInvitation: ({ invitation, user, organization }) =>
    writeMembershipAudit({
      actorUserId: user.id,
      organizationId: organization.id,
      action: 'invitation.rejected',
      targetType: 'invitation',
      targetId: invitation.id,
      beforeRole: invitation.role,
    }),
  afterCancelInvitation: ({ invitation, cancelledBy, organization }) =>
    writeMembershipAudit({
      actorUserId: cancelledBy.id,
      organizationId: organization.id,
      action: 'invitation.canceled',
      targetType: 'invitation',
      targetId: invitation.id,
      beforeRole: invitation.role,
    }),
  // Also fires for the creator of a new organization; accepting an invitation does not fire it.
  afterAddMember: ({ member, organization }) =>
    writeMembershipAudit({
      actorUserId: requestActorId(),
      organizationId: organization.id,
      action: 'member.added',
      targetType: 'member',
      targetId: member.id,
      afterRole: member.role,
    }),
  afterUpdateMemberRole: ({ member, previousRole, organization }) =>
    writeMembershipAudit({
      actorUserId: requestActorId(),
      organizationId: organization.id,
      action: 'member.role_changed',
      targetType: 'member',
      targetId: member.id,
      beforeRole: previousRole,
      afterRole: member.role,
    }),
  afterRemoveMember: ({ member, organization }) =>
    writeMembershipAudit({
      actorUserId: requestActorId(),
      organizationId: organization.id,
      action: 'member.removed',
      targetType: 'member',
      targetId: member.id,
      beforeRole: member.role,
    }),
};

/** `/organization/leave` has no organization hook; this `hooks.after` handler audits it instead. */
export const membershipAuditAfterHook = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  if (ctx.path !== '/organization/leave' || !returned || isAPIError(returned)) return;
  const member = returned as Member;
  await writeMembershipAudit({
    actorUserId: member.userId,
    organizationId: member.organizationId,
    action: 'member.left',
    targetType: 'member',
    targetId: member.id,
    beforeRole: member.role,
  });
});
