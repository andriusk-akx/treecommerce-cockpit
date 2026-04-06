import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import NoteForm from "@/app/components/NoteForm";
import DeleteNoteButton from "@/app/components/DeleteNoteButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotNotesPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, name: true, clientId: true },
  });

  if (!pilot) return notFound();

  const [notes, stores, incidents] = await Promise.all([
    prisma.note.findMany({
      orderBy: { createdAt: "desc" },
      where: { pilotId },
      include: { store: true, incident: true },
    }),
    prisma.store.findMany({ where: { pilotId }, orderBy: { name: "asc" } }),
    prisma.incident.findMany({
      where: { pilotId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true, title: true },
    }),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Pastabos — {pilot.name}</h2>
        <NoteForm
          stores={stores.map((s) => ({ id: s.id, name: s.name }))}
          incidents={incidents.map((i) => ({ id: i.id, title: i.title }))}
        />
      </div>

      {notes.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400 mb-2">Pastabų dar nėra.</p>
          <p className="text-xs text-gray-300">Paspauskite &quot;+ Add Note&quot; norėdami pridėti.</p>
        </div>
      )}

      <div className="space-y-4">
        {notes.map((note) => (
          <div key={note.id} className="bg-white rounded-lg border border-gray-200 px-5 py-4">
            <div className="flex items-start justify-between">
              <h3 className="font-medium text-gray-900 mb-1">{note.title}</h3>
              <DeleteNoteButton noteId={note.id} />
            </div>
            <p className="text-sm text-gray-600 mb-3 whitespace-pre-wrap">{note.body}</p>
            <div className="flex flex-wrap gap-3 text-xs text-gray-400">
              <span>{note.createdAt.toLocaleDateString("lt-LT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              {note.store && <span className="bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{note.store.name}</span>}
              {note.incident && <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded">{note.incident.title}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
