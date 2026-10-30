import { BookOpen, MessageSquare, Scale, Settings, Users } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export type WorkspaceSection = 'chat' | 'catalog' | 'rights' | 'people' | 'settings';

const SECTIONS = [
  { section: 'chat', href: '/', label: 'Chat', Icon: MessageSquare },
  { section: 'catalog', href: '/catalog', label: 'Catalog', Icon: BookOpen },
  { section: 'rights', href: '/rights', label: 'Rights', Icon: Scale },
  { section: 'people', href: '/people', label: 'People', Icon: Users },
  { section: 'settings', href: '/settings', label: 'Settings', Icon: Settings },
] as const;

/** The workspace's areas (§2.3) as a sidebar list, with the current page marked. */
export function WorkspaceNav({ current }: { current: WorkspaceSection }) {
  return (
    <nav aria-label="Workspace" className="flex flex-col gap-0.5">
      {SECTIONS.map(({ section, href, label, Icon }) => (
        <Link
          key={section}
          href={href}
          aria-current={section === current ? 'page' : undefined}
          className={cn(
            'flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            section === current && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
