import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="bg-white rounded-lg border border-gray-200 px-8 py-10 text-center max-w-md">
        <div className="text-4xl mb-4">🔍</div>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">
          Page not found
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          This page doesn&rsquo;t exist. Check the URL or return to the main page.
        </p>
        <Link
          href="/"
          className="px-4 py-2 text-sm font-medium bg-gray-800 text-white rounded hover:bg-gray-700 transition-colors"
        >
          Back to Overview
        </Link>
      </div>
    </div>
  );
}
