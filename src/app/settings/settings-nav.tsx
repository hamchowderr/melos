import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

const PAGES = [
  { page: 'members', href: '/settings', label: 'Members' },
  { page: 'ownership', href: '/settings/ownership', label: 'Ownership' },
] as const;

/** The /settings pages (§2.3), with the current one marked. */
export function SettingsNav({ current }: { current: (typeof PAGES)[number]['page'] }) {
  return (
    <nav aria-label="Settings" className="flex w-full max-w-2xl gap-1">
      {PAGES.map(({ page, href, label }) => (
        <Link
          key={page}
          href={href}
          aria-current={page === current ? 'page' : undefined}
          className={buttonVariants({
            variant: page === current ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
