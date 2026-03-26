import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, body: noteBody, storeId, incidentId } = body;

    if (!title || !noteBody) {
      return NextResponse.json({ error: "Title and body are required" }, { status: 400 });
    }

    const client = await prisma.client.findFirst();
    if (!client) {
      return NextResponse.json({ error: "No client found" }, { status: 404 });
    }

    const note = await prisma.note.create({
      data: {
        clientId: client.id,
        title,
        body: noteBody,
        storeId: storeId || null,
        incidentId: incidentId || null,
      },
      include: { store: true, incident: true },
    });

    return NextResponse.json(note);
  } catch (error) {
    console.error("Create note error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Note ID is required" }, { status: 400 });
    }

    await prisma.note.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete note error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
