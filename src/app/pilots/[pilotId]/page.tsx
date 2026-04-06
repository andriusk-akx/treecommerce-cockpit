import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotIndexPage({ params }: PageProps) {
  const { pilotId } = await params;
  redirect(`/pilots/${pilotId}/overview`);
}
