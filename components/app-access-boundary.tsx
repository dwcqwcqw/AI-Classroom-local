'use client';

import { usePathname } from 'next/navigation';
import { lazy, Suspense, type ReactNode } from 'react';

import { AccessCodeGuard } from '@/components/access-code-guard';
import { AuthGuard } from '@/components/auth-guard';

const ServerProvidersInit = lazy(() =>
  import('@/components/server-providers-init').then((module) => ({
    default: module.ServerProvidersInit,
  })),
);
const StorageHealthNotice = lazy(() =>
  import('@/components/storage-health-notice').then((module) => ({
    default: module.StorageHealthNotice,
  })),
);

function isPublicClassroomPath(pathname: string): boolean {
  return /^\/classroom\/[^/]+\/?$/.test(pathname);
}

/**
 * Keeps editing/generation behind the normal account boundary while allowing
 * unguessable classroom share links to render as a clean, anonymous viewer.
 */
export function AppAccessBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isPublicClassroomPath(pathname)) {
    return children;
  }

  return (
    <AccessCodeGuard>
      <AuthGuard>
        <Suspense fallback={null}>
          <ServerProvidersInit />
        </Suspense>
        {children}
        <Suspense fallback={null}>
          <StorageHealthNotice />
        </Suspense>
      </AuthGuard>
    </AccessCodeGuard>
  );
}
