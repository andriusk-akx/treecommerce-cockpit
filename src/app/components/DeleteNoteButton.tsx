"use client";

import { useState } from "react";

export default function DeleteNoteButton({ noteId }: { noteId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this note?")) return;
    setLoading(true);
    try {
      await fetch(`/api/notes?id=${noteId}`, { method: "DELETE" });
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50"
    >
      {loading ? "..." : "Delete"}
    </button>
  );
}
