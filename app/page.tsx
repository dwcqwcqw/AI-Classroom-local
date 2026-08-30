'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Page() {
  const router = useRouter();
  useEffect(() => router.replace('/workspace'), [router]);
  return (
    <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
      正在进入工作台…
    </div>
  );
}
