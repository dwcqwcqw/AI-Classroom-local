import { PublicClassroomClient } from './public-classroom-client';

// The public shell contains no viewer-specific data. Let Vercel cache it while
// the client fetches the independently cached classroom manifest.
export const dynamic = 'force-static';
export const revalidate = 86400;

export default async function ClassroomPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PublicClassroomClient classroomId={id} />;
}
