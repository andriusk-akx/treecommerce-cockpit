/**
 * Reusable role form — same shape for create and edit. Server actions are
 * passed in by the parent so we don't duplicate the create vs update fork.
 */
"use client";

import { ALL_TABS, TAB_LABELS, type TabKey } from "@/lib/auth/permissions";

export interface RoleFormProps {
  action: (formData: FormData) => Promise<void>;
  defaultName?: string;
  defaultDescription?: string;
  defaultTabs?: string[];
  isBuiltIn?: boolean;
  submitLabel: string;
}

export function RoleForm({
  action,
  defaultName = "",
  defaultDescription = "",
  defaultTabs = [],
  isBuiltIn = false,
  submitLabel,
}: RoleFormProps) {
  const granted = new Set<TabKey>(
    defaultTabs.filter((t): t is TabKey => (ALL_TABS as readonly string[]).includes(t)),
  );
  return (
    <form action={action} className="space-y-4 bg-white border border-gray-200 rounded-lg p-5">
      <div>
        <label className="text-xs font-medium text-gray-700 block mb-1">Name</label>
        <input
          name="name"
          required
          minLength={2}
          defaultValue={defaultName}
          disabled={isBuiltIn}
          className="w-full text-sm border border-gray-200 rounded px-3 py-2 disabled:bg-gray-50 disabled:text-gray-500"
        />
        {isBuiltIn && (
          <p className="text-[10px] text-gray-500 mt-1">Built-in role — name cannot be changed.</p>
        )}
      </div>
      <div>
        <label className="text-xs font-medium text-gray-700 block mb-1">Description</label>
        <input
          name="description"
          defaultValue={defaultDescription}
          className="w-full text-sm border border-gray-200 rounded px-3 py-2"
        />
      </div>
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Default allowed tabs</div>
        <div className="flex flex-wrap gap-2">
          {ALL_TABS.map((tab) => (
            <label
              key={tab}
              className="flex items-center gap-1.5 text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded border border-gray-200 cursor-pointer hover:border-gray-400"
            >
              <input
                type="checkbox"
                name="tabs"
                value={tab}
                defaultChecked={granted.has(tab)}
              />
              {TAB_LABELS[tab]}
            </label>
          ))}
        </div>
      </div>
      <button
        type="submit"
        className="bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded hover:bg-gray-800"
      >
        {submitLabel}
      </button>
    </form>
  );
}
