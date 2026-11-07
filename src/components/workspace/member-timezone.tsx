'use client';

import { useEffect } from 'react';
import { recordTimezoneAction } from '@/app/member-timezone-action';

const KEY = 'melos-timezone-recorded';

/**
 * Sends the browser's timezone once per browser session; the server keeps the first one it gets for
 * the member, so "today" follows where they work (P-24). Renders nothing.
 */
export function MemberTimezone() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, '1');
    } catch {
      // Without storage the server still writes only once.
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    recordTimezoneAction(timezone).catch(() => undefined);
  }, []);
  return null;
}
