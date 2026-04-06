import { prisma } from "@/lib/db";
import Link from "next/link";

interface Props {
  /** The pilot sub-page path segment, e.g. "sales", "uptime", "patterns" */
  subPage: string;
  /** Optional: filter to specific product type */
  productType?: "TREECOMMERCE" | "RETELLECT";
}

export default async function PilotRedirectBanner({ subPage, productType }: Props) {
  const where: Record<string, unknown> = { status: "ACTIVE" };
  if (productType) where.productType = productType;

  const pilots = await prisma.pilot.findMany({
    where,
    select: { id: true, name: true, shortCode: true, productType: true },
    orderBy: { name: "asc" },
  });

  if (pilots.length === 0) return null;

  return (
    <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-[11px] text-blue-700">
      <span className="font-semibold">Pilotų versija:</span>{" "}
      Šis puslapis dabar prieinamas per piloto kontekstą.{" "}
      {pilots.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ", "}
          <Link
            href={`/pilots/${p.id}/${subPage}`}
            className="underline font-medium hover:text-blue-900"
          >
            {p.name} ({p.shortCode})
          </Link>
        </span>
      ))}
    </div>
  );
}
