import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export type WorkspaceSection = 'chat' | 'catalog' | 'rights' | 'people' | 'settings';

const SECTIONS: { section: WorkspaceSection; href: string; label: string }[] = [
  { section: 'chat', href: '/', label: 'Chat' },
  { section: 'catalog', href: '/catalog', label: 'Catalog' },
  { section: 'rights', href: '/rights', label: 'Rights' },
  { section: 'people', href: '/people', label: 'People' },
  { section: 'settings', href: '/settings', label: 'Settings' },
];

/** The workspace's areas (§2.3), with the current page marked. */
export function WorkspaceNav({ current }: { current: WorkspaceSection }) {
  return (
    <nav aria-label="Workspace" className="flex flex-wrap items-center gap-1">
      {SECTIONS.map(({ section, href, label }) => (
        <Link
          key={section}
          href={href}
          aria-current={section === current ? 'page' : undefined}
          className={buttonVariants({
            variant: section === current ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
