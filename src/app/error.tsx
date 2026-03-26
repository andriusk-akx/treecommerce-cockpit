"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log error server-side only — never expose to user
  console.error("[TreeCommerce Error]", error.message);

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="bg-white rounded-lg border border-gray-200 px-8 py-10 text-center max-w-md">
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">
          Kažkas nutiko
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          Nepavyko užkrauti puslapio. Bandykite dar kartą arba grįžkite į pagrindinį puslapį.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => reset()}
            className="px-4 py-2 text-sm font-medium bg-gray-800 text-white rounded hover:bg-gray-700 transition-colors"
          >
            Bandyti dar kartą
          </button>
          <a
            href="/"
            className="px-4 py-2 text-sm font-medium bg-white text-gray-600 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          >
            Grįžti
          </a>
        </div>
        {error.digest && (
          <p className="text-[10px] text-gray-300 mt-4">
            Ref: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
