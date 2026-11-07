import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadFixtureFile, validateFixtures } from '@copilotkit/aimock';
import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { approvalRequestSchema } from '../../src/lib/agent/approval';
import { WORKSPACE_AGENT_TOOLS } from '../../src/mastra/agents/workspace-agent';

const rendered = vi.hoisted(() => [] as string[]);
vi.mock('@copilotkit/react-core/v2', () => ({
  useRenderTool: ({ name }: { name: string }) => rendered.push(name),
}));
vi.mock('../../src/components/chat/focus-context', () => ({ FocusOn: () => null }));

const { useMelosToolRenderers } = await import('../../src/components/chat/tool-renderers');

const ROOT = resolve(import.meta.dirname, '../..');
const AIMOCK = join(ROOT, 'fixtures', 'aimock');
const TOOLS = WORKSPACE_AGENT_TOOLS as Record<string, { inputSchema?: ZodType }>;
const TOOL_NAMES = Object.keys(TOOLS).sort();

const files = readdirSync(AIMOCK).filter((name) => name.endsWith('.json'));

/** A fixture tool call names a canonical tool and passes that tool's input schema. */
function expectCanonicalCall(where: string, name: string, args: unknown) {
  expect(TOOL_NAMES, `${where}: ${name} is not an agent tool`).toContain(name);
  const parsed = TOOLS[name].inputSchema?.safeParse(args);
  expect(parsed?.success, `${where}: ${name} arguments ${JSON.stringify(args)}`).not.toBe(false);
}

// TST-AI-004: AIMock fixtures are versioned under fixtures/aimock and call only canonical tools.
describe('AIMock fixtures (TST-AI-004)', () => {
  it('has fixture files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the AIMock fixture schema', (file) => {
    const fixtures = loadFixtureFile(join(AIMOCK, file));
    expect(fixtures.length, `${file} loaded no fixtures`).toBeGreaterThan(0);
    const errors = validateFixtures(fixtures).filter(({ severity }) => severity === 'error');
    expect(errors).toEqual([]);
  });

  it.each(files)('%s calls only canonical tools with valid arguments', (file) => {
    for (const [index, { response }] of loadFixtureFile(join(AIMOCK, file)).entries()) {
      const toolCalls = (response as { toolCalls?: { name: string; arguments: string }[] })
        .toolCalls;
      for (const { name, arguments: args } of toolCalls ?? []) {
        expectCanonicalCall(`${file} #${index}`, name, JSON.parse(args));
      }
    }
  });

  it('AGUIMock fixtures call only canonical tools with valid arguments', () => {
    for (const file of ['renderers.json', 'confirmation.json', 'reports.json']) {
      const { fixtures } = JSON.parse(
        readFileSync(join(ROOT, 'fixtures', 'agui', file), 'utf8'),
      ) as { fixtures: { message: string; toolName: string; args: unknown; request?: unknown }[] };
      for (const { message, toolName, args, request } of fixtures) {
        expectCanonicalCall(`agui "${message}"`, toolName, args);
        // A suspension's payload is the ApprovalRequest the ConfirmationCard parses (§3.4).
        if (request !== undefined)
          expect(approvalRequestSchema.parse(request).toolName).toBe(toolName);
      }
    }
  });
});

// Phase 6 gate: no structured result regresses to prose-only, so every tool has a renderer.
describe('chat renderers', () => {
  it('registers exactly one renderer for each agent tool', () => {
    rendered.length = 0;
    useMelosToolRenderers();
    expect([...rendered].sort()).toEqual(TOOL_NAMES);
  });
});
