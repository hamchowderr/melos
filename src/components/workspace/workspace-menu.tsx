'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Phone width: the sidebar opens as a drawer from a menu button in the top bar. */
export function WorkspaceMenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger render={<Button variant="ghost" size="icon-sm" />}>
        <Menu />
        <span className="sr-only">Open menu</span>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/20" />
        <DialogPrimitive.Popup className="fixed inset-y-0 left-0 z-50 w-64 border-r bg-sidebar text-sidebar-foreground outline-none">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
