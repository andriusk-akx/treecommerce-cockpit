import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import PilotNav from "./PilotNav";

export const dynamic = "force-dynamic";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ pilotId: string }>;
}

export default async function PilotLayout({ children, params }: LayoutProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, productType: true },
  });

  if (!pilot) return notFound();

  return (
    <div>
      <PilotNav pilotId={pilot.id} productType={pilot.productType} />
      {children}
    </div>
  );
}
